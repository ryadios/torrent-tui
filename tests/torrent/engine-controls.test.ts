import { afterEach, describe, expect, test } from "bun:test";
import { Downloader } from "../../src/torrent/downloader.ts";
import { PiecePicker } from "../../src/torrent/piece-picker.ts";
import {
	normalizeSelectedFileIndices,
	writeResumeData,
} from "../../src/torrent/resume.ts";
import { StorageManager } from "../../src/torrent/storage.ts";
import { splitPieces } from "../helpers/bytes.ts";
import { FakePeer, FakePeerManager } from "../helpers/fakes.ts";
import { withIsolatedAppData, withTempDir } from "../helpers/temp.ts";
import {
	multiFileTorrentFixture,
	singleFileTorrentFixture,
} from "../helpers/torrent-fixtures.ts";

const startedDownloaders: Downloader[] = [];

afterEach(() => {
	for (const downloader of startedDownloaders) downloader.stop();
	startedDownloaders.length = 0;
});

function startDownloader(downloader: Downloader): void {
	startedDownloaders.push(downloader);
	downloader.start();
}

// --- PiecePicker: isWanted filter ---

describe("PiecePicker file selection", () => {
	test("skips unwanted pieces in pick()", () => {
		const wanted = new Set([1, 2]);
		const picker = new PiecePicker(
			3,
			() => false,
			() => false,
			(i) => wanted.has(i),
		);
		const conn = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
		const picks = new Set<number>();
		for (let i = 0; i < 10; i++) {
			const p = picker.pick(conn.asConnection());
			if (p !== null) picks.add(p);
		}
		expect(picks.has(0)).toBe(false);
	});

	test("returns null when all pieces are unwanted", () => {
		const picker = new PiecePicker(
			3,
			() => false,
			() => false,
			() => false,
		);
		const conn = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
		expect(picker.pick(conn.asConnection())).toBeNull();
	});

	test("returns wanted pieces when some are already downloaded", () => {
		const downloaded = new Set([0]);
		const wanted = new Set([1, 2]);
		const picker = new PiecePicker(
			3,
			(i) => downloaded.has(i),
			() => false,
			(i) => wanted.has(i),
		);
		const conn = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
		const p = picker.pick(conn.asConnection());
		if (p === null) throw new Error("expected a wanted piece");
		expect(wanted.has(p)).toBe(true);
	});
});

// --- Wanted piece boundary calculation ---
// multiFileTorrentFixture default layout: "abc"(file0=3B) + "defgh"(file1=5B) + "ijkl"(file2=4B), pieceLength=5
//   piece 0 (bytes 0-4):  spans file0 (0-2) + file1 (3-7) → crosses both
//   piece 1 (bytes 5-9):  spans file1 (3-7) + file2 (8-11) → crosses both
//   piece 2 (bytes 10-11): only file2 (8-11)

describe("Downloader skippedFileIndices boundary", () => {
	test("piece entirely within a skipped file is not requested", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				// file0: 5 bytes (piece 0), file1: 5 bytes (piece 1), file2: 2 bytes (piece 2)
				const fixture = multiFileTorrentFixture({
					files: [
						{ path: ["f0.bin"], content: new TextEncoder().encode("aaaaa") },
						{ path: ["f1.bin"], content: new TextEncoder().encode("bbbbb") },
						{ path: ["f2.bin"], content: new TextEncoder().encode("cc") },
					],
					pieceLength: 5,
				});
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();

				// Skip file[0]: piece 0 is entirely in file[0] → should not be requested
				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
					{ skippedFileIndices: new Set([0]) },
				);

				startDownloader(downloader);

				const requestedPieces = new Set(peer.requests.map((r) => r.index));
				expect(requestedPieces.has(0)).toBe(false);
				expect(requestedPieces.has(1)).toBe(true);
			});
		});
	});

	test("piece crossing wanted+skipped file boundary is treated as wanted", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				// Default fixture: piece 2 is only file2; skip file2 → piece 2 unwanted
				// pieces 0 and 1 still overlap wanted files → still wanted
				const fixture = multiFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();

				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
					{ skippedFileIndices: new Set([2]) },
				);

				startDownloader(downloader);

				const requestedPieces = new Set(peer.requests.map((r) => r.index));
				expect(requestedPieces.has(0)).toBe(true);
				expect(requestedPieces.has(1)).toBe(true);
				expect(requestedPieces.has(2)).toBe(false);
			});
		});
	});

	test("no skipped files downloads all pieces", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = multiFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();

				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
				);

				startDownloader(downloader);

				const requestedPieces = new Set(peer.requests.map((r) => r.index));
				expect(requestedPieces.size).toBe(3);
			});
		});
	});
});

// --- Download speed limit ---

describe("Downloader download rate limit", () => {
	test("pipeline fills zero requests when download limit is exhausted", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();

				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
					{ downloadRateLimitBps: 1 }, // 1 byte/s — less than BLOCK_SIZE
				);

				startDownloader(downloader);

				// tokens = 1 < BLOCK_SIZE (16384), so no requests sent
				expect(peer.requests).toHaveLength(0);
			});
		});
	});

	test("unlimited download fills pipeline normally", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();

				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
					{ downloadRateLimitBps: 0 },
				);

				startDownloader(downloader);
				expect(peer.requests.length).toBeGreaterThan(0);
			});
		});
	});
});

// --- Resume round-trip with selectedFileIndices ---

describe("Resume file selection", () => {
	test("normalizeSelectedFileIndices returns null when stored is undefined", () => {
		expect(normalizeSelectedFileIndices(undefined, 3)).toBeNull();
	});

	test("normalizeSelectedFileIndices returns null when all files are selected", () => {
		expect(normalizeSelectedFileIndices([0, 1, 2], 3)).toBeNull();
	});

	test("normalizeSelectedFileIndices deduplicates before all-selected check", () => {
		expect(normalizeSelectedFileIndices([0, 0, 1], 3)).toEqual([0, 1]);
	});

	test("normalizeSelectedFileIndices returns subset when partial selection stored", () => {
		const result = normalizeSelectedFileIndices([0, 2], 3);
		expect(result).toEqual([0, 2]);
	});

	test("writeResumeData persists selectedFileIndices and they round-trip", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = multiFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const pieces = splitPieces(
					fixture.content,
					fixture.metadata.pieceLength,
				);
				for (let i = 0; i < pieces.length; i++) {
					const p = pieces[i];
					if (!p) throw new Error(`missing piece ${i}`);
					storage.writePieceSync(i, p);
				}

				writeResumeData(fixture.metadata, dir, [0, 1, 2], [0, 2]);

				const { readResumeData } = await import("../../src/torrent/resume.ts");
				const infoHash = Buffer.from(fixture.metadata.infoHash).toString("hex");
				const data = readResumeData(infoHash);

				expect(data?.selectedFileIndices).toEqual([0, 2]);
			});
		});
	});
});
