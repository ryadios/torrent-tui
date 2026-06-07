import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { CategoryManagerDialog } from "../../src/layout/category-manager-dialog.ts";
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

describe("CategoryManagerDialog", () => {
	test("renders category management actions", async () => {
		const { captureCharFrame, renderer, renderOnce } = await createTestRenderer(
			{
				width: 80,
				height: 24,
			},
		);
		try {
			const dialog = new CategoryManagerDialog(renderer, TEST_LAYOUT);

			dialog.open([
				{
					id: "long",
					name: "Long Path",
					savePath: ` ${homedir()}/Downloads/torrents/really/long/category/path `,
				},
				...CATEGORIES,
			]);
			await renderOnce();

			const frame = captureCharFrame();
			expect(frame).toContain("Manage categories");
			expect(frame).toContain("Long Path");
			expect(frame).not.toContain(homedir());
			expect(frame).toContain("~/Downloads/torr…ng/category/path");
			expect(frame).toContain("Anime");
			expect(frame).toContain("/anime");
			expect(frame).toContain("Linux ISOs");
			expect(frame).toContain("Enter/e edit");
			expect(frame).toContain("d delete");
		} finally {
			renderer.destroy();
		}
	});

	test("fires new edit and delete callbacks", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const dialog = new CategoryManagerDialog(renderer, TEST_LAYOUT);
			let newCount = 0;
			let edited = "";
			let deleted = "";
			dialog.onNew = () => {
				newCount++;
			};
			dialog.onEdit = (category) => {
				edited = category.id;
			};
			dialog.onDelete = (category) => {
				deleted = category.id;
			};

			dialog.open(CATEGORIES);
			dialog.handleInput(key("n"));
			dialog.handleInput(key("e"));
			dialog.handleInput(key("d"));

			expect(newCount).toBe(1);
			expect(edited).toBe("anime");
			expect(deleted).toBe("anime");
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
