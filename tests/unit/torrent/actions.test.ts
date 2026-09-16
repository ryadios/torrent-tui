import { describe, expect, test } from "bun:test";

import {
	addTorrent,
	removeTorrent,
	startTorrent,
	stopTorrent,
	type TorrentOperations,
} from "../../../src/torrent/actions";
import type {
	TorrentAddResult,
	TorrentList,
} from "../../../src/transmission/types/torrent";

const torrentList: TorrentList = { torrents: [] };
const addedResult: TorrentAddResult = {
	torrent_added: {
		id: 1,
		hash_string: "abc123",
		name: "example.torrent",
	},
};

function makeClient(
	overrides: Partial<TorrentOperations> = {},
): TorrentOperations {
	return {
		listTorrents: async () => torrentList,
		addTorrent: async () => addedResult,
		startTorrent: async () => {},
		stopTorrent: async () => {},
		removeTorrent: async () => {},
		...overrides,
	};
}

describe("torrent actions", () => {
	test("adds a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = makeClient({
			addTorrent: async (source) => {
				calls.push(`add:${JSON.stringify(source)}`);
				return addedResult;
			},
			listTorrents: async () => {
				calls.push("list");
				return torrentList;
			},
		});

		const result = await addTorrent(client, "magnet:?xt=urn:btih:abc123");

		expect(calls).toEqual([
			'add:{"filename":"magnet:?xt=urn:btih:abc123"}',
			"list",
		]);
		expect(result).toEqual({
			status: "refreshed",
			torrents: torrentList,
			addResult: addedResult,
		});
	});

	test("preserves a duplicate add result", async () => {
		const duplicateResult: TorrentAddResult = {
			torrent_duplicate: addedResult.torrent_added,
		};
		const client = makeClient({
			addTorrent: async () => duplicateResult,
		});

		const result = await addTorrent(client, "magnet:?xt=urn:btih:abc123");

		expect(result).toEqual({
			status: "refreshed",
			torrents: torrentList,
			addResult: duplicateResult,
		});
	});

	test("preserves the add result when the follow-up refresh fails", async () => {
		const refreshError = new Error("refresh unavailable");
		const client = makeClient({
			listTorrents: async () => {
				throw refreshError;
			},
		});

		await expect(
			addTorrent(client, "magnet:?xt=urn:btih:abc123"),
		).resolves.toEqual({
			status: "refresh-failed",
			error: refreshError,
			addResult: addedResult,
		});
	});

	test("starts a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = makeClient({
			startTorrent: async (torrentHash) => {
				calls.push(`start:${torrentHash}`);
			},
			listTorrents: async () => {
				calls.push("list");
				return torrentList;
			},
		});

		const result = await startTorrent(client, "abc123");

		expect(calls).toEqual(["start:abc123", "list"]);
		expect(result).toEqual({
			status: "refreshed",
			torrents: torrentList,
		});
	});

	test("stops a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = makeClient({
			stopTorrent: async (torrentHash) => {
				calls.push(`stop:${torrentHash}`);
			},
			listTorrents: async () => {
				calls.push("list");
				return torrentList;
			},
		});

		const result = await stopTorrent(client, "abc123");

		expect(calls).toEqual(["stop:abc123", "list"]);
		expect(result).toEqual({
			status: "refreshed",
			torrents: torrentList,
		});
	});

	test("removes a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = makeClient({
			removeTorrent: async (torrentHash) => {
				calls.push(`remove:${torrentHash}`);
			},
			listTorrents: async () => {
				calls.push("list");
				return torrentList;
			},
		});

		const result = await removeTorrent(client, "abc123");

		expect(calls).toEqual(["remove:abc123", "list"]);
		expect(result).toEqual({
			status: "refreshed",
			torrents: torrentList,
		});
	});

	test("returns a refresh failure after a successful mutation", async () => {
		const refreshError = new Error("refresh unavailable");
		const client = makeClient({
			listTorrents: async () => {
				throw refreshError;
			},
		});

		await expect(startTorrent(client, "abc123")).resolves.toEqual({
			status: "refresh-failed",
			error: refreshError,
		});
	});

	test("rejects a mutation failure without refreshing", async () => {
		const client = makeClient({
			startTorrent: async () => {
				throw new Error("start failed");
			},
		});

		await expect(startTorrent(client, "abc123")).rejects.toThrow(
			"start failed",
		);
	});

	test("rejects an empty add source before calling the client", async () => {
		let called = false;
		const client = makeClient({
			addTorrent: async () => {
				called = true;
				return addedResult;
			},
		});

		await expect(addTorrent(client, "  ")).rejects.toThrow(
			"Torrent source is required",
		);
		expect(called).toBe(false);
	});
});
