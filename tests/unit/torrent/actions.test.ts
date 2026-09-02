import { describe, expect, test } from "bun:test";

import {
	addTorrent,
	removeTorrent,
	startTorrent,
	stopTorrent,
} from "../../../src/torrent/actions";
import { TransmissionClient } from "../../../src/transmission/client";
import type { TorrentList } from "../../../src/transmission/types/torrent";

const torrentList: TorrentList = { torrents: [] };

describe("torrent actions", () => {
	test("adds a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = new TransmissionClient();

		client.addTorrent = async (source) => {
			calls.push(`add:${source}`);
			return {
				torrent_added: {
					id: 1,
					hash_string: "abc123",
					name: "example.torrent",
				},
			};
		};
		client.listTorrents = async () => {
			calls.push("list");
			return torrentList;
		};

		const result = await addTorrent(client, "/tmp/example.torrent");

		expect(calls).toEqual(["add:/tmp/example.torrent", "list"]);
		expect(result).toEqual(torrentList);
	});

	test("starts a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = new TransmissionClient();

		client.startTorrent = async (torrentHash) => {
			calls.push(`start:${torrentHash}`);
		};
		client.listTorrents = async () => {
			calls.push("list");
			return torrentList;
		};

		const result = await startTorrent(client, "abc123");

		expect(calls).toEqual(["start:abc123", "list"]);
		expect(result).toEqual(torrentList);
	});

	test("stops a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = new TransmissionClient();

		client.stopTorrent = async (torrentHash) => {
			calls.push(`stop:${torrentHash}`);
		};
		client.listTorrents = async () => {
			calls.push("list");
			return torrentList;
		};

		const result = await stopTorrent(client, "abc123");

		expect(calls).toEqual(["stop:abc123", "list"]);
		expect(result).toEqual(torrentList);
	});

	test("removes a torrent before returning the latest list", async () => {
		const calls: string[] = [];
		const client = new TransmissionClient();

		client.removeTorrent = async (torrentHash) => {
			calls.push(`remove:${torrentHash}`);
		};
		client.listTorrents = async () => {
			calls.push("list");
			return torrentList;
		};

		const result = await removeTorrent(client, "abc123");

		expect(calls).toEqual(["remove:abc123", "list"]);
		expect(result).toEqual(torrentList);
	});

	// TODO: cover mutation and refresh failures after action behavior is finalized.
});
