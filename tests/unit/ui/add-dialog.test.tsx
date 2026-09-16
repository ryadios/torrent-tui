import { afterEach, describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { TorrentPathSuggestion } from "../../../src/ui/torrent-paths";

const requests: Array<{
	source: string;
	resolve: (items: TorrentPathSuggestion[]) => void;
	promise: Promise<TorrentPathSuggestion[]>;
}> = [];
let browserSelect: ((path: string) => void) | undefined;

mock.module("../../../src/ui/torrent-paths", () => ({
	listTorrentPathSuggestions: (source: string) => {
		const request = Promise.withResolvers<TorrentPathSuggestion[]>();
		requests.push({ source, ...request });
		return request.promise;
	},
}));

mock.module("../../../src/ui/torrent-browser", () => ({
	TorrentBrowser: (props: { onSelect: (path: string) => void }) => {
		browserSelect = props.onSelect;
		return null;
	},
}));

const { AddDialog } = await import("../../../src/ui/add-dialog");

afterEach(() => {
	requests.length = 0;
	browserSelect = undefined;
	mock.restore();
});

function AddDialogHarness() {
	const [error, setError] = useState<string | undefined>(
		"Unable to add torrent",
	);

	return (
		<AddDialog
			pending={false}
			error={error}
			onSubmit={() => {}}
			onClose={() => {}}
			onClearError={() => setError(undefined)}
		/>
	);
}

describe("AddDialog", () => {
	test("ignores stale path suggestions after the source changes", async () => {
		const setup = await testRender(
			<AddDialog
				pending={false}
				onSubmit={() => {}}
				onClose={() => {}}
				onClearError={() => {}}
			/>,
			{ width: 80, height: 16, kittyKeyboard: true },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				await setup.mockInput.typeText("a");
			});
			await setup.renderOnce();
			await act(async () => {
				await setup.mockInput.typeText("b");
			});
			await setup.renderOnce();

			const first = requests.find((request) => request.source === "a");
			const second = requests.find((request) => request.source === "ab");
			expect(first).toBeDefined();
			expect(second).toBeDefined();

			await act(async () => {
				second?.resolve([
					{
						name: "fresh.torrent",
						path: "/fresh.torrent",
						kind: "file",
						value: "/fresh.torrent",
					},
				]);
				await second?.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("fresh.torrent");

			await act(async () => {
				first?.resolve([
					{
						name: "stale.torrent",
						path: "/stale.torrent",
						kind: "file",
						value: "/stale.torrent",
					},
				]);
				await first?.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("fresh.torrent");
			expect(setup.captureCharFrame()).not.toContain("stale.torrent");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("clears errors after selecting a browser path", async () => {
		const setup = await testRender(<AddDialogHarness />, {
			width: 80,
			height: 16,
			kittyKeyboard: true,
		});

		try {
			await setup.renderOnce();
			act(() => setup.mockInput.pressEnter());
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain(
				"Torrent source is required",
			);

			act(() => setup.mockInput.pressTab());
			await setup.renderOnce();
			act(() => setup.mockInput.pressEnter());
			await setup.renderOnce();
			expect(browserSelect).toBeDefined();

			act(() => browserSelect?.("/picked.torrent"));
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("/picked.torrent");
			expect(setup.captureCharFrame()).not.toContain(
				"Torrent source is required",
			);
			expect(setup.captureCharFrame()).not.toContain(
				"Unable to add torrent",
			);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
