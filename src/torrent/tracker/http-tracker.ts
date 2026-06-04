import { log } from "../metadata.ts";
import { decode } from "../parser.ts";
import { getPeerId } from "../peer/peer-id.ts";
import type {
	PeerInfo,
	TrackerAnnounceRequest,
	TrackerAnnounceTarget,
	TrackerResponse,
} from "../types.ts";

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
			byte === 0x7e // ~
		) {
			result += String.fromCharCode(byte);
		} else {
			result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return result;
}

export function parseHTTPDictionaryPeers(
	list: import("../parser.ts").BencodeValue[],
): PeerInfo[] {
	const peers: PeerInfo[] = [];
	for (const entry of list) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry) ||
			entry instanceof Uint8Array
		)
			continue;
		const ipRaw = entry.ip;
		const port = entry.port;
		if (typeof port !== "number") continue;
		const ip =
			ipRaw instanceof Uint8Array
				? TEXT_DECODER.decode(ipRaw)
				: typeof ipRaw === "string"
					? ipRaw
					: null;
		if (ip) peers.push({ ip, port });
	}
	return peers;
}

export function parseHTTPCompactPeers(data: Uint8Array): PeerInfo[] {
	const peers: PeerInfo[] = [];
	if (data.length % 6 !== 0) return peers;
	for (let i = 0; i < data.length; i += 6) {
		const ip = `${data[i]}.${data[i + 1]}.${data[i + 2]}.${data[i + 3]}`;
		const port = ((data[i + 4] ?? 0) << 8) | (data[i + 5] ?? 0);
		peers.push({ ip, port });
	}
	return peers;
}

export function parseHTTPTrackerResponse(buffer: Uint8Array): TrackerResponse {
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
		const reason = decoded["failure reason"];
		const message =
			reason instanceof Uint8Array
				? TEXT_DECODER.decode(reason)
				: typeof reason === "string"
					? reason
					: "unknown failure";
		throw new Error(`Tracker failure: ${message}`);
	}

	const peersRaw = decoded.peers;
	const interval =
		typeof decoded.interval === "number" ? decoded.interval : 1800;
	const complete = typeof decoded.complete === "number" ? decoded.complete : 0;
	const incomplete =
		typeof decoded.incomplete === "number" ? decoded.incomplete : 0;

	// Compact format: binary blob, 6 bytes per IPv4 peer
	if (peersRaw instanceof Uint8Array) {
		return {
			complete,
			incomplete,
			interval,
			peers: parseHTTPCompactPeers(peersRaw),
		};
	}

	// Dictionary format: list of {ip, port, peer id} dicts (used for IPv6 or non-compact)
	if (Array.isArray(peersRaw)) {
		return {
			complete,
			incomplete,
			interval,
			peers: parseHTTPDictionaryPeers(peersRaw),
		};
	}

	return { complete, incomplete, interval, peers: [] };
}

export function buildHTTPTrackerUrl(
	url: string,
	metadata: TrackerAnnounceTarget,
	request: TrackerAnnounceRequest,
): string {
	const peerId = request.peerId ?? getPeerId();
	const params = [
		`info_hash=${encodeBytes(metadata.infoHash)}`,
		`peer_id=${encodeBytes(peerId)}`,
		`port=${request.port}`,
		`uploaded=${request.uploaded}`,
		`downloaded=${request.downloaded}`,
		`left=${request.left}`,
		`compact=1`,
		`numwant=${request.numwant}`,
	];
	if (request.event) params.push(`event=${request.event}`);
	const query = params.join("&");
	return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

export async function announceHTTPTracker(
	url: string,
	metadata: TrackerAnnounceTarget,
	request: TrackerAnnounceRequest,
): Promise<TrackerResponse> {
	const fullUrl = buildHTTPTrackerUrl(url, metadata, request);

	// AbortSignal.timeout doesn't abort TCP-level hangs in Bun — use Promise.race
	const res = await Promise.race([
		fetch(fullUrl, { headers: { "User-Agent": "torrent-tui/0.1" } }),
		new Promise<never>((_, rej) =>
			setTimeout(() => rej(new Error("The operation timed out.")), 10_000),
		),
	]);

	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	const buffer = new Uint8Array(await res.arrayBuffer());
	return parseHTTPTrackerResponse(buffer);
}

export async function announceHTTP(
	metadata: TrackerAnnounceTarget,
	request: TrackerAnnounceRequest,
): Promise<TrackerResponse[]> {
	const urls = [
		...new Set(
			metadata.announceList
				.flat()
				.filter((u) => u.startsWith("http://") || u.startsWith("https://")),
		),
	];

	const results = await Promise.allSettled(
		urls.map((u) => announceHTTPTracker(u, metadata, request)),
	);

	const responses: TrackerResponse[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const url = urls[i];
		if (r === undefined || url === undefined) continue;
		if (r.status === "fulfilled") {
			responses.push(r.value);
			log("tracker", `${url}   ${r.value.peers.length} peers`);
		} else {
			const reason =
				r.reason instanceof Error ? r.reason.message : String(r.reason);
			log("tracker", `${url}   failed  ${reason}`);
		}
	}
	return responses;
}
