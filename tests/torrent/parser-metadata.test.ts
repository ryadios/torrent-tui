import { describe, expect, test } from "bun:test";
import { TorrentMetadata } from "../../src/torrent/metadata.ts";
import type { BencodeValue } from "../../src/torrent/parser.ts";
import {
	decode,
	encode,
	extractInfoBytes,
	parseStringB,
} from "../../src/torrent/parser.ts";
import { bytes, hex } from "../helpers/bytes.ts";
import {
	metadataFromRaw,
	multiFileTorrentFixture,
	singleFileTorrentFixture,
} from "../helpers/torrent-fixtures.ts";

describe("bencode parser", () => {
	test("decodes primitive and nested values", () => {
		expect(decode(bytes("i42e"))).toBe(42);
		expect(Array.from(decode(bytes("4:spam")) as Uint8Array)).toEqual(
			Array.from(bytes("spam")),
		);
		expect(decode(bytes("li1e3:twoe"))).toEqual([1, bytes("two")]);
		expect(decode(bytes("d1:ali1ei2ee1:bi3ee"))).toEqual({
			a: [1, 2],
			b: 3,
		});
	});

	test("decodes text strings when requested", () => {
		expect(parseStringB(bytes("5:hello"), 0)).toEqual(["hello", 7]);
	});

	test("round trips bencode values with sorted dictionary keys", () => {
		const value: { [key: string]: BencodeValue } = {
			z: 1,
			a: "x",
			list: [bytes("raw"), -2],
		};
		const encoded = encode(value);

		expect(Buffer.from(encoded).toString()).toBe(
			"d1:a1:x4:listl3:rawi-2ee1:zi1ee",
		);
		expect(decode(encoded)).toEqual({
			a: bytes("x"),
			list: [bytes("raw"), -2],
			z: 1,
		});
	});

	test("rejects malformed bencode", () => {
		expect(() => decode(bytes("i12"))).toThrow("Unterminated integer");
		expect(() => decode(bytes("4:abc"))).toThrow(
			"Invalid string: length exceeds data",
		);
		expect(() => decode(bytes("i1ee"))).toThrow("Extra data");
		expect(() => decode(bytes("x"))).toThrow("Invalid bencode type");
	});

	test("extracts raw info bytes without depending on top-level key order", () => {
		const fixture = singleFileTorrentFixture();

		expect(extractInfoBytes(fixture.raw)).toEqual(encode(fixture.info));
		expect(hex(fixture.metadata.infoHash)).toBe(
			"f0e16d3ed965f1025c51c11e78e664cda769d6a0",
		);
	});
});

describe("TorrentMetadata", () => {
	test("parses single-file metadata", () => {
		const fixture = singleFileTorrentFixture({
			announceList: [
				["http://tracker-a.example/announce"],
				["udp://tracker-b.example:6969"],
			],
		});
		const metadata = fixture.metadata;

		expect(metadata.name).toBe("sample.bin");
		expect(metadata.totalSize).toBe(12);
		expect(metadata.pieceLength).toBe(4);
		expect(metadata.pieceCount).toBe(3);
		expect(metadata.files).toEqual([
			{ path: "sample.bin", length: 12, offset: 0 },
		]);
		expect(metadata.announceList).toEqual([
			["http://tracker-a.example/announce"],
			["udp://tracker-b.example:6969"],
		]);
		expect(metadata.formatSize()).toBe("0.0 KB");
		expect(metadata.formatPieceLength()).toBe("0 KB");
	});

	test("parses multi-file metadata and maps pieces across file boundaries", () => {
		const fixture = multiFileTorrentFixture();
		const metadata = fixture.metadata;

		expect(metadata.name).toBe("album");
		expect(metadata.totalSize).toBe(12);
		expect(metadata.pieceLength).toBe(5);
		expect(metadata.pieceCount).toBe(3);
		expect(metadata.files).toEqual([
			{ path: "album/disc1/a.txt", length: 3, offset: 0 },
			{ path: "album/disc1/b.txt", length: 5, offset: 3 },
			{ path: "album/c.txt", length: 4, offset: 8 },
		]);
		const firstFile = metadata.files[0];
		const secondFile = metadata.files[1];
		const thirdFile = metadata.files[2];
		if (!firstFile || !secondFile || !thirdFile) {
			throw new Error("missing multi-file metadata fixture entries");
		}

		expect(metadata.pieceToFileRanges(0)).toEqual([
			{
				file: firstFile,
				fileOffset: 0,
				length: 3,
			},
			{
				file: secondFile,
				fileOffset: 0,
				length: 2,
			},
		]);
		expect(metadata.pieceToFileRanges(2)).toEqual([
			{
				file: thirdFile,
				fileOffset: 2,
				length: 2,
			},
		]);
	});

	test("parses private flag and DHT bootstrap nodes", () => {
		const { metadata } = singleFileTorrentFixture({
			private: true,
			nodes: [["127.0.0.1", 6881]],
		});

		expect(metadata.private).toBe(true);
		expect(metadata.nodes).toEqual([{ ip: "127.0.0.1", port: 6881 }]);
	});

	test("throws on invalid metadata", () => {
		const fixture = singleFileTorrentFixture();
		const decoded = decode(fixture.raw) as { [key: string]: BencodeValue };
		const info = decoded.info as { [key: string]: BencodeValue };
		info.pieces = bytes("bad");

		expect(() => new TorrentMetadata(decoded, encode(decoded))).toThrow(
			"pieces length is not a multiple of 20",
		);
	});

	test("builds metadata from raw fixture bytes", () => {
		const fixture = singleFileTorrentFixture();

		expect(metadataFromRaw(fixture.raw).name).toBe(fixture.metadata.name);
	});
});
