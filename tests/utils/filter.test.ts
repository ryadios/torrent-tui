import { describe, expect, test } from "bun:test";
import type { TorrentState } from "../../src/store/index.ts";
import { filterTorrents } from "../../src/utils/filter.ts";

function torrent(
	id: string,
	name: string,
	status: TorrentState["status"],
	categoryId: string | null,
): TorrentState {
	return {
		id,
		name,
		categoryId,
		categoryName: categoryId ? categoryId : null,
		savePath: "/downloads",
		targetPath: `/downloads/${name}`,
		totalSize: 1,
		pieceLength: 1,
		downloadedPieces: 0,
		totalPieces: 1,
		status,
		downloadBps: 0,
		uploadBps: 0,
		peers: 0,
		seeds: 0,
		leechers: 0,
		peerDetails: [],
		files: [],
		etaSeconds: null,
	};
}

describe("filterTorrents", () => {
	const torrents = [
		torrent("1", "Anime Movie", "downloading", "anime"),
		torrent("2", "Linux ISO", "seeding", null),
		torrent("3", "Anime OVA", "paused", "anime"),
	];

	test("composes status and name search", () => {
		const result = filterTorrents(torrents, {
			searchQuery: "movie",
			view: "Downloading",
		});

		expect(result.map((t) => t.id)).toEqual(["1"]);
	});

	test("keeps legacy string view filtering", () => {
		const result = filterTorrents(torrents, "Downloading");

		expect(result.map((t) => t.id)).toEqual(["1"]);
	});

	test("does not filter uncategorized torrents", () => {
		const result = filterTorrents(torrents, {
			view: "All",
		});

		expect(result.map((t) => t.id)).toEqual(["1", "2", "3"]);
	});

	test("keeps search name-only", () => {
		const result = filterTorrents(torrents, {
			searchQuery: "anime",
			view: "All",
		});

		expect(result.map((t) => t.id)).toEqual(["1", "3"]);
	});
});
