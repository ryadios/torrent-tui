import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import * as torrentBrowser from "../../../src/ui/torrent-browser";
import type { TorrentPathSuggestion } from "../../../src/ui/torrent-paths";
import * as torrentPaths from "../../../src/ui/torrent-paths";

const requests: Array<{
	source: string;
	resolve: (items: TorrentPathSuggestion[]) => void;
	promise: Promise<TorrentPathSuggestion[]>;
}> = [];
let browserSelect: ((path: string) => void) | undefined;

import { AddDialog } from "../../../src/ui/add-dialog";

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
			onLoadDefaultLocation={async () => ({ path: "/downloads" })}
			onSubmit={() => {}}
			onClose={() => {}}
			onClearError={() => setError(undefined)}
		/>
	);
}

describe("AddDialog", () => {
	test("ignores stale path suggestions after the source changes", async () => {
		spyOn(torrentPaths, "listTorrentPathSuggestions").mockImplementation(
			(source) => {
				const request =
					Promise.withResolvers<TorrentPathSuggestion[]>();
				requests.push({ source, ...request });
				return request.promise;
			},
		);
		const setup = await testRender(
			<AddDialog
				pending={false}
				onLoadDefaultLocation={async () => ({ path: "/downloads" })}
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
		spyOn(torrentBrowser, "TorrentBrowser").mockImplementation((props) => {
			browserSelect = props.onSelect;
			return null;
		});
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

	test("reviews source and location, preserving both when going back", async () => {
		const location = Promise.withResolvers<{
			path: string;
			warning?: string;
		}>();
		const loadDefaultLocation = mock(() => location.promise);
		const submitted: Array<[string, string]> = [];
		const setup = await testRender(
			<AddDialog
				pending={false}
				onLoadDefaultLocation={loadDefaultLocation}
				onSubmit={(source, directory) => {
					submitted.push([source, directory]);
				}}
				onClose={() => {}}
				onClearError={() => {}}
			/>,
			{ width: 80, height: 20, kittyKeyboard: true },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				await setup.mockInput.typeText("magnet:?xt=urn:btih:abc123");
			});
			await setup.renderOnce();

			act(() => setup.mockInput.pressEnter());
			await setup.renderOnce();
			expect(loadDefaultLocation).toHaveBeenCalledTimes(1);
			expect(setup.captureCharFrame()).toContain(
				"Loading download location...",
			);

			await act(async () => {
				location.resolve({ path: "/transmission/Downloads" });
				await location.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Download location");
			expect(setup.captureCharFrame()).toContain(
				"/transmission/Downloads",
			);

			act(() => setup.mockInput.pressEscape());
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain(
				"magnet:?xt=urn:btih:abc123",
			);

			act(() => setup.mockInput.pressEnter());
			await setup.renderOnce();
			expect(loadDefaultLocation).toHaveBeenCalledTimes(1);
			act(() => setup.mockInput.pressEnter());
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Source");
			expect(setup.captureCharFrame()).toContain(
				"/transmission/Downloads",
			);

			act(() => setup.mockInput.pressEnter());
			await setup.renderOnce();
			expect(submitted).toEqual([
				["magnet:?xt=urn:btih:abc123", "/transmission/Downloads"],
			]);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
