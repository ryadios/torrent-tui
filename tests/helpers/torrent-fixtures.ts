import { TorrentMetadata } from "../../src/torrent/metadata.ts";
import type { BencodeValue } from "../../src/torrent/parser.ts";
import { decode, encode } from "../../src/torrent/parser.ts";
import { bytes, concatBytes, pieceHashBytes } from "./bytes.ts";

export interface TorrentFixture {
	raw: Uint8Array;
	metadata: TorrentMetadata;
	content: Uint8Array;
	info: { [key: string]: BencodeValue };
}

export function metadataFromRaw(raw: Uint8Array): TorrentMetadata {
	const decoded = decode(raw);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Fixture did not decode to a torrent dictionary");
	}
	return new TorrentMetadata(decoded as { [key: string]: BencodeValue }, raw);
}

export function singleFileTorrentFixture(
	options: {
		name?: string;
		content?: Uint8Array;
		pieceLength?: number;
		announce?: string;
		announceList?: string[][];
		nodes?: Array<[string, number]>;
		private?: boolean;
		webSeeds?: string[];
	} = {},
): TorrentFixture {
	const name = options.name ?? "sample.bin";
	const content = options.content ?? bytes("abcdefghijkl");
	const pieceLength = options.pieceLength ?? 4;
	const info: { [key: string]: BencodeValue } = {
		length: content.length,
		name,
		"piece length": pieceLength,
		pieces: pieceHashBytes(content, pieceLength),
	};
	const torrent = buildTorrentDictionary(info, options);
	const raw = encode(torrent);
	return { raw, metadata: metadataFromRaw(raw), content, info };
}

export function multiFileTorrentFixture(
	options: {
		name?: string;
		files?: Array<{ path: string[]; content: Uint8Array }>;
		paddingFiles?: Array<{ path: string[]; length: number }>;
		pieceLength?: number;
		announce?: string;
		webSeeds?: string[];
	} = {},
): TorrentFixture {
	const name = options.name ?? "album";
	const files = options.files ?? [
		{ path: ["disc1", "a.txt"], content: bytes("abc") },
		{ path: ["disc1", "b.txt"], content: bytes("defgh") },
		{ path: ["c.txt"], content: bytes("ijkl") },
	];
	const paddingFiles = options.paddingFiles ?? [];
	const content = concatBytes([
		...files.map((file) => file.content),
		...paddingFiles.map((file) => new Uint8Array(file.length)),
	]);
	const pieceLength = options.pieceLength ?? 5;
	const info: { [key: string]: BencodeValue } = {
		files: [
			...files.map((file) => ({
				length: file.content.length,
				path: file.path,
			})),
			...paddingFiles.map((file) => ({
				attr: "p",
				length: file.length,
				path: file.path,
			})),
		],
		name,
		"piece length": pieceLength,
		pieces: pieceHashBytes(content, pieceLength),
	};
	const torrent = buildTorrentDictionary(info, options);
	const raw = encode(torrent);
	return { raw, metadata: metadataFromRaw(raw), content, info };
}

function buildTorrentDictionary(
	info: { [key: string]: BencodeValue },
	options: {
		announce?: string;
		announceList?: string[][];
		nodes?: Array<[string, number]>;
		private?: boolean;
		webSeeds?: string[];
	},
): { [key: string]: BencodeValue } {
	const torrent: { [key: string]: BencodeValue } = {
		announce: options.announce ?? "http://tracker.example/announce",
		info,
	};
	if (options.announceList) {
		torrent["announce-list"] = options.announceList;
	}
	if (options.nodes) {
		torrent.nodes = options.nodes;
	}
	if (options.private) {
		info.private = 1;
	}
	if (options.webSeeds) {
		if (options.webSeeds.length === 1 && options.webSeeds[0]) {
			torrent["url-list"] = options.webSeeds[0];
		} else {
			torrent["url-list"] = options.webSeeds;
		}
	}
	return torrent;
}
