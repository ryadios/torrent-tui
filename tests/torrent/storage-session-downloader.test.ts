import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/store/index.ts";
import {
	deriveRuntimeStatus,
	normalizeRuntimeMetrics,
	TorrentBridge,
} from "../../src/torrent/bridge.ts";
import { Downloader } from "../../src/torrent/downloader.ts";
import {
	resumePathForInfoHash,
	writeResumeData,
} from "../../src/torrent/resume.ts";
import { TorrentSession } from "../../src/torrent/session.ts";
import {
	StorageManager,
	VerificationCancelledError,
} from "../../src/torrent/storage.ts";
import { getDataDir } from "../../src/utils/paths.ts";
import { splitPieces } from "../helpers/bytes.ts";
import { FakePeer, FakePeerManager } from "../helpers/fakes.ts";
import { withIsolatedAppData, withTempDir } from "../helpers/temp.ts";
import {
	multiFileTorrentFixture,
	singleFileTorrentFixture,
} from "../helpers/torrent-fixtures.ts";

describe("StorageManager", () => {
	test("creates sparse files and verifies missing pieces as absent", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture();
			const storage = new StorageManager(fixture.metadata, dir);

			const setup = await storage.setup();
			const summary = await storage.verifyAll({ tolerateMissing: true });

			expect(setup).toEqual({
				createdFiles: 1,
				existingFiles: 0,
				allFilesCreated: true,
			});
			expect(summary).toEqual({ valid: 0, missing: 3, corrupt: 0 });
			expect(storage.downloadedCount).toBe(0);
		});
	});

	test("writes and reads pieces that cross file boundaries", async () => {
		await withTempDir(async (dir) => {
			const fixture = multiFileTorrentFixture();
			const storage = new StorageManager(fixture.metadata, dir);
			await storage.setup();

			const pieces = splitPieces(fixture.content, fixture.metadata.pieceLength);
			for (let i = 0; i < pieces.length; i++) {
				const piece = pieces[i];
				if (!piece) throw new Error(`missing fixture piece ${i}`);
				storage.writePieceSync(i, piece);
			}

			expect(Buffer.from(storage.readPieceSync(0)).toString()).toBe("abcde");
			expect(Buffer.from(storage.readPieceSync(1)).toString()).toBe("fghij");
			expect(Buffer.from(storage.readPieceSync(2)).toString()).toBe("kl");
			expect(await storage.verifyPiece(1)).toBe(true);
			expect(storage.downloadedCount).toBe(3);
		});
	});

	test("classifies valid, corrupt, and missing pieces", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture();
			const storage = new StorageManager(fixture.metadata, dir);
			await storage.setup();
			const pieces = splitPieces(fixture.content, fixture.metadata.pieceLength);
			const first = pieces[0];
			if (!first) throw new Error("missing fixture piece");

			storage.writePieceSync(0, first);
			storage.writePieceSync(1, new Uint8Array([1, 2, 3, 4]));

			const progress: Array<[number, number, number, number]> = [];
			const summary = await storage.verifyAll({
				tolerateMissing: true,
				yieldEveryPieces: 1,
				yieldEveryMs: 0,
				onProgress: (checked, valid, missing, corrupt) => {
					progress.push([checked, valid, missing, corrupt]);
				},
			});

			expect(summary).toEqual({ valid: 1, missing: 1, corrupt: 1 });
			expect(progress.at(-1)).toEqual([3, 1, 1, 1]);
			expect(storage.downloadedCount).toBe(1);
			expect(Array.from(storage.getBitfield())).toEqual([0b10000000]);
		});
	});

	test("yields between verification chunks and can be cancelled", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture({
				content: patternedBytes(256 * 1024),
				pieceLength: 256 * 1024,
			});
			const storage = new StorageManager(fixture.metadata, dir);
			await storage.setup();
			storage.writePieceSync(0, fixture.content);

			const controller = new AbortController();
			setTimeout(() => controller.abort(), 0);

			await expect(
				storage.verifyAll({
					chunkSizeBytes: 1024,
					yieldEveryMs: 0,
					signal: controller.signal,
				}),
			).rejects.toBeInstanceOf(VerificationCancelledError);
			expect(storage.downloadedCount).toBe(0);
		});
	});

	test("reverification clears stale downloaded state for corrupt pieces", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture();
			const storage = new StorageManager(fixture.metadata, dir);
			await storage.setup();
			const pieces = splitPieces(fixture.content, fixture.metadata.pieceLength);
			const first = pieces[0];
			if (!first) throw new Error("missing fixture piece");

			storage.writePieceSync(0, first);
			expect((await storage.verifyAll()).valid).toBe(1);
			expect(storage.downloadedCount).toBe(1);

			storage.writePieceSync(0, new Uint8Array([9, 9, 9, 9]));
			const summary = await storage.verifyAll({ tolerateMissing: true });

			expect(summary).toEqual({ valid: 0, missing: 2, corrupt: 1 });
			expect(storage.downloadedCount).toBe(0);
		});
	});
});

