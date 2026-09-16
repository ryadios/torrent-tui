import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	expandTorrentPath,
	resolveTorrentSource,
} from "../../../src/torrent/source";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
	);
});

describe("torrent source resolution", () => {
	test("expands supported local path forms", () => {
		expect(expandTorrentPath("~")).toBe(homedir());
		expect(expandTorrentPath("~/Downloads")).toBe(
			resolve(homedir(), "Downloads"),
		);
		expect(expandTorrentPath("./file.torrent")).toBe(
			resolve(process.cwd(), "file.torrent"),
		);
		expect(expandTorrentPath("/tmp/file.torrent")).toBe(
			"/tmp/file.torrent",
		);
	});

	test("keeps remote sources as filenames", async () => {
		await expect(
			resolveTorrentSource("  magnet:?xt=urn:btih:abc123  "),
		).resolves.toEqual({
			filename: "magnet:?xt=urn:btih:abc123",
		});
	});

	test("reads a local source as base64 metainfo", async () => {
		const directory = await mkdtemp(join("/tmp", "torrent-tui-source-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "example.torrent");
		await writeFile(path, "torrent bytes");

		await expect(resolveTorrentSource(path)).resolves.toEqual({
			metainfo: "dG9ycmVudCBieXRlcw==",
		});
	});

	test("falls back to an expanded filename when a local source cannot be read", async () => {
		const source = "./missing.torrent";

		await expect(resolveTorrentSource(source)).resolves.toEqual({
			filename: resolve(process.cwd(), source),
		});
	});
});
