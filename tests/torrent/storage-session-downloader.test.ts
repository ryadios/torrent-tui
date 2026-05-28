import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Downloader } from "../../src/torrent/downloader.ts";
import { TorrentSession } from "../../src/torrent/session.ts";
import { StorageManager } from "../../src/torrent/storage.ts";
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
});
