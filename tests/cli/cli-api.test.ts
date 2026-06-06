import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatTorrentInfo,
	formatTorrentInfoJson,
	readTorrentInfo,
} from "../../src/cli/info";
import { parseCliArgs } from "../../src/cli/parse";
import { withTempDir } from "../helpers/temp";
import {
	multiFileTorrentFixture,
	singleFileTorrentFixture,
} from "../helpers/torrent-fixtures";

describe("CLI parser", () => {
	test("parses info and JSON commands", () => {
		expect(parseCliArgs(["sample.torrent", "--info"])).toEqual({
			action: "info",
			input: "sample.torrent",
			json: false,
		});
		expect(parseCliArgs(["sample.torrent", "--info", "--json"])).toEqual({
			action: "info",
			input: "sample.torrent",
			json: true,
		});
	});

	test("rejects ambiguous or unsupported commands", () => {
		expect(() =>
			parseCliArgs(["sample.torrent", "--info", "--download"]),
		).toThrow("Choose only one action flag");
		expect(() => parseCliArgs(["sample.torrent", "--json"])).toThrow(
			"--json can only be used with --info",
		);
		expect(() => parseCliArgs(["sample.torrent", "--bad"])).toThrow(
			"Unknown option: --bad",
		);
	});
});

describe("torrent info command", () => {
	test("formats offline torrent metadata for humans and scripts", async () => {
		await withTempDir(async (dir) => {
			const fixture = multiFileTorrentFixture({
				announce: "udp://tracker.example:6969",
				webSeeds: ["https://seed.example/album/"],
			});
			const torrentPath = join(dir, "album.torrent");
			writeFileSync(torrentPath, fixture.raw);

			const info = readTorrentInfo(torrentPath);
			expect(info.name).toBe("album");
			expect(info.infoHash).toMatch(/^[a-f0-9]{40}$/);
			expect(info.files.map((file) => file.path)).toEqual([
				"album/disc1/a.txt",
				"album/disc1/b.txt",
				"album/c.txt",
			]);
			expect(info.trackers).toEqual([["udp://tracker.example:6969"]]);
			expect(info.webSeeds).toEqual(["https://seed.example/album/"]);

			const human = formatTorrentInfo(info);
			expect(human).toContain("  Torrent Info");
			expect(human).toContain("  name        album");
			expect(human).toContain("  trackers");
			expect(human).toContain("album/disc1/a.txt");

			const parsed = JSON.parse(formatTorrentInfoJson(info)) as typeof info;
			expect(parsed).toEqual(info);
		});
	});

	test("includes private flag and DHT nodes", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture({
				private: true,
				nodes: [["127.0.0.1", 6881]],
			});
			const torrentPath = join(dir, "sample.torrent");
			writeFileSync(torrentPath, fixture.raw);

			const info = readTorrentInfo(torrentPath);
			expect(info.private).toBe(true);
			expect(info.nodes).toEqual([{ ip: "127.0.0.1", port: 6881 }]);
		});
	});
});
