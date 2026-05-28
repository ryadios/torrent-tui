import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SHA1 } from "bun";
import { TorrentMetadata } from "../src/torrent/metadata.ts";
import type { BencodeValue } from "../src/torrent/parser.ts";
import { encode } from "../src/torrent/parser.ts";
import { StorageManager } from "../src/torrent/storage.ts";

interface BenchmarkProfile {
	name: string;
	pieces: number;
	pieceLength: number;
}

interface BenchmarkArgs {
	profiles: BenchmarkProfile[];
	chunkSizeBytes?: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const PROFILES: Record<string, BenchmarkProfile> = {
	small: { name: "small", pieces: 64, pieceLength: 256 * KIB },
	medium: { name: "medium", pieces: 128, pieceLength: MIB },
	large: { name: "large", pieces: 256, pieceLength: 4 * MIB },
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	for (const profile of args.profiles) {
		await runProfile(profile, args.chunkSizeBytes);
	}
}

async function runProfile(
	profile: BenchmarkProfile,
	chunkSizeBytes: number | undefined,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "torrent-tui-verify-bench-"));
	const totalBytes = profile.pieces * profile.pieceLength;
	try {
		const { metadata } = createFixture(dir, profile);
		const storage = new StorageManager(metadata, dir);
		const loopDelay = createEventLoopDelayMonitor();
		let elapsedMs = 0;
		let maxEventLoopDelayMs = 0;

		loopDelay.start();
		const started = performance.now();
		let summary: Awaited<ReturnType<typeof storage.verifyAll>>;
		try {
			summary = await storage.verifyAll({
				chunkSizeBytes,
				yieldEveryPieces: 1,
				yieldEveryMs: 8,
			});
		} finally {
			elapsedMs = performance.now() - started;
			maxEventLoopDelayMs = loopDelay.stop();
		}
		const seconds = elapsedMs / 1000;

		console.log("");
		console.log(`verify benchmark: ${profile.name}`);
		console.log(`  pieces                ${profile.pieces}`);
		console.log(`  piece length          ${formatBytes(profile.pieceLength)}`);
		console.log(`  total size            ${formatBytes(totalBytes)}`);
		console.log(`  elapsed ms            ${elapsedMs.toFixed(1)}`);
		console.log(
			`  pieces/sec            ${(profile.pieces / seconds).toFixed(2)}`,
		);
		console.log(
			`  MiB/sec               ${(totalBytes / MIB / seconds).toFixed(2)}`,
		);
		console.log(`  max event-loop delay  ${maxEventLoopDelayMs.toFixed(1)} ms`);
		console.log(
			`  result                ${summary.valid} valid, ${summary.missing} missing, ${summary.corrupt} corrupt`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function createFixture(
	dir: string,
	profile: BenchmarkProfile,
): { metadata: TorrentMetadata } {
	const fileName = `${profile.name}.bin`;
	const filePath = join(dir, fileName);
	const fd = openSync(filePath, "w");
	const hashes: Uint8Array[] = [];

	try {
		for (let i = 0; i < profile.pieces; i++) {
			const piece = deterministicPiece(i, profile.pieceLength);
			hashes.push(new SHA1().update(piece).digest() as unknown as Uint8Array);
			writeSync(fd, piece, 0, piece.length);
		}
	} finally {
		closeSync(fd);
	}

	const info: { [key: string]: BencodeValue } = {
		length: profile.pieces * profile.pieceLength,
		name: fileName,
		"piece length": profile.pieceLength,
		pieces: concatBytes(hashes),
	};
	const raw = encode({
		announce: "http://tracker.example/announce",
		info,
	});
	return {
		metadata: new TorrentMetadata(
			{ announce: "http://tracker.example/announce", info },
			raw,
		),
	};
}

function deterministicPiece(index: number, length: number): Buffer {
	const piece = Buffer.allocUnsafe(length);
	for (let i = 0; i < piece.length; i++) {
		piece[i] = ((index + 1) * 31 + i * 17) & 0xff;
	}
	return piece;
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
			if (timer !== null) clearTimeout(timer);
			return maxDelay;
		},
	};
}

function parseArgs(args: string[]): BenchmarkArgs {
	let profiles: BenchmarkProfile[] = [
		profileFor("small"),
		profileFor("medium"),
	];
	let chunkSizeBytes: number | undefined;

	for (const arg of args) {
		if (arg === "--all") {
			profiles = [
				profileFor("small"),
				profileFor("medium"),
				profileFor("large"),
			];
			continue;
		}
		if (arg.startsWith("--profile=")) {
			const profileName = arg.slice("--profile=".length);
			profiles = [profileFor(profileName)];
			continue;
		}
		if (arg.startsWith("--pieces=")) {
			const pieces = parsePositiveInt(arg.slice("--pieces=".length), "pieces");
			const base = profiles[0] ?? profileFor("small");
			profiles = [{ ...base, name: "custom", pieces }];
			continue;
		}
		if (arg.startsWith("--piece-length=")) {
			const pieceLength = parseSize(arg.slice("--piece-length=".length));
			const base = profiles[0] ?? profileFor("small");
			profiles = [{ ...base, name: "custom", pieceLength }];
			continue;
		}
		if (arg.startsWith("--chunk-size=")) {
			chunkSizeBytes = parseSize(arg.slice("--chunk-size=".length));
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exitCode = 0;
			return { profiles: [] };
		}
		throw new Error(`Unknown argument '${arg}'`);
	}

	return {
		profiles: profiles.filter(
			(profile): profile is BenchmarkProfile => !!profile,
		),
		chunkSizeBytes,
	};
}

function profileFor(name: string): BenchmarkProfile {
	const profile = PROFILES[name];
	if (!profile) {
		throw new Error(
			`Unknown profile '${name}'. Use small, medium, large, or --all.`,
		);
	}
	return profile;
}

function parsePositiveInt(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
}

function parseSize(value: string): number {
	const match = /^(\d+)(kib|kb|mib|mb|b)?$/i.exec(value);
	if (!match) {
		throw new Error(`Invalid size '${value}'`);
	}
	const amount = parsePositiveInt(match[1] ?? "", "size");
	const unit = (match[2] ?? "b").toLowerCase();
	if (unit === "kib" || unit === "kb") return amount * KIB;
	if (unit === "mib" || unit === "mb") return amount * MIB;
	return amount;
}

function formatBytes(bytes: number): string {
	if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
	if (bytes >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
	return `${bytes} B`;
}

function printHelp(): void {
	console.log(`Usage: bun run bench:verify [options]

Options:
  --profile=small|medium|large   Run one built-in profile
  --all                          Run every built-in profile
  --pieces=N                     Run a custom piece count
  --piece-length=SIZE            Run a custom piece length, e.g. 512KiB or 4MiB
  --chunk-size=SIZE              Override verifier chunk size
  --help, -h                     Show this help`);
}

main().catch((err: unknown) => {
	console.error(
		`benchmark failed: ${err instanceof Error ? err.message : err}`,
	);
	process.exitCode = 1;
});
