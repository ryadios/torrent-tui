import { describe, expect, test } from "bun:test";
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
		rate_download: 1024,
		rate_upload: 0,
		eta: 0,
		total_size: 1,
		is_finished: false,
		error: 0,
		error_string: "",
	};
}

describe("CLI", () => {
	test("prints an aligned list with the full torrent hash", async () => {
		const captured = captureOutput();
		const hash = "0123456789012345678901234567890123456789";
		const result = await runCli(
			["list"],
			makeOperations({
				listTorrents: async () => ({
					torrents: [torrent("Example torrent", hash)],
				}),
			}),
			captured.output,
		);

		expect(result).toBe(0);
		expect(captured.stderr).toEqual([]);
		expect(captured.stdout).toHaveLength(2);
		expect(captured.stdout[0]).toContain("HASH");
		expect(captured.stdout[0]).toContain("DOWNLOAD");
		expect(captured.stdout[1]).toContain(hash);
		expect(captured.stdout[1]).toContain("Downloading");
		expect(captured.stdout[1]).toContain("50%");
		expect(captured.stdout[1]).toContain("↓ 1.0 KiB/s");
		expect(captured.stdout[1]).toContain("↑ 0 B/s");
	});

	test("reports an empty list without a table header", async () => {
		const captured = captureOutput();
		const result = await runCli(
			["list"],
			makeOperations(),
			captured.output,
		);

		expect(result).toBe(0);
		expect(captured.stdout).toEqual(["No torrents."]);
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
			"Added example.torrent (abc123)",
			"Already added example.torrent (abc123)",
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
				[command, "abc123"],
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
			expect(captured.stdout).toEqual([message]);
			expect(captured.stderr).toEqual([]);
		}
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
		expect(captured.stdout).toEqual(["Started abc123"]);
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
		expect(usage.stderr).toHaveLength(3);
		expect(usage.stderr[0]).toContain("Usage: torrent-tui");

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
		expect(failure.stderr).toEqual(["Error: stop unavailable"]);
	});
});