describe("TorrentSession", () => {
	test("skips verification for newly created sparse files", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture();
			const session = new TorrentSession(fixture.metadata, dir);
			const statuses: string[] = [];
			let checkingEvents = 0;
			session.on("status", (next: string) => statuses.push(next));
			session.on("checking", () => checkingEvents++);

			await session.startWithOptions();

			expect(statuses).toEqual(["checking", "ready"]);
			expect(checkingEvents).toBe(0);
			expect(session.storage.downloadedCount).toBe(0);
		});
	});

	test("verifies existing files and emits checking progress", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture();
			const session = new TorrentSession(fixture.metadata, dir);
			await session.storage.setup();
			const first = splitPieces(
				fixture.content,
				fixture.metadata.pieceLength,
			)[0];
			if (!first) throw new Error("missing fixture piece");
			session.storage.writePieceSync(0, first);

			const events: Array<{ checked: number; total: number; valid: number }> =
				[];
			session.on(
				"checking",
				(checked: number, total: number, valid: number) => {
					events.push({ checked, total, valid });
				},
			);

			await session.startWithOptions({
				verifyYieldEveryPieces: 1,
				verifyYieldEveryMs: 0,
			});

			expect(events.length).toBe(3);
			expect(events.at(-1)).toEqual({ checked: 3, total: 3, valid: 1 });
			expect(session.status).toBe("ready");
			expect(session.storage.downloadedCount).toBe(1);
		});
	});

	test("cancelled verification transitions to stopped", async () => {
		await withTempDir(async (dir) => {
			const fixture = singleFileTorrentFixture({
				content: patternedBytes(256 * 1024),
				pieceLength: 256 * 1024,
			});
			const session = new TorrentSession(fixture.metadata, dir);
			await session.storage.setup();
			session.storage.writePieceSync(0, fixture.content);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 0);

			await expect(
				session.startWithOptions({
					verifyChunkSizeBytes: 1024,
					verifyYieldEveryMs: 0,
					signal: controller.signal,
				}),
			).rejects.toBeInstanceOf(VerificationCancelledError);

			expect(session.status).toBe("stopped");
			expect(session.storage.downloadedCount).toBe(0);
		});
	});
});

describe("TorrentBridge restore", () => {
	test("trusts matching resume fingerprints without startup verification", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const first = splitPieces(
					fixture.content,
					fixture.metadata.pieceLength,
				)[0];
				if (!first) throw new Error("missing fixture piece");
				storage.writePieceSync(0, first);
				writeResumeData(fixture.metadata, dir, [0]);
				const torrentPath = writeTorrentAndRegistry(
					dir,
					fixture.raw,
					fixture.metadata,
				);
				const store = createTestStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: dir,
					maxConnections: 50,
					torrentFolder: dir,
					downloadRateLimitBps: 0,
					uploadRateLimitBps: 0,
				});

				await bridge.restoreSession();

				expect(torrentPath.endsWith(".torrent")).toBe(true);
				expect(store.getState().torrents).toHaveLength(1);
				expect(store.getState().torrents[0]).toMatchObject({
					downloadedPieces: 1,
					status: "stopped",
					totalPieces: 3,
				});
			});
		});
	});

	test("queues stale resume data for background verification", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				writeLegacyResume(fixture.metadata, dir, [0, 1, 2]);
				writeTorrentAndRegistry(dir, fixture.raw, fixture.metadata);
				const store = createTestStore();
				const statuses: string[] = [];
				store.subscribe((state) => {
					const status = state.torrents[0]?.status;
					if (status) statuses.push(status);
				});
				const bridge = new TorrentBridge(store, {
					downloadPath: dir,
					maxConnections: 50,
					torrentFolder: dir,
					downloadRateLimitBps: 0,
					uploadRateLimitBps: 0,
				});

				await bridge.restoreSession();
				await waitFor(() => store.getState().torrents[0]?.status === "missing");

				expect(statuses).toContain("checking");
				expect(store.getState().torrents[0]).toMatchObject({
					downloadedPieces: 0,
					status: "missing",
					totalPieces: 3,
				});
			});
		});
	});

	test("reopening after payload deletion reports missing instead of error", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const pieces = splitPieces(
					fixture.content,
					fixture.metadata.pieceLength,
				);
				for (let i = 0; i < pieces.length; i++) {
					const piece = pieces[i];
					if (!piece) throw new Error(`missing fixture piece ${i}`);
					storage.writePieceSync(i, piece);
				}
				writeResumeData(
					fixture.metadata,
					dir,
					[0, 1, 2].slice(0, fixture.metadata.pieceCount),
				);
				rmSync(join(dir, fixture.metadata.files[0]?.path ?? ""), {
					force: true,
				});
				writeTorrentAndRegistry(dir, fixture.raw, fixture.metadata);

				const store = createTestStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: dir,
					maxConnections: 50,
					torrentFolder: dir,
					downloadRateLimitBps: 0,
					uploadRateLimitBps: 0,
				});

				await bridge.restoreSession();
				await waitFor(() => store.getState().torrents[0]?.status === "missing");

				expect(store.getState().torrents[0]).toMatchObject({
					downloadedPieces: 0,
					status: "missing",
					totalPieces: 3,
				});
			});
		});
	});
});

