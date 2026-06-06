import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { AppController } from "../../src/controllers/app-controller.ts";
import { ConfirmDialog } from "../../src/layout/confirm-dialog.ts";
import { Store } from "../../src/store/index.ts";
import type { LayoutDimensions } from "../../src/types/layout.ts";

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

function createCountingRenderable() {
	let updateCount = 0;
	return {
		get updateCount() {
			return updateCount;
		},
		update: () => {
			updateCount++;
		},
		getDetailBodyRowCount: () => 10,
	};
}

describe("delete confirmation controller flow", () => {
	test("confirms delete-with-files on the first y keypress", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: [
					{
						id: "torrent-1",
						name: "sample",
						categoryId: null,
						categoryName: null,
						savePath: "/tmp",
						targetPath: "/tmp/sample",
						totalSize: 1,
						pieceLength: 1,
						downloadedPieces: 0,
						totalPieces: 1,
						status: "stopped",
						downloadBps: 0,
						uploadBps: 0,
						peers: 0,
						seeds: 0,
						leechers: 0,
						peerDetails: [],
						files: [],
						etaSeconds: null,
					},
				],
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
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
			controller.confirmDialog = new ConfirmDialog(renderer, TEST_LAYOUT);
			controller.focusArea = "table";

			const removals: Array<{ deleteFiles: boolean; id: string }> = [];
			controller.onRemoveTorrent = (id, deleteFiles) => {
				removals.push({ id, deleteFiles });
			};
			controller.start();

			callHandleKeyPress(controller, keyEvent("d", true));
			const confirmKey = keyEvent("y", false);
			callHandleKeyPress(controller, confirmKey);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(removals).toEqual([{ id: "torrent-1", deleteFiles: true }]);
			expect(confirmKey.prevented).toBe(true);
			expect(confirmKey.stopped).toBe(true);
			expect(controller.focusMode).toBe("global");
		} finally {
			renderer.destroy();
		}
	});

	test("dialog escape lets the app decide whether focus returns to global", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: [],
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
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
			let closeCount = 0;
			controller.focusMode = "dialog";
			controller.onDialogClose = () => {
				closeCount++;
			};

			const escapeKey = keyEvent("escape", false);
			callHandleKeyPress(controller, escapeKey);

			expect(closeCount).toBe(1);
			expect(controller.focusMode).toBe("dialog");
			expect(escapeKey.prevented).toBe(true);
			expect(escapeKey.stopped).toBe(true);
		} finally {
			renderer.destroy();
		}
	});

	test("m opens category manager only from sidebar focus", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: [],
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
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
			let manageCount = 0;
			controller.onManageCategories = () => {
				manageCount++;
			};
			controller.focusArea = "table";
			callHandleKeyPress(controller, keyEvent("m", false));
			controller.focusArea = "sidebar";
			callHandleKeyPress(controller, keyEvent("m", false));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(manageCount).toBe(1);
		} finally {
			renderer.destroy();
		}
	});

	test("coalesces repeated store updates into throttled renders", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: [],
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
			const sidebar = createCountingRenderable();
			const content = createCountingRenderable();
			const status = createCountingRenderable();
			const controller = new AppController(
				renderer,
				store,
				sidebar as never,
				content as never,
				status as never,
				{
					handleInput: () => false,
					show: () => {},
				} as never,
			);
			controller.start();
			const initialUpdates = content.updateCount;

			for (let i = 0; i < 20; i++) {
				store.setState({ totalDownloadBps: i });
			}

			expect(content.updateCount).toBe(initialUpdates);
			await new Promise((resolve) => setTimeout(resolve, 120));

			expect(sidebar.updateCount).toBe(initialUpdates + 1);
			expect(content.updateCount).toBe(initialUpdates + 1);
			expect(status.updateCount).toBe(initialUpdates + 1);
		} finally {
			renderer.destroy();
		}
	});

	test("coalesces tab spam into throttled renders", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: [],
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
			const sidebar = createCountingRenderable();
			const content = createCountingRenderable();
			const status = createCountingRenderable();
			const controller = new AppController(
				renderer,
				store,
				sidebar as never,
				content as never,
				status as never,
				{
					handleInput: () => false,
					show: () => {},
				} as never,
			);
			controller.start();
			const initialUpdates = content.updateCount;
			const firstKey = keyEvent("tab", false);

			callHandleKeyPress(controller, firstKey);
			for (let i = 0; i < 99; i++) {
				callHandleKeyPress(controller, keyEvent("tab", false));
			}

			expect(firstKey.prevented).toBe(true);
			expect(firstKey.stopped).toBe(true);
			expect(content.updateCount).toBe(initialUpdates);
			await new Promise((resolve) => setTimeout(resolve, 120));

			expect(sidebar.updateCount).toBe(initialUpdates + 1);
			expect(content.updateCount).toBe(initialUpdates + 1);
			expect(status.updateCount).toBe(initialUpdates + 1);
		} finally {
			renderer.destroy();
		}
	});

	test("coalesces table navigation spam into throttled renders", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: Array.from({ length: 200 }, (_, i) => ({
					id: `torrent-${i}`,
					name: `sample-${i}`,
					categoryId: null,
					categoryName: null,
					savePath: "/tmp",
					targetPath: `/tmp/sample-${i}`,
					totalSize: 1,
					pieceLength: 1,
					downloadedPieces: 0,
					totalPieces: 1,
					status: "stopped" as const,
					downloadBps: 0,
					uploadBps: 0,
					peers: 0,
					seeds: 0,
					leechers: 0,
					peerDetails: [],
					files: [],
					etaSeconds: null,
				})),
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
			const sidebar = createCountingRenderable();
			const content = createCountingRenderable();
			const status = createCountingRenderable();
			const controller = new AppController(
				renderer,
				store,
				sidebar as never,
				content as never,
				status as never,
				{
					handleInput: () => false,
					show: () => {},
				} as never,
			);
			controller.start();
			controller.focusArea = "table";
			const initialUpdates = content.updateCount;

			for (let i = 0; i < 100; i++) {
				callHandleKeyPress(controller, keyEvent("j", false));
			}

			expect(content.updateCount).toBe(initialUpdates);
			await new Promise((resolve) => setTimeout(resolve, 120));

			expect(sidebar.updateCount).toBe(initialUpdates + 1);
			expect(content.updateCount).toBe(initialUpdates + 1);
			expect(status.updateCount).toBe(initialUpdates + 1);
		} finally {
			renderer.destroy();
		}
	});

	test("cancels pending throttled renders when stopped", async () => {
		const { renderer } = await createTestRenderer({
			width: 80,
			height: 24,
		});
		try {
			const store = new Store({
				selectedIndex: 0,
				selectedView: "All",
				torrents: [],
				totalDownloadBps: 0,
				totalUploadBps: 0,
			});
			const sidebar = createCountingRenderable();
			const content = createCountingRenderable();
			const status = createCountingRenderable();
			const controller = new AppController(
				renderer,
				store,
				sidebar as never,
				content as never,
				status as never,
				{
					handleInput: () => false,
					show: () => {},
				} as never,
			);
			controller.start();
			const initialUpdates = content.updateCount;

			store.setState({ totalDownloadBps: 1 });
			controller.stop();
			await new Promise((resolve) => setTimeout(resolve, 120));

			expect(sidebar.updateCount).toBe(initialUpdates);
			expect(content.updateCount).toBe(initialUpdates);
			expect(status.updateCount).toBe(initialUpdates);
		} finally {
			renderer.destroy();
		}
	});
});

function callHandleKeyPress(
	controller: AppController,
	key: ReturnType<typeof keyEvent>,
): void {
	(
		controller as unknown as {
			handleKeyPress: (key: ReturnType<typeof keyEvent>) => void;
		}
	).handleKeyPress(key);
}

function keyEvent(
	name: string,
	shift: boolean,
): {
	name: string;
	preventDefault: () => void;
	prevented: boolean;
	shift: boolean;
	stopPropagation: () => void;
	stopped: boolean;
} {
	return {
		name,
		preventDefault() {
			this.prevented = true;
		},
		prevented: false,
		shift,
		stopPropagation() {
			this.stopped = true;
		},
		stopped: false,
	};
}
