import { describe, expect, test } from "bun:test";
import packageMetadata from "../../../package.json" with { type: "json" };
import { type CliOutput, runCli } from "../../../src/cli/main";
import type { TorrentOperations } from "../../../src/torrent/actions";
import type {
	TorrentAddResult,
	TorrentList,
	TorrentSummary,
} from "../../../src/transmission/types/torrent";

const emptyList: TorrentList = { torrents: [] };
const addedResult: TorrentAddResult = {
	torrent_added: {
		id: 1,
		hash_string: "abc123",
		name: "example.torrent",
	},
};

function makeOperations(
	overrides: Partial<TorrentOperations> = {},
): TorrentOperations {
	return {
		listTorrents: async () => emptyList,
		getTorrentDetails: async () => undefined,
		getSessionStats: async () => ({ download_speed: 0, upload_speed: 0 }),
		addTorrent: async () => addedResult,
		startTorrent: async () => {},
		stopTorrent: async () => {},
		removeTorrent: async () => {},
		...overrides,
	};
}

function captureOutput(): {
	output: CliOutput;
	stdout: string[];
	stderr: string[];
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		output: {
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		},
		stdout,
		stderr,
	};
}

function torrent(
	name: string,
	hash = "0123456789012345678901234567890123456789",
	status = 4,
): TorrentSummary {
	return {
		id: 1,
		hash_string: hash,
		name,
		status,
		percent_done: 0.5,
		rate_download: 1500,
		rate_upload: 0,
		eta: 0,
		total_size: 1,
		upload_ratio: 0,
		peers_connected: 0,
		is_finished: false,
		error: 0,
		error_string: "",
	};
}

