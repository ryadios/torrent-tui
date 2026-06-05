import { afterEach, describe, expect, test } from "bun:test";
import { Downloader } from "../../src/torrent/downloader.ts";
import { StorageManager } from "../../src/torrent/storage.ts";
import { FakePeerManager } from "../helpers/fakes.ts";
import { withIsolatedAppData, withTempDir } from "../helpers/temp.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

const startedDownloaders: Downloader[] = [];

afterEach(() => {
	for (const downloader of startedDownloaders) downloader.stop();
	startedDownloaders.length = 0;
});

describe("BEP 19 web seeds", () => {
	test("downloads and verifies pieces from an HTTP range seed", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture({ pieceLength: 4 });
				const requests: string[] = [];
				const webSeedFetch = async (
					_url: string | URL | Request,
					init?: RequestInit,
				) => {
					const headers = new Headers(init?.headers);
					const range = headers.get("range") ?? "";
					requests.push(range);
					const match = /^bytes=(\d+)-(\d+)$/.exec(range);
					if (!match) {
						return new Response(null, { status: 416 });
					}
					const start = Number(match[1]);
					const end = Number(match[2]);
					return new Response(fixture.content.slice(start, end + 1), {
						status: 206,
					});
				};
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					new FakePeerManager().asManager(),
					dir,
					{
						maxWebSeedConnections: 1,
						webSeedFetch,
						webSeeds: ["http://seed.example/sample.bin"],
					},
				);
				startedDownloaders.push(downloader);
				downloader.start();

				await waitFor(() => storage.downloadedCount === 3);

				expect(storage.downloadedCount).toBe(3);
				expect(requests).toEqual(["bytes=0-3", "bytes=4-7", "bytes=8-11"]);
			});
		});
	});

	test("quarantines web seeds that return hash-failing data", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = singleFileTorrentFixture({ pieceLength: 4 });
				let requests = 0;
				const storage = new StorageManager(fixture.metadata, dir);
				await storage.setup();
				const downloader = new Downloader(
					fixture.metadata,
					storage,
					new FakePeerManager().asManager(),
					dir,
					{
						maxWebSeedConnections: 1,
						webSeedFetch: async () => {
							requests++;
							return new Response(new Uint8Array([9, 9, 9, 9]), {
								status: 206,
							});
						},
						webSeeds: ["http://seed.example/sample.bin"],
					},
				);
				startedDownloaders.push(downloader);
				downloader.start();

				await waitFor(() => requests > 0);
				await new Promise((resolve) => setTimeout(resolve, 20));

				expect(storage.downloadedCount).toBe(0);
				expect(requests).toBe(1);
			});
		});
	});
});

async function waitFor(fn: () => boolean): Promise<void> {
	const started = Date.now();
	while (!fn()) {
		if (Date.now() - started > 2_000) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
