import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/store/index.ts";
import { TorrentBridge } from "../../src/torrent/bridge.ts";
import { writeResumeData } from "../../src/torrent/resume.ts";
import { StorageManager } from "../../src/torrent/storage.ts";
import { splitPieces } from "../helpers/bytes.ts";
import { withIsolatedAppData, withTempDir } from "../helpers/temp.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

function createStore(): Store {
	return new Store({
		selectedIndex: 0,
		selectedView: "All",
		torrents: [],
		totalDownloadBps: 0,
		totalUploadBps: 0,
	});
}

describe("TorrentBridge categories and frozen save paths", () => {
	test("confirmAdd persists category and frozen save path", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				const savePath = join(dir, "anime");
				writeFileSync(torrentPath, fixture.raw);
				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: join(dir, "default"),
					torrentFolder: dir,
				});

				const prepared = await bridge.prepareAdd(torrentPath);
				await bridge.confirmAdd(prepared, {
					categoryId: "anime",
					categoryName: "Anime",
					savePath,
				});

				expect(store.getState().torrents[0]).toMatchObject({
					categoryId: "anime",
					categoryName: "Anime",
					savePath,
					targetPath: join(savePath, fixture.metadata.name),
				});

				const registry = JSON.parse(
					readFileSync(
						join(getXdgDataHome(), "torrent-tui", "session.json"),
						"utf-8",
					),
				);
				expect(registry.schemaVersion).toBe(2);
				expect(registry.torrents[0]).toMatchObject({
					categoryId: "anime",
					categoryName: "Anime",
					savePath,
				});
			});
		});
	});

	test("restore uses v2 saved path instead of global download path", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				const savePath = join(dir, "frozen");
				writeFileSync(torrentPath, fixture.raw);
				const storage = new StorageManager(fixture.metadata, savePath);
				await storage.setup();
				const firstPiece = splitPieces(
					fixture.content,
					fixture.metadata.pieceLength,
				)[0];
				if (!firstPiece) throw new Error("missing first piece");
				storage.writePieceSync(0, firstPiece);
				writeResumeData(fixture.metadata, savePath, [0]);
				writeRegistry(dir, torrentPath, savePath, "anime", "Anime");

				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: join(dir, "default"),
					torrentFolder: dir,
				});

				await bridge.restoreSession();

				expect(store.getState().torrents[0]).toMatchObject({
					categoryId: "anime",
					downloadedPieces: 1,
					savePath,
					status: "stopped",
				});
			});
		});
	});

	test("changing category does not mutate frozen save path", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				const savePath = join(dir, "frozen");
				writeFileSync(torrentPath, fixture.raw);
				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: join(dir, "default"),
					torrentFolder: dir,
				});
				const prepared = await bridge.prepareAdd(torrentPath);
				await bridge.confirmAdd(prepared, {
					categoryId: "anime",
					categoryName: "Anime",
					savePath,
				});
				const before = store.getState().torrents[0];
				if (!before) throw new Error("missing torrent state");

				bridge.setTorrentCategory(before.id, {
					id: "movies",
					name: "Movies",
				});

				expect(store.getState().torrents[0]).toMatchObject({
					categoryId: "movies",
					categoryName: "Movies",
					savePath: before.savePath,
					targetPath: before.targetPath,
				});
			});
		});
	});

	test("renaming category updates torrent category names only", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				const savePath = join(dir, "frozen");
				writeFileSync(torrentPath, fixture.raw);
				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: join(dir, "default"),
					torrentFolder: dir,
				});
				const prepared = await bridge.prepareAdd(torrentPath);
				await bridge.confirmAdd(prepared, {
					categoryId: "anime",
					categoryName: "Anime",
					savePath,
				});
				const before = store.getState().torrents[0];
				if (!before) throw new Error("missing torrent state");

				bridge.renameCategory("anime", "Animation");

				expect(store.getState().torrents[0]).toMatchObject({
					categoryId: "anime",
					categoryName: "Animation",
					savePath: before.savePath,
					targetPath: before.targetPath,
				});
			});
		});
	});

	test("clearing category uncategorizes torrents without moving files", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				const savePath = join(dir, "frozen");
				writeFileSync(torrentPath, fixture.raw);
				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: join(dir, "default"),
					torrentFolder: dir,
				});
				const prepared = await bridge.prepareAdd(torrentPath);
				await bridge.confirmAdd(prepared, {
					categoryId: "anime",
					categoryName: "Anime",
					savePath,
				});
				const before = store.getState().torrents[0];
				if (!before) throw new Error("missing torrent state");

				bridge.clearCategory("anime");

				expect(store.getState().torrents[0]).toMatchObject({
					categoryId: null,
					categoryName: null,
					savePath: before.savePath,
					targetPath: before.targetPath,
				});
			});
		});
	});

	test("v1 registry restore falls back to global download path", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				writeFileSync(torrentPath, fixture.raw);
				writeRegistry(dir, torrentPath, undefined, undefined, undefined, 1);
				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: dir,
					torrentFolder: dir,
				});

				await bridge.restoreSession();

				expect(store.getState().torrents[0]?.savePath).toBe(dir);
			});
		});
	});

	test("delete with files removes from frozen save path", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture();
				const torrentPath = join(dir, "fixture.torrent");
				const savePath = join(dir, "frozen");
				writeFileSync(torrentPath, fixture.raw);
				mkdirSync(savePath, { recursive: true });
				writeFileSync(join(savePath, fixture.metadata.name), fixture.content);
				const store = createStore();
				const bridge = new TorrentBridge(store, {
					downloadPath: join(dir, "default"),
					torrentFolder: dir,
				});
				const prepared = await bridge.prepareAdd(torrentPath);
				await bridge.confirmAdd(prepared, {
					categoryId: null,
					categoryName: null,
					savePath,
				});

				await bridge.removeTorrent(prepared.id, true);

				expect(existsSync(join(savePath, fixture.metadata.name))).toBe(false);
			});
		});
	});
});

function writeRegistry(
	_dir: string,
	torrentPath: string,
	savePath?: string,
	categoryId?: string,
	categoryName?: string,
	schemaVersion = 2,
): void {
	const fixture = singleFileTorrentFixture();
	const infoHash = Buffer.from(fixture.metadata.infoHash).toString("hex");
	const registryDir = join(getXdgDataHome(), "torrent-tui");
	mkdirSync(registryDir, { recursive: true });
	writeFileSync(
		join(registryDir, "session.json"),
		JSON.stringify({
			schemaVersion,
			torrents: [
				{
					infoHash,
					torrentPath,
					...(savePath ? { savePath } : {}),
					...(categoryId ? { categoryId } : {}),
					...(categoryName ? { categoryName } : {}),
				},
			],
		}),
	);
}

function getXdgDataHome(): string {
	const dataHome = process.env.XDG_DATA_HOME;
	if (!dataHome) throw new Error("XDG_DATA_HOME is not set");
	return dataHome;
}
