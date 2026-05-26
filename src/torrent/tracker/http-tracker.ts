import { decode } from "../parser.ts";
import { log } from "../metadata.ts";
import { getPeerId } from "../peer/peer-id.ts";
import type { TorrentMetadata } from "../metadata.ts";
import type { PeerInfo, TrackerResponse } from "../types.ts";

const TEXT_DECODER = new TextDecoder();

// RFC 3986: unreserved characters must NOT be percent-encoded.
// Encoding them anyway causes tracker hash mismatches (Ubuntu's tracker enforces this).
function encodeBytes(buf: Uint8Array): string {
	let result = "";
	for (const byte of buf) {
		if (
			(byte >= 0x30 && byte <= 0x39) || // 0-9
			(byte >= 0x41 && byte <= 0x5a) || // A-Z
			(byte >= 0x61 && byte <= 0x7a) || // a-z
			byte === 0x2d || // -
			byte === 0x5f || // _
			byte === 0x2e || // .
			byte === 0x7e    // ~
		) {
			result += String.fromCharCode(byte);
		} else {
			result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return result;
}

function parseDictPeers(list: import("../parser.ts").BencodeValue[]): PeerInfo[] {
	const peers: PeerInfo[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry) || entry instanceof Uint8Array) continue;
		const ipRaw = entry["ip"];
		const port = entry["port"];
		if (typeof port !== "number") continue;
		const ip = ipRaw instanceof Uint8Array ? TEXT_DECODER.decode(ipRaw) : typeof ipRaw === "string" ? ipRaw : null;
		if (ip) peers.push({ ip, port });
	}
	return peers;
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

	// Compact format: binary blob, 6 bytes per IPv4 peer
	if (peersRaw instanceof Uint8Array) {
		return parseCompactPeers(peersRaw);
	}

	// Dictionary format: list of {ip, port, peer id} dicts (used for IPv6 or non-compact)
	if (Array.isArray(peersRaw)) {
		return parseDictPeers(peersRaw);
	}

	return [];
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
