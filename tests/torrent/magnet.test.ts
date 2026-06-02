import { describe, expect, test } from "bun:test";
import type { DhtClient } from "../../src/torrent/dht/node.ts";
import { parseMagnetUri } from "../../src/torrent/magnet.ts";
import { resolveMagnetToTorrent } from "../../src/torrent/magnet-resolver.ts";
import {
	buildTorrentFileFromInfo,
	MetadataPieceAssembler,
	verifyInfoBytes,
} from "../../src/torrent/metadata-cache.ts";
import { extractInfoBytes } from "../../src/torrent/parser.ts";
import { METADATA_BLOCK_SIZE } from "../../src/torrent/peer/extension.ts";
import type { PeerInfo } from "../../src/torrent/types.ts";
import { hex } from "../helpers/bytes.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

describe("magnet URI parsing", () => {
	test("parses hex btih, trackers, explicit peers, and display name", () => {
		const magnet = parseMagnetUri(
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=sample&tr=http%3A%2F%2Ftracker.example%2Fannounce&tr=udp%3A%2F%2Ftracker.example%3A6969&x.pe=127.0.0.1%3A6881",
		);

		expect(hex(magnet.infoHash)).toBe(
			"0123456789abcdef0123456789abcdef01234567",
		);
		expect(magnet.displayName).toBe("sample");
		expect(magnet.trackers).toEqual([
			"http://tracker.example/announce",
			"udp://tracker.example:6969",
		]);
		expect(magnet.peers).toEqual([{ ip: "127.0.0.1", port: 6881 }]);
	});

	test("parses base32 btih", () => {
		const magnet = parseMagnetUri(
			"magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH",
		);

		expect(hex(magnet.infoHash)).toBe(
			"0123456789abcdef0123456789abcdef01234567",
		);
	});

	test("rejects unsupported or malformed magnets", () => {
		expect(() => parseMagnetUri("https://example.test")).toThrow("magnet:?");
		expect(() => parseMagnetUri("magnet:?xt=urn:btmh:abc")).toThrow(
			"Only BitTorrent v1",
		);
		expect(() => parseMagnetUri("magnet:?xt=urn:btih:bad")).toThrow(
			"btih must",
		);
	});
});

describe("magnet metadata cache helpers", () => {
	test("preserves raw info bytes in cached torrent files", () => {
		const fixture = singleFileTorrentFixture();
		const infoBytes = extractInfoBytes(fixture.raw);
		const rawTorrent = buildTorrentFileFromInfo({
			infoBytes,
			announceList: ["http://tracker.example/announce"],
		});

		expect(extractInfoBytes(rawTorrent)).toEqual(infoBytes);
		verifyInfoBytes(infoBytes, fixture.metadata.infoHash);
	});

	test("assembles BEP 9 metadata pieces", () => {
		const data = new Uint8Array(METADATA_BLOCK_SIZE + 3).fill(7);
		const assembler = new MetadataPieceAssembler(
			data.length,
			METADATA_BLOCK_SIZE,
		);

		assembler.addPiece(1, data.slice(METADATA_BLOCK_SIZE), data.length);
		expect(assembler.complete).toBe(false);
		assembler.addPiece(0, data.slice(0, METADATA_BLOCK_SIZE), data.length);

		expect(assembler.complete).toBe(true);
		expect(assembler.assemble()).toEqual(data);
	});

	test("uses DHT for trackerless magnet peer discovery", async () => {
		const dht = new FakeMagnetDht([{ ip: "127.0.0.1", port: 1 }]);

		await expect(
			resolveMagnetToTorrent(
				"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
				{ dht: dht as unknown as DhtClient },
			),
		).rejects.toThrow("Failed to fetch magnet metadata");

		expect(dht.started).toBe(true);
		expect(dht.lookups).toBe(1);
	});
});

class FakeMagnetDht {
	started = false;
	lookups = 0;

	constructor(private readonly peers: PeerInfo[]) {}

	async start(): Promise<void> {
		this.started = true;
	}

	async getPeers(): Promise<PeerInfo[]> {
		this.lookups++;
		return this.peers;
	}
}
