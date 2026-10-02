import { stripANSI } from "bun";
import packageMetadata from "../../package.json" with { type: "json" };
import {
	addTorrent,
	type RefreshOutcome,
	removeTorrent,
	startTorrent,
	stopTorrent,
	type TorrentOperations,
} from "../torrent/actions";
import type { TorrentSummary } from "../transmission/types/torrent";
import { formatRate } from "../ui/format-rate";

export type CliOutput = {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
};

const defaultOutput: CliOutput = {
	stdout: (text) => process.stdout.write(`${text}\n`),
	stderr: (text) => process.stderr.write(`${text}\n`),
};

const help = [
	"usage: torrent-tui <command>",
	"",
	"commands:",
	"  list                       show torrent status, progress, rates, and hashes",
	"  add <source>               add a local .torrent path, magnet link, or URL",
	"  start <hash>               start a torrent using its full hash",
	"  stop <hash>                stop a torrent using its full hash",
	"  remove <hash>              remove a torrent; downloaded data is kept",
	"  help, --help, -h           show this help",
	"  version, --version, -v     print the installed version",
] as const;

const statuses: Record<number, string> = {
	0: "Stopped",
	1: "Queued",
	2: "Verifying",
	3: "Queued",
	4: "Downloading",
	5: "Queued",
	6: "Seeding",
};

function sanitizeTerminalText(value: string): string {
	return stripANSI(value).replace(/\p{Cc}/gu, "");
}

function formatStatus(torrent: TorrentSummary): string {
	if (torrent.error !== 0) {
		const errorString = sanitizeTerminalText(torrent.error_string);
		return errorString ? `Error: ${errorString}` : "Error";
	}

	return statuses[torrent.status] ?? `Status ${torrent.status}`;
}

function formatProgress(percentDone: number): string {
	const percent = Number.isFinite(percentDone)
		? Math.min(1, Math.max(0, percentDone))
		: 0;
	return `${Math.round(percent * 100)}%`;
}

function torrentMarker(torrent: TorrentSummary): string {
	if (torrent.error !== 0) return "✗";
	return torrent.is_finished ? "✓" : "•";
}

function printTorrentList(torrents: TorrentSummary[], output: CliOutput): void {
	output.stdout(`Torrents (${torrents.length})`);
	output.stdout("");

	if (torrents.length === 0) {
		output.stdout("No torrents.");
		return;
	}

	for (const torrent of torrents) {
		output.stdout(
			`${torrentMarker(torrent)} ${sanitizeTerminalText(torrent.name)} — ${formatStatus(torrent)} · ${formatProgress(torrent.percent_done)} · ↓ ${formatRate(torrent.rate_download)} · ↑ ${formatRate(torrent.rate_upload)}`,
		);
		output.stdout(`  hash: ${sanitizeTerminalText(torrent.hash_string)}`);
	}
}

function printOperationError(output: CliOutput, error: unknown): number {
	output.stderr(
		`✗ Error: ${error instanceof Error ? error.message : String(error)}`,
	);
	return 1;
}

function printRefreshWarning(output: CliOutput, outcome: RefreshOutcome): void {
	if (outcome.status === "refresh-failed") {
		output.stderr("Warning: list refresh failed");
	}
}

async function runList(
	operations: TorrentOperations,
	output: CliOutput,
): Promise<number> {
	try {
		const { torrents } = await operations.listTorrents();
		printTorrentList(torrents, output);
		return 0;
	} catch (error) {
		return printOperationError(output, error);
	}
}

async function runAdd(
	operations: TorrentOperations,
	source: string,
	output: CliOutput,
): Promise<number> {
	try {
		const outcome = await addTorrent(operations, source);
		const reference =
			"torrent_added" in outcome.addResult
				? outcome.addResult.torrent_added
				: outcome.addResult.torrent_duplicate;
		const prefix =
			"torrent_added" in outcome.addResult ? "Added" : "Already added";
		output.stdout(
			`✓ ${prefix} ${reference.name} (${reference.hash_string})`,
		);
		printRefreshWarning(output, outcome);
		return 0;
	} catch (error) {
		return printOperationError(output, error);
	}
}

async function runMutation(
	action: () => Promise<RefreshOutcome>,
	successMessage: string,
	output: CliOutput,
): Promise<number> {
	try {
		const outcome = await action();
		output.stdout(successMessage);
		printRefreshWarning(output, outcome);
		return 0;
	} catch (error) {
		return printOperationError(output, error);
	}
}

function usageError(output: CliOutput): number {
	for (const line of help) output.stderr(line);
	return 2;
}

export async function runCli(
	args: readonly string[],
	operations: TorrentOperations,
	output: CliOutput = defaultOutput,
): Promise<number> {
	const safeOutput: CliOutput = {
		stdout: (text) => output.stdout(sanitizeTerminalText(text)),
		stderr: (text) => output.stderr(sanitizeTerminalText(text)),
	};
	const command = args[0];
	if (command === "help" || command === "--help" || command === "-h") {
		if (args.length !== 1) return usageError(safeOutput);
		for (const line of help) safeOutput.stdout(line);
		return 0;
	}
	if (command === "version" || command === "--version" || command === "-v") {
		if (args.length !== 1) return usageError(safeOutput);
		safeOutput.stdout(packageMetadata.version);
		return 0;
	}

	if (command === "list") {
		return args.length === 1
			? runList(operations, safeOutput)
			: usageError(safeOutput);
	}

	if (command === "add") {
		return args.length === 2
			? runAdd(operations, args[1] ?? "", safeOutput)
			: usageError(safeOutput);
	}

	if (command === "start" && args.length === 2) {
		const hash = args[1]?.trim();
		if (!hash) return usageError(safeOutput);
		return runMutation(
			() => startTorrent(operations, hash),
			`✓ Started ${hash}`,
			safeOutput,
		);
	}

	if (command === "stop" && args.length === 2) {
		const hash = args[1]?.trim();
		if (!hash) return usageError(safeOutput);
		return runMutation(
			() => stopTorrent(operations, hash),
			`✓ Stopped ${hash}`,
			safeOutput,
		);
	}

	if (command === "remove" && args.length === 2) {
		const hash = args[1]?.trim();
		if (!hash) return usageError(safeOutput);
		return runMutation(
			() => removeTorrent(operations, hash),
			`✓ Removed ${hash} (local data kept)`,
			safeOutput,
		);
	}

	return usageError(safeOutput);
}
