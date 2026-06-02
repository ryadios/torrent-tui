import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/store/index.ts";
import { TorrentBridge } from "../src/torrent/bridge.ts";
import { TorrentMetadata } from "../src/torrent/metadata.ts";
import type { BencodeValue } from "../src/torrent/parser.ts";
import { encode } from "../src/torrent/parser.ts";
import { writeResumeData } from "../src/torrent/resume.ts";

interface ScenarioTorrent {
	completePieces: number;
	name: string;
	pieces: number;
}

interface Args {
	rounds: number;
	stale: boolean;
}

const MIB = 1024 * 1024;
const DEFAULT_PIECE_LENGTH = MIB;
const USER_SCENARIO: ScenarioTorrent[] = [
	{ name: "seeded-1-8g.bin", pieces: 1844, completePieces: 1844 },
	{ name: "stopped-1-4g.bin", pieces: 1434, completePieces: 57 },
];

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const results = [];

	for (let round = 0; round < args.rounds; round++) {
		results.push(await runRound(args));
	}

	const summary = summarize(results);
	console.log(JSON.stringify(summary, null, 2));
}

async function runRound(args: Args): Promise<Record<string, number>> {
	const dir = mkdtempSync(join(tmpdir(), "torrent-tui-startup-bench-"));
	const previousHome = process.env.HOME;
	const previousXdgDataHome = process.env.XDG_DATA_HOME;
	const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

	try {
		const paths = {
			home: join(dir, "home"),
			data: join(dir, "data"),
			config: join(dir, "config"),
			downloads: join(dir, "downloads"),
			torrents: join(dir, "torrents"),
		};
		process.env.HOME = paths.home;
		process.env.XDG_DATA_HOME = paths.data;
		process.env.XDG_CONFIG_HOME = paths.config;

		const fixture = createScenario(paths.downloads, paths.torrents, args.stale);
		const store = new Store({
			selectedIndex: 0,
			selectedView: "All",
			torrents: [],
			totalDownloadBps: 0,
			totalUploadBps: 0,
		});
		const bridge = new TorrentBridge(store, {
			downloadPath: paths.downloads,
			maxConnections: 50,
			torrentFolder: paths.torrents,
			downloadRateLimitBps: 0,
			uploadRateLimitBps: 0,
		});

		let firstRowMs: number | null = null;
		let allRowsMs: number | null = null;
		let backgroundCompleteMs: number | null = null;
		const started = performance.now();
		const cpuStart = process.cpuUsage();
		const sampler = createSampler();
		const loopDelay = createEventLoopDelayMonitor();
		sampler.start();
		loopDelay.start();

		store.subscribe((state) => {
			const elapsed = performance.now() - started;
			if (firstRowMs === null && state.torrents.length > 0)
				firstRowMs = elapsed;
			if (allRowsMs === null && state.torrents.length === fixture.count) {
				allRowsMs = elapsed;
			}
			if (
				backgroundCompleteMs === null &&
				state.torrents.length === fixture.count &&
				state.torrents.every((torrent) => torrent.status !== "checking")
			) {
				backgroundCompleteMs = elapsed;
			}
		});

		try {
			await bridge.restoreSession();
			const restoreReturnMs = performance.now() - started;
			await waitFor(() => backgroundCompleteMs !== null || !args.stale, 30_000);
			if (backgroundCompleteMs === null && args.stale) {
				console.warn("warning: background verification timed out");
			}

			const cpu = process.cpuUsage(cpuStart);
			const peaks = sampler.stop();
			const maxEventLoopDelayMs = loopDelay.stop();

			return {
				firstRowMs: firstRowMs ?? restoreReturnMs,
				allRowsMs: allRowsMs ?? restoreReturnMs,
				restoreReturnMs,
				backgroundCompleteMs: backgroundCompleteMs ?? restoreReturnMs,
				cpuUserMs: cpu.user / 1000,
				cpuSystemMs: cpu.system / 1000,
				peakRssMiB: peaks.rss / MIB,
				peakHeapMiB: peaks.heapUsed / MIB,
				maxEventLoopDelayMs,
			};
		} finally {
			sampler.stop();
			loopDelay.stop();
		}
	} finally {
		restoreEnv("HOME", previousHome);
		restoreEnv("XDG_DATA_HOME", previousXdgDataHome);
		restoreEnv("XDG_CONFIG_HOME", previousXdgConfigHome);
		rmSync(dir, { recursive: true, force: true });
	}
}

