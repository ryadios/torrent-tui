import { describe, expect, test } from "bun:test";
import { buildSidebarSelectableItems } from "../../src/layout/sidebar.ts";

describe("sidebar rows", () => {
	test("shows only status filters", () => {
		const items = buildSidebarSelectableItems();

		expect(items.map((item) => item.label)).toEqual([
			"All",
			"Downloading",
			"Paused",
			"Seeding",
			"Completed",
			"Stopped",
		]);
		expect(items.every((item) => item.label === item.selectedView)).toBe(true);
	});

	test("status rows select matching status views", () => {
		const items = buildSidebarSelectableItems();

		expect(items.find((item) => item.label === "Stopped")).toMatchObject({
			selectedView: "Stopped",
		});
		expect(items.find((item) => item.label === "Anime")).toBeUndefined();
	});
});
