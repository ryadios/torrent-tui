import { EventEmitter } from "node:events";
import { DhtClient } from "./dht/node.ts";
import { type MagnetInfo, parseMagnetUri } from "./magnet.ts";
import { TorrentMetadata } from "./metadata.ts";
import {
	buildTorrentFileFromInfo,
	MetadataPieceAssembler,
	metadataCachePath,
	readCachedMetadata,
	verifyInfoBytes,
	writeCachedMetadata,
} from "./metadata-cache.ts";
import { type BencodeValue, decode } from "./parser.ts";
import { PeerConnection } from "./peer/connection.ts";
import {
	METADATA_BLOCK_SIZE,
	type UtMetadataMessage,
} from "./peer/extension.ts";
import { announce } from "./tracker/announce.ts";
import type { PeerInfo, TrackerAnnounceTarget } from "./types.ts";

const METADATA_TIMEOUT_MS = 60_000;
const MAX_METADATA_SIZE = 64 * 1024 * 1024;

export interface MagnetResolveProgress {
	status: "metadata" | "stalled";
	peers: number;
}

export interface ResolveMagnetOptions {
	onProgress?: (progress: MagnetResolveProgress) => void;
	dht?: DhtClient | null;
}

export interface ResolveMagnetResult {
	magnet: MagnetInfo;
	torrentPath: string;
	fromCache: boolean;
}

export async function resolveMagnetToTorrent(
	uri: string,
	options: ResolveMagnetOptions = {},
): Promise<ResolveMagnetResult> {
	const magnet = parseMagnetUri(uri);
	if (readCachedMetadata(magnet.infoHashHex)) {
		return {
			magnet,
			torrentPath: metadataCachePath(magnet.infoHashHex),
			fromCache: true,
		};
	}

	const peers = await discoverMagnetPeers(magnet, options.dht);
	options.onProgress?.({
		status: peers.length > 0 ? "metadata" : "stalled",
		peers: peers.length,
	});
	if (peers.length === 0) {
		throw new Error("No peers found for magnet metadata");
	}

	const infoBytes = await fetchMetadataFromPeers(magnet, peers, options);
	verifyInfoBytes(infoBytes, magnet.infoHash);
	const rawTorrent = buildTorrentFileFromInfo({
		infoBytes,
		announceList: magnet.trackers,
	});
	await announceResolvedMagnet(magnet, rawTorrent);
	const torrentPath = writeCachedMetadata(magnet.infoHashHex, rawTorrent);
	return { magnet, torrentPath, fromCache: false };
}

async function discoverMagnetPeers(
	magnet: MagnetInfo,
	dhtOverride?: DhtClient | null,
): Promise<PeerInfo[]> {
	const target: TrackerAnnounceTarget = {
		infoHash: magnet.infoHash,
		totalSize: 0,
		announceList: magnet.trackers.map((tracker) => [tracker]),
	};
	const trackerPeers =
		magnet.trackers.length > 0
			? (
					await announce(target, { left: 1, event: "started" }).catch(() => ({
						peers: [],
					}))
				).peers
			: [];
	const ownsDht = dhtOverride === undefined;
	const dht = ownsDht ? new DhtClient() : dhtOverride;
	const dhtPeers =
		dht && (magnet.trackers.length === 0 || trackerPeers.length === 0)
			? await discoverMagnetPeersFromDht(dht, magnet.infoHash)
			: [];
	if (ownsDht) dht?.close();
	const seen = new Set<string>();
	const peers: PeerInfo[] = [];
	for (const peer of [...magnet.peers, ...trackerPeers, ...dhtPeers]) {
		const key = `${peer.ip}:${peer.port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		peers.push(peer);
	}
	return peers;
}

async function discoverMagnetPeersFromDht(
	dht: DhtClient,
	infoHash: Uint8Array,
): Promise<PeerInfo[]> {
	try {
		await dht.start();
		return await dht.getPeers(infoHash);
	} catch {
		return [];
	}
}

async function announceResolvedMagnet(
	magnet: MagnetInfo,
	rawTorrent: Uint8Array,
): Promise<void> {
	if (magnet.trackers.length === 0) return;
	const decoded = decode(rawTorrent);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		return;
	}
	const metadata = new TorrentMetadata(
		decoded as { [key: string]: BencodeValue },
		rawTorrent,
	);
	const target: TrackerAnnounceTarget = {
		infoHash: magnet.infoHash,
		totalSize: metadata.totalSize,
		announceList: magnet.trackers.map((tracker) => [tracker]),
	};
	await announce(target, { left: metadata.totalSize }).catch(() => undefined);
}

async function fetchMetadataFromPeers(
	magnet: MagnetInfo,
	peers: PeerInfo[],
	options: ResolveMagnetOptions,
): Promise<Uint8Array> {
	const errors: string[] = [];
	const deadline = Date.now() + METADATA_TIMEOUT_MS;
	for (const peer of peers) {
		const remaining = Math.max(1_000, deadline - Date.now());
		try {
			return await fetchMetadataFromPeer(magnet, peer, remaining, options);
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
		if (Date.now() >= deadline) break;
	}
	throw new Error(
		`Failed to fetch magnet metadata${errors[0] ? `: ${errors[0]}` : ""}`,
	);
}

function fetchMetadataFromPeer(
	magnet: MagnetInfo,
	peer: PeerInfo,
	timeoutMs: number,
	options: ResolveMagnetOptions,
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const conn = new PeerConnection(peer.ip, peer.port, magnet.infoHash);
		let assembler: MetadataPieceAssembler | null = null;
		let settled = false;
		const timer = setTimeout(() => {
			finish(new Error("metadata fetch timeout"));
		}, timeoutMs);

		const finish = (err: Error | null, value?: Uint8Array) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.destroy();
			if (err) reject(err);
			else resolve(value ?? new Uint8Array(0));
		};

		conn.on("extensionHandshake", () => {
			const metadataSize = conn.peerMetadataSize;
			if (!conn.peerExtensions.has("ut_metadata")) {
				finish(new Error("peer does not advertise ut_metadata"));
				return;
			}
			if (
				!Number.isInteger(metadataSize) ||
				metadataSize === null ||
				metadataSize <= 0 ||
				metadataSize > MAX_METADATA_SIZE
			) {
				finish(new Error("peer advertised invalid metadata size"));
				return;
			}
			assembler = new MetadataPieceAssembler(metadataSize, METADATA_BLOCK_SIZE);
			options.onProgress?.({ status: "metadata", peers: 1 });
			for (const piece of assembler.missingPieces()) {
				conn.requestMetadataPiece(piece);
			}
		});

		conn.on("utMetadata", (message: UtMetadataMessage) => {
			if (!assembler) return;
			if (message.msgType === 2) {
				finish(new Error(`peer rejected metadata piece ${message.piece}`));
				return;
			}
			if (message.msgType !== 1) return;
			try {
				assembler.addPiece(message.piece, message.data, message.totalSize);
				if (assembler.complete) finish(null, assembler.assemble());
			} catch (err) {
				finish(err instanceof Error ? err : new Error(String(err)));
			}
		});

		conn.once("disconnect", () => {
			finish(new Error("peer disconnected before metadata completed"));
		});

		void conn.connect().catch((err: unknown) => {
			finish(err instanceof Error ? err : new Error(String(err)));
		});
	});
}

export class MagnetResolver extends EventEmitter {
	resolve(
		uri: string,
		options: ResolveMagnetOptions = {},
	): Promise<ResolveMagnetResult> {
		return resolveMagnetToTorrent(uri, options);
	}
}