function createScenario(
	downloadPath: string,
	torrentPath: string,
	stale: boolean,
): { count: number } {
	const registry: Array<{ infoHash: string; torrentPath: string }> = [];
	mkdirSync(downloadPath, { recursive: true });
	mkdirSync(torrentPath, { recursive: true });

	for (const torrent of USER_SCENARIO) {
		const metadata = createTorrent(downloadPath, torrentPath, torrent);
		if (!stale) {
			writeResumeData(metadata, downloadPath, range(0, torrent.completePieces));
		}
		registry.push({
			infoHash: Buffer.from(metadata.infoHash).toString("hex"),
			torrentPath: join(torrentPath, `${torrent.name}.torrent`),
		});
	}

	const registryFile = join(
		process.env.XDG_DATA_HOME ?? "",
		"torrent-tui",
		"session.json",
	);
	mkdirSync(join(process.env.XDG_DATA_HOME ?? "", "torrent-tui"), {
		recursive: true,
	});
	writeFileSync(
		registryFile,
		JSON.stringify({ schemaVersion: 1, torrents: registry }),
	);
	return { count: USER_SCENARIO.length };
}

function createTorrent(
	downloadPath: string,
	torrentPath: string,
	torrent: ScenarioTorrent,
): TorrentMetadata {
	const fullPath = join(downloadPath, torrent.name);
	const fd = openSync(fullPath, "w");
	try {
		ftruncateSync(fd, torrent.pieces * DEFAULT_PIECE_LENGTH);
	} finally {
		closeSync(fd);
	}

	const pieces: Uint8Array[] = [];
	for (let i = 0; i < torrent.pieces; i++) {
		pieces.push(fakePieceHash(i));
	}
	const info: { [key: string]: BencodeValue } = {
		length: torrent.pieces * DEFAULT_PIECE_LENGTH,
		name: torrent.name,
		"piece length": DEFAULT_PIECE_LENGTH,
		pieces: concatBytes(pieces),
	};
	const decoded = { announce: "http://tracker.example/announce", info };
	const raw = encode(decoded);
	const metadata = new TorrentMetadata(decoded, raw);
	writeFileSync(join(torrentPath, `${torrent.name}.torrent`), raw);
	return metadata;
}

function fakePieceHash(piece: number): Uint8Array {
	const bytes = new Uint8Array(20);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (piece * 31 + i * 17) & 0xff;
	}
	return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function createSampler(): {
	start: () => void;
	stop: () => { heapUsed: number; rss: number };
} {
	let timer: ReturnType<typeof setInterval> | null = null;
	let rss = 0;
	let heapUsed = 0;

	const sample = (): void => {
		const memory = process.memoryUsage();
		rss = Math.max(rss, memory.rss);
		heapUsed = Math.max(heapUsed, memory.heapUsed);
	};

	return {
		start: () => {
			sample();
			timer = setInterval(sample, 5);
		},
		stop: () => {
			if (timer) clearInterval(timer);
			sample();
			return { heapUsed, rss };
		},
	};
}

function createEventLoopDelayMonitor(intervalMs = 10): {
	start: () => void;
	stop: () => number;
} {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let expected = 0;
	let maxDelay = 0;

	const tick = (): void => {
		const now = performance.now();
		maxDelay = Math.max(maxDelay, Math.max(0, now - expected));
		expected = now + intervalMs;
		timer = setTimeout(tick, intervalMs);
	};

	return {
		start: () => {
			expected = performance.now() + intervalMs;
			timer = setTimeout(tick, intervalMs);
		},
		stop: () => {
			if (timer) clearTimeout(timer);
			return maxDelay;
		},
	};
}

function summarize(
	results: Array<Record<string, number>>,
): Record<string, unknown> {
	const averages: Record<string, number> = {};
	for (const key of Object.keys(results[0] ?? {})) {
		averages[key] = average(results.map((result) => result[key] ?? 0));
	}
	return {
		scenario: "1.8GiB complete + 1.4GiB 4% stopped",
		rounds: results.length,
		results: results.map(roundValues),
		average: roundValues(averages),
	};
}

function roundValues(values: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [
			key,
			Number(value.toFixed(1)),
		]),
	);
}

function average(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function range(start: number, end: number): number[] {
	const values: number[] = [];
	for (let i = start; i < end; i++) values.push(i);
	return values;
}

function parseArgs(args: string[]): Args {
	const parsed: Args = { rounds: 3, stale: false };
	for (const arg of args) {
		if (arg.startsWith("--rounds=")) {
			const n = Math.floor(Number(arg.slice("--rounds=".length)));
			if (!Number.isInteger(n) || n <= 0) {
				throw new Error("--rounds must be a positive integer");
			}
			parsed.rounds = n;
			continue;
		}
		if (arg === "--stale") {
			parsed.stale = true;
			continue;
		}
		throw new Error(`Unknown argument ${arg}`);
	}
	return parsed;
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
	const started = Date.now();
	while (!fn()) {
		if (Date.now() - started > timeoutMs) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