describe("CLI", () => {
	test("prints compact torrent entries with full hashes and state markers", async () => {
		const captured = captureOutput();
		const hash = "0123456789012345678901234567890123456789";
		const finishedHash = "1111111111111111111111111111111111111111";
		const errorHash = "2222222222222222222222222222222222222222";
		const finished = torrent("Finished torrent", finishedHash, 6);
		finished.percent_done = 1;
		finished.rate_download = 0;
		finished.rate_upload = 3200;
		finished.is_finished = true;
		const errored = torrent("Broken torrent", errorHash);
		errored.percent_done = 0.25;
		errored.rate_download = 0;
		errored.error = 1;
		errored.error_string = "tracker unavailable";
		const result = await runCli(
			["list"],
			makeOperations({
				listTorrents: async () => ({
					torrents: [
						torrent("Example torrent", hash),
						finished,
						errored,
					],
				}),
			}),
			captured.output,
		);

		expect(result).toBe(0);
		expect(captured.stderr).toEqual([]);
		expect(captured.stdout).toEqual([
			"Torrents (3)",
			"",
			"• Example torrent — Downloading · 50% · ↓ 1.5 KB/s · ↑ 0 B/s",
			`  hash: ${hash}`,
			"✓ Finished torrent — Seeding · 100% · ↓ 0 B/s · ↑ 3.2 KB/s",
			`  hash: ${finishedHash}`,
			"✗ Broken torrent — Error: tracker unavailable · 25% · ↓ 0 B/s · ↑ 0 B/s",
			`  hash: ${errorHash}`,
		]);
	});

	test("reports an empty list beneath its heading", async () => {
		const captured = captureOutput();
		const result = await runCli(
			["list"],
			makeOperations(),
			captured.output,
		);

		expect(result).toBe(0);
		expect(captured.stdout).toEqual(["Torrents (0)", "", "No torrents."]);
		expect(captured.stderr).toEqual([]);
	});

	test("adds new and duplicate torrents with distinct messages", async () => {
		const captured = captureOutput();
		let addCalls = 0;
		const operations = makeOperations({
			addTorrent: async () => {
				addCalls += 1;
				return addCalls === 1
					? addedResult
					: { torrent_duplicate: addedResult.torrent_added };
			},
		});

		expect(
			await runCli(
				["add", "magnet:?xt=urn:btih:abc123"],
				operations,
				captured.output,
			),
		).toBe(0);
		expect(
			await runCli(
				["add", "magnet:?xt=urn:btih:abc123"],
				operations,
				captured.output,
			),
		).toBe(0);

		expect(captured.stdout).toEqual([
			"✓ Added example.torrent (abc123)",
			"✓ Already added example.torrent (abc123)",
		]);
	});

	test("runs hash mutations through the shared workflows", async () => {
		const commands = [
			["start", "Started abc123"],
			["stop", "Stopped abc123"],
			["remove", "Removed abc123 (local data kept)"],
		] as const;

		for (const [command, message] of commands) {
			const captured = captureOutput();
			const calls: string[] = [];
			const result = await runCli(
				[command, " abc123 "],
				makeOperations({
					startTorrent: async (hash) => {
						calls.push(`start:${hash}`);
					},
					stopTorrent: async (hash) => {
						calls.push(`stop:${hash}`);
					},
					removeTorrent: async (hash) => {
						calls.push(`remove:${hash}`);
					},
				}),
				captured.output,
			);

			expect(result).toBe(0);
			expect(calls).toEqual([`${command}:${"abc123"}`]);
			expect(captured.stdout).toEqual([`✓ ${message}`]);
			expect(captured.stderr).toEqual([]);
		}
	});

	test("rejects blank hash mutations before calling the daemon", async () => {
		for (const command of ["start", "stop", "remove"] as const) {
			const captured = captureOutput();
			const calls: string[] = [];

			expect(
				await runCli(
					[command, " \t"],
					makeOperations({
						startTorrent: async () => {
							calls.push("start");
						},
						stopTorrent: async () => {
							calls.push("stop");
						},
						removeTorrent: async () => {
							calls.push("remove");
						},
					}),
					captured.output,
				),
			).toBe(2);
			expect(calls).toEqual([]);
			expect(captured.stdout).toEqual([]);
			expect(captured.stderr).toHaveLength(1);
			expect(captured.stderr[0]).toContain("usage: torrent-tui");
		}
	});

	test("sanitizes daemon text before writing CLI output", async () => {
		const unsafe = "\u001b[31mTorrent\u001b[0m\nname";
		const listOutput = captureOutput();
		const listedTorrent = torrent(unsafe, unsafe);
		listedTorrent.error = 1;
		listedTorrent.error_string = unsafe;

		expect(
			await runCli(
				["list"],
				makeOperations({
					listTorrents: async () => ({ torrents: [listedTorrent] }),
				}),
				listOutput.output,
			),
		).toBe(0);
		expect(listOutput.stdout.join("\n")).toContain(
			"✗ Torrentname — Error: Torrentname",
		);
		expect(listOutput.stdout.join("\n")).not.toContain("\u001b");
		expect(listOutput.stdout.every((line) => !line.includes("\n"))).toBe(
			true,
		);

		const addOutput = captureOutput();
		expect(
			await runCli(
				["add", "source"],
				makeOperations({
					addTorrent: async () => ({
						torrent_added: {
							id: 1,
							hash_string: unsafe,
							name: unsafe,
						},
					}),
				}),
				addOutput.output,
			),
		).toBe(0);
		expect(addOutput.stdout).toEqual(["✓ Added Torrentname (Torrentname)"]);

		const errorOutput = captureOutput();
		expect(
			await runCli(
				["stop", "hash"],
				makeOperations({
					stopTorrent: async () => {
						throw new Error(unsafe);
					},
				}),
				errorOutput.output,
			),
		).toBe(1);
		expect(errorOutput.stderr).toEqual(["✗ Error: Torrentname"]);
	});

	test("keeps a successful mutation when the follow-up refresh fails", async () => {
		const captured = captureOutput();
		const result = await runCli(
			["start", "abc123"],
			makeOperations({
				listTorrents: async () => {
					throw new Error("refresh unavailable");
				},
			}),
			captured.output,
		);

		expect(result).toBe(0);
		expect(captured.stdout).toEqual(["✓ Started abc123"]);
		expect(captured.stderr).toEqual(["Warning: list refresh failed"]);
	});

	test("returns usage errors and operation errors with distinct statuses", async () => {
		const usage = captureOutput();
		expect(await runCli([], makeOperations(), usage.output)).toBe(2);
		expect(await runCli(["remove"], makeOperations(), usage.output)).toBe(
			2,
		);
		expect(await runCli(["unknown"], makeOperations(), usage.output)).toBe(
			2,
		);
		expect(usage.stdout).toEqual([]);
		expect(usage.stderr).toHaveLength(30);
		expect(usage.stderr[0]).toBe("usage: torrent-tui <command>");
		expect(usage.stderr.join("\n")).toContain("remove <hash>");

		const help = captureOutput();
		expect(await runCli(["--help"], makeOperations(), help.output)).toBe(0);
		expect(help.stdout[0]).toBe("usage: torrent-tui <command>");
		expect(help.stdout.join("\n")).toContain("add <source>");
		expect(help.stderr).toEqual([]);

		const version = captureOutput();
		expect(
			await runCli(["--version"], makeOperations(), version.output),
		).toBe(0);
		expect(version.stdout).toEqual([packageMetadata.version]);
		expect(version.stderr).toEqual([]);

		const failure = captureOutput();
		const result = await runCli(
			["stop", "abc123"],
			makeOperations({
				stopTorrent: async () => {
					throw new Error("stop unavailable");
				},
			}),
			failure.output,
		);

		expect(result).toBe(1);
		expect(failure.stdout).toEqual([]);
		expect(failure.stderr).toEqual(["✗ Error: stop unavailable"]);
	});
});
