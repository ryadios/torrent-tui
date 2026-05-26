import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { SHA1 } from "bun";
import { decode, encode } from "./parser";

const TEXT_DECODER = new TextDecoder();

export interface PeerInfo {
	ip: string;
	port: number;
}

export interface TrackerResponse {
	complete: number;
	incomplete: number;
	interval: number;
	peers: PeerInfo[];
}

type TorrentFile = {
	announce: Uint8Array;
	info: {
		length?: number;
		files?: Array<{
			length: number;
		}>;
	};
};

function encodeBytes(buf: Uint8Array): string {
	let result = "";
	for (const byte of buf) {
		result += `%${byte.toString(16).padStart(2, "0")}`;
	}
	return result;
}

function parseCompactPeers(data: Uint8Array): PeerInfo[] {
	const peers: PeerInfo[] = [];
	const peerSize = 6;

	if (data.length % peerSize !== 0) {
		throw new Error(
			`Invalid compact peer data: length ${data.length} is not a multiple of 6`,
		);
	}

	for (let i = 0; i < data.length; i += peerSize) {
		const first = data[i];
		const second = data[i + 1];
		const third = data[i + 2];
		const fourth = data[i + 3];
		const portHigh = data[i + 4];
		const portLow = data[i + 5];

		if (
			first === undefined ||
			second === undefined ||
			third === undefined ||
			fourth === undefined ||
			portHigh === undefined ||
			portLow === undefined
		) {
			throw new Error("Invalid compact peer data: truncated peer entry");
		}

		const ip = `${first}.${second}.${third}.${fourth}`;
		const port = (portHigh << 8) | portLow;
		peers.push({ ip, port });
	}

	return peers;
}

export async function getPeers(
	filePath: string,
	port = 6881,
	numwant = 50,
): Promise<TrackerResponse> {
	const fileContent = readFileSync(filePath);
	const decoded = decode(fileContent);

	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded)
	) {
		throw new Error("Invalid torrent file");
	}

	if (!("announce" in decoded) || !("info" in decoded)) {
		throw new Error("Missing announce or info");
	}

	const torrent = decoded as TorrentFile;
	const { announce, info } = torrent;

	const announceUrl = TEXT_DECODER.decode(announce);

	if (announceUrl.startsWith("udp://")) {
		throw new Error(`UDP tracker not supported yet: ${announceUrl}`);
	}

	const infoEncoded = encode(info);
	const infoHashBytes = Uint8Array.from(SHA1.hash(infoEncoded) as Uint8Array);

	let left: number;

	if (typeof info.length === "number") {
		left = info.length;
	} else if (Array.isArray(info.files)) {
		left = 0;

		for (const file of info.files) {
			if (typeof file !== "object" || file === null) {
				throw new Error("Invalid file entry");
			}
			if (typeof file.length !== "number") {
				throw new Error("Invalid file length");
			}
			left += file.length;
		}
	} else {
		throw new Error("Invalid info: missing length/files");
	}

	const peerIdPrefix = "-UT2210-";
	const randomPart = randomBytes(20 - peerIdPrefix.length);
	const peerId = Buffer.concat([Buffer.from(peerIdPrefix), randomPart]);

	const params = {
		info_hash: encodeBytes(infoHashBytes),
		peer_id: encodeBytes(peerId),
		port: port,
		uploaded: 0,
		downloaded: 0,
		left: left,
		compact: 1,
		event: "started",
		numwant: numwant,
	};

	const queryParts: string[] = [];

	for (const [key, val] of Object.entries(params)) {
		queryParts.push(`${key}=${val}`);
	}

	const queryString = queryParts.join("&");
	const url = announceUrl.includes("?")
		? `${announceUrl}&${queryString}`
		: `${announceUrl}?${queryString}`;

	console.log(`Tracker URL: ${url}`);

	const res = await fetch(url, {
		headers: {
			"User-Agent": "Python-BitTorrent-Client/1.0",
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Tracker error: ${res.status} - ${text}`);
	}

	const buffer = new Uint8Array(await res.arrayBuffer());
	const trackerDecoded = decode(buffer);

	if (
		typeof trackerDecoded !== "object" ||
		trackerDecoded === null ||
		Array.isArray(trackerDecoded)
	) {
		throw new Error("Invalid tracker response");
	}

	if ("failure reason" in trackerDecoded) {
		throw new Error(`Tracker failure: ${trackerDecoded["failure reason"]}`);
	}

	if (!("peers" in trackerDecoded)) {
		throw new Error("No peers in response");
	}

	const peersRaw = trackerDecoded.peers;
	if (!(peersRaw instanceof Uint8Array)) {
		throw new Error(
			"Expected compact peer data (Uint8Array), got non-binary response",
		);
	}

	const peers = parseCompactPeers(peersRaw);

	const interval =
		typeof trackerDecoded.interval === "number"
			? trackerDecoded.interval
			: 1800;
	const complete =
		typeof trackerDecoded.complete === "number" ? trackerDecoded.complete : 0;
	const incomplete =
		typeof trackerDecoded.incomplete === "number"
			? trackerDecoded.incomplete
			: 0;

	console.log(`Found ${peers.length} peers:`);
	for (const peer of peers) {
		console.log(`  ${peer.ip}:${peer.port}`);
	}

	return { complete, incomplete, interval, peers };
}
