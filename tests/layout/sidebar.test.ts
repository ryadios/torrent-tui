import { describe, expect, test } from "bun:test";
import { buildSidebarSelectableItems } from "../../src/layout/sidebar.ts";
import type { AppState } from "../../src/store/index.ts";

describe("sidebar rows", () => {
	test("shows only status filters", () => {
		const state: AppState = {
			selectedIndex: 0,
			selectedView: "Downloading",
			searchQuery: "",
			categories: [{ id: "anime", name: "Anime", savePath: "/media/anime" }],
			torrents: [],
			totalDownloadBps: 0,
			totalUploadBps: 0,
		};

		expect(buildSidebarSelectableItems().map((item) => item.label)).toEqual([
			"All",
			"Downloading",
			"Paused",
			"Seeding",
			"Completed",
			"Stopped",
		]);
		expect(state.categories).toHaveLength(1);
	});

	test("status rows select matching status views", () => {
		const state: AppState = {
			selectedIndex: 0,
			selectedView: "Stopped",
			searchQuery: "",
			categories: [{ id: "anime", name: "Anime", savePath: "/media/anime" }],
			torrents: [],
			totalDownloadBps: 0,
			totalUploadBps: 0,
		};

		const items = buildSidebarSelectableItems();

		expect(items.find((item) => item.label === "Stopped")).toMatchObject({
			selectedView: "Stopped",
		});
		expect(items.find((item) => item.label === "Anime")).toBeUndefined();
		expect(state.selectedView).toBe("Stopped");
	});
});
