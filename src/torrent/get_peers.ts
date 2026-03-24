import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { SHA1 } from "bun";
import { decode, encode } from "./parser";

type TorrentFile = {
	announce: string;
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

export async function getPeers(filePath: string, port = 6881, numwant = 50) {
	const fileContent = readFileSync(filePath);
	const decoded = decode(fileContent);

	// 1. Validate top-level structure
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

	// 2. Cast after validation
	const torrent = decoded as TorrentFile;

	const { announce, info } = torrent;

	// (optional but good) validate announce type
	if (typeof announce !== "string") {
		throw new Error("Invalid announce URL");
	}

	// 3. Compute info hash
	const infoEncoded = encode(info); // still BencodeValue underneath
	const infoHash = SHA1.hash(infoEncoded);

	// 4. Compute left (just-in-time validation)
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

	console.log({ announce, infoHash, left });

	const peerIdPrefix = "-UT2210-";
	const randomPart = randomBytes(20 - peerIdPrefix.length);

	const peerId = Buffer.concat([Buffer.from(peerIdPrefix), randomPart]);

	const params = {
		info_hash: infoHash,
		peer_id: peerId,
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
		if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
			queryParts.push(`${key}=${encodeBytes(val)}`);
		} else {
			queryParts.push(`${key}=${encodeURIComponent(String(val))}`);
		}
	}

	const queryString = queryParts.join("&");
	const url = announce.includes("?")
		? `${announce}&${queryString}`
		: `${announce}?${queryString}`;

	console.log(url);

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
	)
		throw new Error("Invalid tracker response");

	if ("failure reason" in trackerDecoded)
		throw new Error(`Tracker failure: ${trackerDecoded["failure reason"]}`);

	if (!("peers" in trackerDecoded)) throw new Error("No peers in response");

	const peersData = trackerDecoded.peers;
	console.log(peersData);
}
