import type { PeerInfo } from "./types.ts";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface MagnetInfo {
	infoHash: Uint8Array;
	infoHashHex: string;
	displayName: string | null;
	trackers: string[];
	peers: PeerInfo[];
}

export function isMagnetUri(value: string): boolean {
	return value.trim().toLowerCase().startsWith("magnet:?");
}

export function parseMagnetUri(uri: string): MagnetInfo {
	const trimmed = uri.trim();
	if (!isMagnetUri(trimmed))
		throw new Error("Magnet URI must start with magnet:?");
	const query = trimmed.slice(trimmed.indexOf("?") + 1);
	const params = new URLSearchParams(query);
	const xtValues = params.getAll("xt");
	const btih = xtValues
		.map((value) => parseExactTopic(value))
		.find((value): value is string => value !== null);
	if (!btih) {
		const hasBtmh = xtValues.some((value) =>
			value.toLowerCase().startsWith("urn:btmh:"),
		);
		throw new Error(
			hasBtmh
				? "Only BitTorrent v1 btih magnets are supported"
				: "Magnet URI is missing xt=urn:btih",
		);
	}

	const infoHash = decodeBtih(btih);
	const trackers = unique(params.getAll("tr").filter((url) => url.length > 0));
	const peers = unique(params.getAll("x.pe"))
		.map(parsePeerAddress)
		.filter((peer): peer is PeerInfo => peer !== null);
	const displayName = params.get("dn");

	return {
		infoHash,
		infoHashHex: Buffer.from(infoHash).toString("hex"),
		displayName: displayName && displayName.length > 0 ? displayName : null,
		trackers,
		peers,
	};
}

function parseExactTopic(value: string): string | null {
	const prefix = "urn:btih:";
	return value.toLowerCase().startsWith(prefix)
		? value.slice(prefix.length)
		: null;
}

function decodeBtih(value: string): Uint8Array {
	if (/^[a-fA-F0-9]{40}$/.test(value)) {
		return new Uint8Array(Buffer.from(value, "hex"));
	}
	if (/^[A-Z2-7a-z]{32}$/.test(value)) {
		return decodeBase32(value);
	}
	throw new Error(
		"btih must be a 40-character hex or 32-character base32 hash",
	);
}

function decodeBase32(value: string): Uint8Array {
	let bits = 0;
	let bitCount = 0;
	const bytes: number[] = [];
	for (const char of value.toUpperCase()) {
		const idx = BASE32_ALPHABET.indexOf(char);
		if (idx < 0) throw new Error("Invalid base32 btih hash");
		bits = (bits << 5) | idx;
		bitCount += 5;
		while (bitCount >= 8) {
			bytes.push((bits >>> (bitCount - 8)) & 0xff);
			bitCount -= 8;
		}
	}
	if (bytes.length !== 20)
		throw new Error("btih base32 hash must decode to 20 bytes");
	return new Uint8Array(bytes);
}

function parsePeerAddress(value: string): PeerInfo | null {
	const idx = value.lastIndexOf(":");
	if (idx <= 0 || idx === value.length - 1) return null;
	const ip = value.slice(0, idx);
	const port = Number(value.slice(idx + 1));
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return { ip, port };
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}
