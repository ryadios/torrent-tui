import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { AppController } from "../../src/controllers/app-controller.ts";
import { AddTorrentDialog } from "../../src/layout/add-torrent-dialog.ts";
import { Store } from "../../src/store/index.ts";
import type { LayoutDimensions } from "../../src/types/layout.ts";
import { withTempDir } from "../helpers/temp.ts";

const TEST_LAYOUT: LayoutDimensions = {
	terminal: { width: 80, height: 24 },
	sidebar: { x: 0, y: 0, width: 20, height: 23 },
	content: { x: 20, y: 0, width: 60, height: 23 },
	statusBar: { x: 0, y: 23, width: 80, height: 1 },
};

function createNoopRenderable() {
	return {
		update: () => {},
		getDetailBodyRowCount: () => 10,
	};
}

async function setupDialog(torrentFolder: string) {
	const { captureCharFrame, renderer, mockInput, renderOnce } =
		await createTestRenderer({
			width: 80,
			height: 24,
		});
	const store = new Store({
		selectedIndex: 0,
		selectedView: "All",
		torrents: [],
		totalDownloadBps: 0,
		totalUploadBps: 0,
	});
	const addDialog = new AddTorrentDialog(renderer, TEST_LAYOUT, torrentFolder);
	const controller = new AppController(
		renderer,
		store,
		createNoopRenderable() as never,
		createNoopRenderable() as never,
		createNoopRenderable() as never,
		{
			handleInput: () => false,
			show: () => {},
		} as never,
	);
	let selected = "";
	addDialog.onSelect = (input) => {
		selected = input;
	};
	controller.onAddTorrent = () => addDialog.open();
	controller.onDialogClose = () => addDialog.close();
	controller.onDialogInput = (key) => addDialog.handleInput(key);
	controller.onDialogPaste = (event) => addDialog.handlePaste(event);
	controller.start();

	return {
		addDialog,
		captureCharFrame,
		controller,
		getSelected: () => selected,
		mockInput,
		renderOnce,
		renderer,
	};
}

describe("AddTorrentDialog", () => {
	test("accepts bracketed paste events through the controller path", async () => {
		await withTempDir(async (dir) => {
			const setup = await setupDialog(dir);
			try {
				const magnet =
					"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

				setup.mockInput.pressKey("a");
				await setup.mockInput.pasteBracketedText(magnet);
				setup.mockInput.pressEnter();

				expect(setup.getSelected()).toBe(magnet);
			} finally {
				setup.renderer.destroy();
			}
		});
	});

	test("accepts manually typed magnet links through OpenTUI input handling", async () => {
		await withTempDir(async (dir) => {
			const setup = await setupDialog(dir);
			try {
				const magnet =
					"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

				setup.mockInput.pressKey("a");
				setup.mockInput.pressTab(); // switch from Files tab to Magnet tab
				await setup.mockInput.typeText(magnet);
				setup.mockInput.pressEnter();

				expect(setup.getSelected()).toBe(magnet);
			} finally {
				setup.renderer.destroy();
			}
		});
	});

	test("opens on Files tab and navigates file list without tabbing first", async () => {
		await withTempDir(async (dir) => {
			const torrentDir = join(dir, "torrents");
			mkdirSync(torrentDir);
			writeFileSync(join(torrentDir, "a.torrent"), "");
			writeFileSync(join(torrentDir, "b.torrent"), "");
			const files = readdirSync(torrentDir)
				.filter((file) => file.endsWith(".torrent"))
				.map((file) => join(torrentDir, file));
			const secondFile = files[1];
			if (!secondFile) throw new Error("missing second torrent fixture");
			const setup = await setupDialog(torrentDir);
			try {
				setup.mockInput.pressKey("a"); // opens on Files tab
				setup.mockInput.pressKey("j"); // navigate down — no Tab needed
				setup.mockInput.pressEnter();

				expect(setup.getSelected()).toBe(secondFile);
			} finally {
				setup.renderer.destroy();
			}
		});
	});

	test("tab bar shows active tab with brackets and switches on Tab key", async () => {
		await withTempDir(async (dir) => {
			const setup = await setupDialog(dir);
			try {
				setup.mockInput.pressKey("a");
				await setup.renderOnce();
				const frameFiles = setup.captureCharFrame();
				expect(frameFiles).toContain("[Files]");
				expect(frameFiles).not.toContain("[Magnet]");

				setup.mockInput.pressTab();
				await setup.renderOnce();
				const frameMagnet = setup.captureCharFrame();
				expect(frameMagnet).toContain("[Magnet]");
				expect(frameMagnet).not.toContain("[Files]");
				expect(frameMagnet).toContain("Magnet:");
			} finally {
				setup.renderer.destroy();
			}
		});
	});

	test("wraps long pasted magnet links inside the dialog", async () => {
		await withTempDir(async (dir) => {
			const setup = await setupDialog(dir);
			try {
				const magnet = `magnet:?xt=urn:btih:${"a".repeat(80)}&dn=${"b".repeat(40)}`;

				setup.mockInput.pressKey("a");
				await setup.mockInput.pasteBracketedText(magnet);
				await setup.renderOnce();
				const frame = setup.captureCharFrame();
				const wrappedLines = frame
					.split("\n")
					.filter((line) => line.includes("aaaaaaaaaa"));

				expect(wrappedLines.length).toBeGreaterThan(1);
			} finally {
				setup.renderer.destroy();
			}
		});
	});

	test("removes the input frame when the dialog closes", async () => {
		await withTempDir(async (dir) => {
			const setup = await setupDialog(dir);
			try {
				setup.mockInput.pressKey("a");
				setup.addDialog.close();
				await setup.renderOnce();
				const frame = setup.captureCharFrame();

				expect(frame).not.toContain("Add Torrent");
				expect(frame).not.toContain("Magnet:");
			} finally {
				setup.renderer.destroy();
			}
		});
	});
});
