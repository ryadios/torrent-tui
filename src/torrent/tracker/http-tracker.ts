import { decode } from "../parser.ts";
import { log } from "../metadata.ts";
import { getPeerId } from "../peer/peer-id.ts";
import type { TorrentMetadata } from "../metadata.ts";
import type { PeerInfo, TrackerResponse } from "../types.ts";

const TEXT_DECODER = new TextDecoder();

function encodeBytes(buf: Uint8Array): string {
	let result = "";
	for (const byte of buf) {
		result += `%${byte.toString(16).padStart(2, "0")}`;
	}
	return result;
}

function parseCompactPeers(data: Uint8Array): PeerInfo[] {
	const peers: PeerInfo[] = [];
	if (data.length % 6 !== 0) return peers;
	for (let i = 0; i < data.length; i += 6) {
		const ip = `${data[i]}.${data[i + 1]}.${data[i + 2]}.${data[i + 3]}`;
		const port = ((data[i + 4] ?? 0) << 8) | (data[i + 5] ?? 0);
		peers.push({ ip, port });
	}
	return peers;
}

async function announceToTracker(
	url: string,
	metadata: TorrentMetadata,
	peerId: Uint8Array,
	port: number,
	numwant: number,
): Promise<PeerInfo[]> {
	const params = [
		`info_hash=${encodeBytes(metadata.infoHash)}`,
		`peer_id=${encodeBytes(peerId)}`,
		`port=${port}`,
		`uploaded=0`,
		`downloaded=0`,
		`left=${metadata.totalSize}`,
		`compact=1`,
		`event=started`,
		`numwant=${numwant}`,
	].join("&");

	const fullUrl = url.includes("?") ? `${url}&${params}` : `${url}?${params}`;

	const res = await fetch(fullUrl, {
		headers: { "User-Agent": "torrent-tui/0.1" },
		signal: AbortSignal.timeout(10_000),
	});

	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	const buffer = new Uint8Array(await res.arrayBuffer());
	const decoded = decode(buffer);

	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Invalid tracker response");
	}

	if ("failure reason" in decoded) {
		throw new Error(`Tracker failure: ${TEXT_DECODER.decode(decoded["failure reason"] as Uint8Array)}`);
	}

	const peersRaw = decoded["peers"];
	if (!(peersRaw instanceof Uint8Array)) return [];
	return parseCompactPeers(peersRaw);
}

export async function announce(
	metadata: TorrentMetadata,
	port = 6881,
	numwant = 50,
): Promise<TrackerResponse> {
	const peerId = getPeerId();
	const httpTrackers = metadata.announceList
		.flat()
		.filter((u) => u.startsWith("http://") || u.startsWith("https://"));

	const uniqueTrackers = [...new Set(httpTrackers)];
	const results = await Promise.allSettled(
		uniqueTrackers.map((url) =>
			announceToTracker(url, metadata, peerId, port, numwant),
		),
	);

	const seen = new Set<string>();
	const peers: PeerInfo[] = [];
	let successCount = 0;

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const url = uniqueTrackers[i];
		if (result === undefined || url === undefined) continue;
		if (result.status === "fulfilled") {
			successCount++;
			for (const peer of result.value) {
				const key = `${peer.ip}:${peer.port}`;
				if (!seen.has(key)) {
					seen.add(key);
					peers.push(peer);
				}
			}
		} else {
			log("tracker", `${url}   failed  ${result.reason}`);
		}
	}

	log("tracker", `${successCount} / ${uniqueTrackers.length} HTTP trackers responded   ${peers.length} unique peers`);

	return { complete: 0, incomplete: 0, interval: 1800, peers };
}
