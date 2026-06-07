import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { DirectoryPickerDialog } from "../../src/layout/directory-picker-dialog.ts";
import type { LayoutDimensions } from "../../src/types/layout.ts";

const TEST_LAYOUT: LayoutDimensions = {
	terminal: { width: 80, height: 24 },
	sidebar: { x: 0, y: 0, width: 20, height: 23 },
	content: { x: 20, y: 0, width: 60, height: 23 },
	statusBar: { x: 0, y: 23, width: 80, height: 1 },
};

describe("DirectoryPickerDialog", () => {
	test("browses child directories and selects current directory", async () => {
		await withWorkspaceTempDir(async (dir) => {
			const child = join(dir, "Anime");
			mkdirSync(child);
			const { renderer } = await createTestRenderer({
				width: 80,
				height: 24,
			});
			try {
				const dialog = new DirectoryPickerDialog(renderer, TEST_LAYOUT);
				let selected = "";
				dialog.onSelect = (path) => {
					selected = path;
				};

				dialog.open(dir);
				dialog.handleInput(key("down"));
				dialog.handleInput(key("enter"));
				dialog.handleInput(key("space"));

				expect(selected).toBe(child);
			} finally {
				renderer.destroy();
			}
		});
	});

	test("starts at home when initial path is outside home", async () => {
		const { captureCharFrame, renderer, renderOnce } = await createTestRenderer(
			{
				width: 80,
				height: 24,
			},
		);
		try {
			const dialog = new DirectoryPickerDialog(renderer, TEST_LAYOUT);

			dialog.open("/tmp");
			await renderOnce();

			const frame = captureCharFrame();
			expect(frame).toContain(homedir());
			expect(frame).not.toContain("/tmp");
			expect(frame).not.toContain("..");
		} finally {
			renderer.destroy();
		}
	});

	test("rejects folder names that escape the current directory", async () => {
		await withWorkspaceTempDir(async (dir) => {
			const { captureCharFrame, renderer, renderOnce } =
				await createTestRenderer({
					width: 80,
					height: 24,
				});
			try {
				const dialog = new DirectoryPickerDialog(renderer, TEST_LAYOUT);

				dialog.open(dir);
				dialog.handleInput(key("n"));
				dialog.handleInput(key("."));
				dialog.handleInput(key("."));
				dialog.handleInput(key("enter"));
				await renderOnce();

				expect(captureCharFrame()).toContain(
					"Folder name cannot include path segments",
				);
			} finally {
				renderer.destroy();
			}
		});
	});
});

async function withWorkspaceTempDir<T>(
	fn: (dir: string) => T | Promise<T>,
): Promise<T> {
	const cwdFromHome = relative(homedir(), process.cwd());
	const base =
		cwdFromHome && !cwdFromHome.startsWith("..") && !isAbsolute(cwdFromHome)
			? join(homedir(), cwdFromHome)
			: homedir();
	const dir = mkdtempSync(join(base, ".directory-picker-test-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

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
