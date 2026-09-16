import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listTorrentPathSuggestions,
	readTorrentDirectory,
	resolveBrowseDirectory,
} from "../../../src/ui/torrent-paths";

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

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "torrent-tui-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("torrent path helpers", () => {
	test("lists directories and torrent files in a stable order", async () => {
		const directory = await createTemporaryDirectory();
		await mkdir(join(directory, "folder"));
		await symlink(join(directory, "folder"), join(directory, "linked-dir"));
		await writeFile(join(directory, "z.torrent"), "torrent");
		await symlink(
			join(directory, "z.torrent"),
			join(directory, "linked.torrent"),
		);
		await writeFile(join(directory, "ignored.txt"), "ignored");

		expect(await readTorrentDirectory(directory)).toEqual([
			{
				name: "folder",
				path: join(directory, "folder"),
				kind: "directory",
			},
			{
				name: "linked-dir",
				path: join(directory, "linked-dir"),
				kind: "directory",
			},
			{
				name: "linked.torrent",
				path: join(directory, "linked.torrent"),
				kind: "file",
			},
			{
				name: "z.torrent",
				path: join(directory, "z.torrent"),
				kind: "file",
			},
		]);
	});

	test("suggests matching local paths and ignores remote sources", async () => {
		const directory = await createTemporaryDirectory();
		await mkdir(join(directory, "folder"));
		await writeFile(join(directory, "alpha.torrent"), "torrent");
		await writeFile(join(directory, "beta.torrent"), "torrent");

		expect(await listTorrentPathSuggestions(join(directory, "al"))).toEqual(
			[
				{
					name: "alpha.torrent",
					path: join(directory, "alpha.torrent"),
					kind: "file",
					value: join(directory, "alpha.torrent"),
				},
			],
		);
		expect(
			await listTorrentPathSuggestions("magnet:?xt=urn:btih:test"),
		).toEqual([]);
	});

	test("resolves usable browse directories and falls back to the working directory", async () => {
		const directory = await createTemporaryDirectory();
		const folder = join(directory, "folder");
		await mkdir(folder);

		expect(await resolveBrowseDirectory(folder)).toBe(folder);
		expect(
			await resolveBrowseDirectory(join(folder, "missing.torrent")),
		).toBe(folder);
		expect(await resolveBrowseDirectory("")).toBe(process.cwd());
		expect(
			await resolveBrowseDirectory("https://example.com/file.torrent"),
		).toBe(process.cwd());
	});
});
