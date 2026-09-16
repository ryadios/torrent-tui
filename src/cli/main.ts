import { stringWidth } from "bun";
import {
	addTorrent,
	type RefreshOutcome,
	removeTorrent,
	startTorrent,
	stopTorrent,
	type TorrentOperations,
} from "../torrent/actions";
import type { TorrentSummary } from "../transmission/types/torrent";

export type CliOutput = {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
};

const defaultOutput: CliOutput = {
	stdout: (text) => process.stdout.write(`${text}\n`),
	stderr: (text) => process.stderr.write(`${text}\n`),
};

const usage =
	"Usage: torrent-tui [list | add <source> | start <hash> | stop <hash> | remove <hash>]";

const statuses: Record<number, string> = {
	0: "Stopped",
	1: "Queued",
	2: "Verifying",
	3: "Queued",
	4: "Downloading",
	5: "Queued",
	6: "Seeding",
};

function formatStatus(torrent: TorrentSummary): string {
	if (torrent.error !== 0) {
		return torrent.error_string
			? `Error: ${torrent.error_string}`
			: "Error";
	}

	return statuses[torrent.status] ?? `Status ${torrent.status}`;
}

function formatRate(bytesPerSecond: number): string {
	const rate = Math.max(0, bytesPerSecond);
	const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
	let value = rate;
	let unitIndex = 0;

	if (value < 1024) return `${Math.round(value)} B/s`;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatProgress(percentDone: number): string {
	const percent = Number.isFinite(percentDone)
		? Math.min(1, Math.max(0, percentDone))
		: 0;
	return `${Math.round(percent * 100)}%`;
}

function pad(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}

function printTorrentList(torrents: TorrentSummary[], output: CliOutput): void {
	if (torrents.length === 0) {
		output.stdout("No torrents.");
		return;
	}

	const headers = [
		"HASH",
		"NAME",
		"STATUS",
		"PROGRESS",
		"DOWNLOAD",
		"UPLOAD",
	];
	const rows = torrents.map((torrent) => [
		torrent.hash_string,
		torrent.name,
		formatStatus(torrent),
		formatProgress(torrent.percent_done),
		`↓ ${formatRate(torrent.rate_download)}`,
		`↑ ${formatRate(torrent.rate_upload)}`,
	]);
	const widths = headers.map((header, index) =>
		Math.max(
			stringWidth(header),
			...rows.map((row) => stringWidth(row[index] ?? "")),
		),
	);

	output.stdout(
		headers
			.map((header, index) =>
				index === headers.length - 1
					? header
					: pad(header, widths[index] ?? stringWidth(header)),
			)
			.join("  "),
	);
	for (const row of rows) {
		output.stdout(
			row
				.map((value, index) =>
					index === row.length - 1
						? value
						: pad(value, widths[index] ?? stringWidth(value)),
				)
				.join("  "),
		);
	}
}

function printOperationError(output: CliOutput, error: unknown): number {
	output.stderr(
		`Error: ${error instanceof Error ? error.message : String(error)}`,
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
		output.stdout(`${prefix} ${reference.name} (${reference.hash_string})`);
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
	output.stderr(usage);
	return 2;
}

export async function runCli(
	args: readonly string[],
	operations: TorrentOperations,
	output: CliOutput = defaultOutput,
): Promise<number> {
	const command = args[0];

	if (command === "list") {
		return args.length === 1
			? runList(operations, output)
			: usageError(output);
	}

	if (command === "add") {
		return args.length === 2
			? runAdd(operations, args[1] ?? "", output)
			: usageError(output);
	}

	if (command === "start" && args.length === 2) {
		const hash = args[1] ?? "";
		return runMutation(
			() => startTorrent(operations, hash),
			`Started ${hash}`,
			output,
		);
	}

	if (command === "stop" && args.length === 2) {
		const hash = args[1] ?? "";
		return runMutation(
			() => stopTorrent(operations, hash),
			`Stopped ${hash}`,
			output,
		);
	}

	if (command === "remove" && args.length === 2) {
		const hash = args[1] ?? "";
		return runMutation(
			() => removeTorrent(operations, hash),
			`Removed ${hash} (local data kept)`,
			output,
		);
	}

	return usageError(output);
}
