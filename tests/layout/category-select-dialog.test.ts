import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { CategorySelectDialog } from "../../src/layout/category-select-dialog.ts";
import type { CategoryState } from "../../src/store/index.ts";
import type { LayoutDimensions } from "../../src/types/layout.ts";

const TEST_LAYOUT: LayoutDimensions = {
	terminal: { width: 80, height: 24 },
	sidebar: { x: 0, y: 0, width: 20, height: 23 },
	content: { x: 20, y: 0, width: 60, height: 23 },
	statusBar: { x: 0, y: 23, width: 80, height: 1 },
};

const CATEGORIES: CategoryState[] = [
	{ id: "anime", name: "Anime", savePath: "/anime" },
	{ id: "linux", name: "Linux ISOs", savePath: null },
];

describe("CategorySelectDialog", () => {
	test("shows category choices with effective add paths", async () => {
		const { captureCharFrame, renderer, renderOnce } = await createTestRenderer(
			{
				width: 80,
				height: 24,
			},
		);
		try {
			const dialog = new CategorySelectDialog(renderer, TEST_LAYOUT);

			dialog.open({
				categories: [
					{
						id: "long",
						name: "Long Path",
						savePath: `${homedir()}/Downloads/torrents/really/long/category/path`,
					},
					...CATEGORIES,
				],
				defaultCategoryId: "anime",
				globalDownloadPath: `${homedir()}/Downloads`,
				mode: "add",
			});
			await renderOnce();

			const frame = captureCharFrame();
			expect(frame).toContain("Select category");
			expect(frame).toContain("None");
			expect(frame).toContain("~/Downloads");
			expect(frame).not.toContain(homedir());
			expect(frame).toContain("~/Downloads/…ategory/path");
			expect(frame).toContain("Long Path");
			expect(frame).toContain("Anime");
			expect(frame).toContain("/anime");
			expect(frame).toContain("Linux ISOs");
		} finally {
			renderer.destroy();
		}
	});

	test("n opens new category and b is consumed without browsing", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const dialog = new CategorySelectDialog(renderer, TEST_LAYOUT);
			let newCategoryCount = 0;
			let selected = "";
			dialog.onNewCategory = () => {
				newCategoryCount++;
			};
			dialog.onSelect = (category) => {
				selected = category?.id ?? "none";
			};

			dialog.open({
				categories: CATEGORIES,
				globalDownloadPath: "/downloads",
				mode: "add",
			});

			expect(dialog.handleInput(key("b"))).toBe(true);
			expect(newCategoryCount).toBe(0);
			expect(selected).toBe("");
			expect(dialog.getIsOpen()).toBe(true);

			expect(dialog.handleInput(key("n"))).toBe(true);
			expect(newCategoryCount).toBe(1);
			expect(dialog.getIsOpen()).toBe(true);
		} finally {
			renderer.destroy();
		}
	});
});

function key(name: string): KeyEvent {
	return {
		ctrl: false,
		eventType: "press",
		meta: false,
		name,
		option: false,
		repeated: false,
		sequence: name,
		shift: false,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as KeyEvent;
}