describe("Downloader", () => {
	test("pause prevents pipeline fills and resume starts requests", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				peer.amChoked = true;
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
				);

				downloader.start();
				downloader.pause();
				peer.amChoked = false;
				peer.emit("unchoke");
				expect(peer.requests).toHaveLength(0);

				downloader.resume();
				expect(peer.requests.length).toBeGreaterThan(0);
			});
		});
	});

	test("downloads all pieces, emits completion, and does not send cancel", async () => {
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
				);
				const pieces = splitPieces(
					fixture.content,
					fixture.metadata.pieceLength,
				);
				let completeCount = 0;
				const verified: number[] = [];
				downloader.on("complete", () => completeCount++);
				downloader.on("piece:verified", (index: number) =>
					verified.push(index),
				);

				downloader.start();
				for (const request of [...peer.requests]) {
					const piece = pieces[request.index];
					if (!piece) throw new Error(`missing fixture piece ${request.index}`);
					peer.emit(
						"piece",
						request.index,
						request.begin,
						piece.slice(request.begin, request.begin + request.length),
					);
				}

				expect(verified).toEqual([0, 1, 2]);
				expect(completeCount).toBe(1);
				expect(storage.downloadedCount).toBe(3);
				expect(peer.cancels).toEqual([]);
			});
		});
	});

	test("uses endgame duplicate requests and cancels redundant final blocks", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture({
					content: patternedBytes(40_000),
					pieceLength: 40_000,
				});
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const peerA = new FakePeer("127.0.0.1", 6001, new Set([0]));
				const peerB = new FakePeer("127.0.0.2", 6002, new Set([0]));
				const manager = new FakePeerManager([peerA, peerB]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
				);
				const piece = splitPieces(
					fixture.content,
					fixture.metadata.pieceLength,
				)[0];
				if (!piece) throw new Error("missing fixture piece");

				downloader.start();

				expect(peerA.requests).toHaveLength(3);
				expect(peerB.requests).toHaveLength(3);

				for (const request of [...peerA.requests]) {
					peerA.emit(
						"piece",
						request.index,
						request.begin,
						piece.slice(request.begin, request.begin + request.length),
					);
				}

				expect(storage.downloadedCount).toBe(1);
				expect(peerA.cancels).toEqual([]);
				expect(peerB.cancels).toHaveLength(3);

				const late = peerB.requests[0];
				if (!late) throw new Error("missing duplicate request");
				peerB.emit(
					"piece",
					late.index,
					late.begin,
					piece.slice(late.begin, late.begin + late.length),
				);

				expect(storage.downloadedCount).toBe(1);
			});
		});
	});

	test("stale resume entries do not mark missing pieces as downloaded", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const infoHash = Buffer.from(fixture.metadata.infoHash).toString("hex");
				const resumeDir = join(getDataDir(), "resume");
				mkdirSync(resumeDir, { recursive: true });
				writeFileSync(
					join(resumeDir, `${infoHash}.json`),
					JSON.stringify({
						schemaVersion: 1,
						infoHash,
						downloadPath: dir,
						downloadedPieces: [0, 1, 2],
						savedAt: 1,
					}),
					"utf-8",
				);
				const peer = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const manager = new FakePeerManager([peer]);
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					manager.asManager(),
					dir,
				);

				downloader.start();

				expect(storage.downloadedCount).toBe(0);
				expect(peer.requests.length).toBeGreaterThan(0);
			});
		});
	});

	test("multiple downloaders can request blocks concurrently", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixtureA = singleFileTorrentFixture({
					name: "a.bin",
					content: bytesOfLength(12),
				});
				const fixtureB = singleFileTorrentFixture({
					name: "b.bin",
					content: bytesOfLength(12, 77),
				});
				const storageA = new StorageManager(fixtureA.metadata, dir);
				const storageB = new StorageManager(fixtureB.metadata, dir);
				await storageA.setup();
				await storageB.setup();
				const peerA = new FakePeer("127.0.0.1", 6001, new Set([0, 1, 2]));
				const peerB = new FakePeer("127.0.0.2", 6002, new Set([0, 1, 2]));
				const downloaderA = new Downloader(
					fixtureA.metadata,
					storageA,
					new FakePeerManager([peerA]).asManager(),
					dir,
				);
				const downloaderB = new Downloader(
					fixtureB.metadata,
					storageB,
					new FakePeerManager([peerB]).asManager(),
					dir,
				);

				downloaderA.start();
				downloaderB.start();

				expect(peerA.requests.length).toBeGreaterThan(0);
				expect(peerB.requests.length).toBeGreaterThan(0);
			});
		});
	});
});

