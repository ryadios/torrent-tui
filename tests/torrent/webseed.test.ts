import { afterEach, describe, expect, test } from "bun:test";
import { Downloader } from "../../src/torrent/downloader.ts";
import { StorageManager } from "../../src/torrent/storage.ts";
import { bytes } from "../helpers/bytes.ts";
import { FakePeerManager } from "../helpers/fakes.ts";
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

	test("rejects web seeds that ignore range requests with 200 OK", async () => {
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
							return new Response(fixture.content, { status: 200 });
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

	test("downloads multi-file pieces from the matching web seed file URLs", async () => {
		await withIsolatedAppData(async () => {
			await withTempDir(async (dir) => {
				const fixture = multiFileTorrentFixture({
					files: [
						{ path: ["disc1", "a.txt"], content: bytes("abc") },
						{ path: ["disc1", "b.txt"], content: bytes("defgh") },
						{ path: ["c.txt"], content: bytes("ijkl") },
					],
					pieceLength: 5,
				});
				const fileContent = new Map<string, Uint8Array>([
					["http://seed.example/root/disc1/a.txt", bytes("abc")],
					["http://seed.example/root/disc1/b.txt", bytes("defgh")],
					["http://seed.example/root/c.txt", bytes("ijkl")],
				]);
				const requests: Array<{ range: string; url: string }> = [];
				const webSeedFetch = async (
					input: string | URL | Request,
					init?: RequestInit,
				): Promise<Response> => {
					const url = String(input);
					const range = new Headers(init?.headers).get("range") ?? "";
					requests.push({ range, url });
					const content = fileContent.get(url);
					const match = /^bytes=(\d+)-(\d+)$/.exec(range);
					if (!content || !match) return new Response(null, { status: 416 });
					const start = Number(match[1]);
					const end = Number(match[2]);
					return new Response(content.slice(start, end + 1), { status: 206 });
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
						webSeeds: ["http://seed.example/root"],
					},
				);
				startedDownloaders.push(downloader);
				downloader.start();

				await waitFor(() => storage.downloadedCount === 3);

				expect(storage.downloadedCount).toBe(3);
				expect(requests).toEqual([
					{ range: "bytes=0-2", url: "http://seed.example/root/disc1/a.txt" },
					{ range: "bytes=0-1", url: "http://seed.example/root/disc1/b.txt" },
					{ range: "bytes=2-4", url: "http://seed.example/root/disc1/b.txt" },
					{ range: "bytes=0-1", url: "http://seed.example/root/c.txt" },
					{ range: "bytes=2-3", url: "http://seed.example/root/c.txt" },
				]);
			});
		});
	});

	test("times out stuck web seed fetches and requeues the piece", async () => {
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
						webSeedFetch: () => {
							requests++;
							return new Promise<Response>(() => {});
						},
						webSeedTimeoutMs: 10,
						webSeeds: ["http://seed.example/sample.bin"],
					},
				);
				startedDownloaders.push(downloader);
				downloader.start();

				await waitFor(() => requests > 0);
				await new Promise((resolve) => setTimeout(resolve, 30));

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
