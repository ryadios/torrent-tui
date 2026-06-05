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
