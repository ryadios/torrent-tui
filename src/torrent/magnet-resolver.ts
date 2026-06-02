import { EventEmitter } from "node:events";
import { type MagnetInfo, parseMagnetUri } from "./magnet.ts";
import {
	buildTorrentFileFromInfo,
	MetadataPieceAssembler,
	metadataCachePath,
	readCachedMetadata,
	verifyInfoBytes,
	writeCachedMetadata,
} from "./metadata-cache.ts";
import { PeerConnection } from "./peer/connection.ts";
import {
	METADATA_BLOCK_SIZE,
	type UtMetadataMessage,
} from "./peer/extension.ts";
import { announce } from "./tracker/announce.ts";
import type { PeerInfo, TrackerAnnounceTarget } from "./types.ts";

const METADATA_TIMEOUT_MS = 60_000;

export interface MagnetResolveProgress {
	status: "metadata" | "stalled";
	peers: number;
}

export interface ResolveMagnetOptions {
	onProgress?: (progress: MagnetResolveProgress) => void;
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

	const peers = await discoverMagnetPeers(magnet);
	options.onProgress?.({
		status: peers.length > 0 ? "metadata" : "stalled",
		peers: peers.length,
	});
	if (peers.length === 0) {
		throw new Error(
			"No peers found for magnet metadata; DHT support is planned for phase 13",
		);
	}

	const infoBytes = await fetchMetadataFromPeers(magnet, peers, options);
	verifyInfoBytes(infoBytes, magnet.infoHash);
	const rawTorrent = buildTorrentFileFromInfo({
		infoBytes,
		announceList: magnet.trackers,
	});
	const torrentPath = writeCachedMetadata(magnet.infoHashHex, rawTorrent);
	return { magnet, torrentPath, fromCache: false };
}

async function discoverMagnetPeers(magnet: MagnetInfo): Promise<PeerInfo[]> {
	const target: TrackerAnnounceTarget = {
		infoHash: magnet.infoHash,
		totalSize: 0,
		announceList: magnet.trackers.map((tracker) => [tracker]),
	};
	const trackerPeers =
		magnet.trackers.length > 0
			? (await announce(target, { left: 0 }).catch(() => ({ peers: [] }))).peers
			: [];
	const seen = new Set<string>();
	const peers: PeerInfo[] = [];
	for (const peer of [...magnet.peers, ...trackerPeers]) {
		const key = `${peer.ip}:${peer.port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		peers.push(peer);
	}
	return peers;
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
			if (!conn.peerExtensions.has("ut_metadata") || !metadataSize) {
				finish(new Error("peer does not advertise ut_metadata"));
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