describe("TorrentBridge status derivation", () => {
	test("does not report downloading until transfer activity starts", () => {
		expect(deriveRuntimeStatus("downloading", 1, false, false)).toBe(
			"connecting",
		);
		expect(deriveRuntimeStatus("downloading", 1, false, true)).toBe(
			"downloading",
		);
		expect(deriveRuntimeStatus("downloading", 0, false, true)).toBe("stalled");
		expect(deriveRuntimeStatus("seeding", 0, false, true)).toBe("seeding");
		expect(deriveRuntimeStatus("downloading", 1, true, true)).toBe("paused");
	});

	test("clears stale transfer metrics when runtime status is not downloading", () => {
		expect(normalizeRuntimeMetrics("stalled", 2_200_000, 11, 577)).toEqual({
			downloadBps: 0,
			uploadBps: 0,
			etaSeconds: null,
		});
		expect(normalizeRuntimeMetrics("connecting", 2_200_000, 11, 577)).toEqual({
			downloadBps: 0,
			uploadBps: 0,
			etaSeconds: null,
		});
		expect(normalizeRuntimeMetrics("downloading", 2_200_000, 11, 577)).toEqual({
			downloadBps: 2_200_000,
			uploadBps: 11,
			etaSeconds: 577,
		});
		expect(normalizeRuntimeMetrics("seeding", 2_200_000, 11, 577)).toEqual({
			downloadBps: 0,
			uploadBps: 11,
			etaSeconds: null,
		});
	});
});

function patternedBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (i * 17 + 31) & 0xff;
	}
	return bytes;
}

function bytesOfLength(length: number, seed = 31): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (seed + i * 13) & 0xff;
	}
	return bytes;
}

function createTestStore(): Store {
	return new Store({
		selectedIndex: 0,
		selectedView: "All",
		torrents: [],
		totalDownloadBps: 0,
		totalUploadBps: 0,
	});
}

function writeTorrentAndRegistry(
	dir: string,
	raw: Uint8Array,
	metadata: { infoHash: Uint8Array },
): string {
	const torrentPath = join(dir, "fixture.torrent");
	writeFileSync(torrentPath, raw);
	const infoHash = Buffer.from(metadata.infoHash).toString("hex");
	const registryDir = getDataDir();
	mkdirSync(registryDir, { recursive: true });
	writeFileSync(
		join(registryDir, "session.json"),
		JSON.stringify({
			schemaVersion: 1,
			torrents: [{ infoHash, torrentPath }],
		}),
	);
	return torrentPath;
}

function writeLegacyResume(
	metadata: { infoHash: Uint8Array },
	downloadPath: string,
	downloadedPieces: number[],
): void {
	const infoHash = Buffer.from(metadata.infoHash).toString("hex");
	mkdirSync(join(getDataDir(), "resume"), { recursive: true });
	writeFileSync(
		resumePathForInfoHash(infoHash),
		JSON.stringify({
			schemaVersion: 1,
			infoHash,
			downloadPath,
			downloadedPieces,
			savedAt: 1,
		}),
	);
}

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	while (!fn()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
