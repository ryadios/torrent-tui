import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SHA1 } from "bun";
import { Downloader } from "../src/torrent/downloader.ts";
import { TorrentMetadata } from "../src/torrent/metadata.ts";
import type { BencodeValue } from "../src/torrent/parser.ts";
import { encode } from "../src/torrent/parser.ts";
import { StorageManager } from "../src/torrent/storage.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

async function main(): Promise<void> {
	const pieces = parseArg("--pieces=", 128);
	const pieceLength = parseArg("--piece-length=", MIB);
	const dir = mkdtempSync(join(tmpdir(), "torrent-tui-webseed-bench-"));
	try {
		const content = createContent(pieces, pieceLength);
		const metadata = createMetadata(content, pieces, pieceLength);
		const storage = new StorageManager(metadata, dir);
		await storage.setup();
		let requestCount = 0;
		const webSeedFetch = async (
			_url: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			requestCount++;
			const range = new Headers(init?.headers).get("range") ?? "";
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			if (!match) return new Response(null, { status: 416 });
			const start = Number(match[1]);
			const end = Number(match[2]);
			return new Response(content.slice(start, end + 1), { status: 206 });
		};
		const manager = { connections: new Map(), on: () => {} };
		const downloader = new Downloader(
			metadata,
			storage,
			manager as never,
			dir,
			{
				maxWebSeedConnections: 1,
				webSeedFetch,
				webSeeds: ["http://seed.example/payload.bin"],
			},
		);

		const started = performance.now();
		downloader.start();
		await waitFor(() => storage.downloadedCount === pieces);
		const elapsedMs = performance.now() - started;
		downloader.stop();

		const totalBytes = pieces * pieceLength;
		const seconds = elapsedMs / 1000;
		console.log("");
		console.log("webseed benchmark");
		console.log(`  pieces                ${pieces}`);
		console.log(`  piece length          ${formatBytes(pieceLength)}`);
		console.log(`  total size            ${formatBytes(totalBytes)}`);
		console.log(`  elapsed ms            ${elapsedMs.toFixed(1)}`);
		console.log(`  requests              ${requestCount}`);
		console.log(`  pieces/sec            ${(pieces / seconds).toFixed(2)}`);
		console.log(
			`  MiB/sec               ${(totalBytes / MIB / seconds).toFixed(2)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function createContent(pieces: number, pieceLength: number): Uint8Array {
	const path = join(tmpdir(), `torrent-tui-webseed-content-${process.pid}`);
	const fd = openSync(path, "w+");
	const out = new Uint8Array(pieces * pieceLength);
	try {
		for (let piece = 0; piece < pieces; piece++) {
			const data = deterministicPiece(piece, pieceLength);
			out.set(data, piece * pieceLength);
			writeSync(fd, data);
		}
	} finally {
		closeSync(fd);
		rmSync(path, { force: true });
	}
	return out;
}

function createMetadata(
	content: Uint8Array,
	pieces: number,
	pieceLength: number,
): TorrentMetadata {
	const hashes: Uint8Array[] = [];
	for (let i = 0; i < pieces; i++) {
		const start = i * pieceLength;
		hashes.push(
			new SHA1()
				.update(content.slice(start, start + pieceLength))
				.digest() as unknown as Uint8Array,
		);
	}
	const info: { [key: string]: BencodeValue } = {
		length: content.length,
		name: "payload.bin",
		"piece length": pieceLength,
		pieces: concatBytes(hashes),
	};
	const torrent = {
		announce: "http://tracker.example/announce",
		info,
		"url-list": "http://seed.example/payload.bin",
	};
	return new TorrentMetadata(torrent, encode(torrent));
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

function parseArg(prefix: string, fallback: number): number {
	for (const arg of process.argv.slice(2)) {
		if (!arg.startsWith(prefix)) continue;
		const parsed = Number(arg.slice(prefix.length));
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new Error(`${prefix} requires a positive integer`);
		}
		return parsed;
	}
	return fallback;
}

async function waitFor(fn: () => boolean, timeoutMs = 30_000): Promise<void> {
	const started = Date.now();
	while (!fn()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
	if (bytes >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
	return `${bytes} B`;
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
