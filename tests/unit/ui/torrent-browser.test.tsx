import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { theme } from "../../../src/ui/theme";
import { TorrentBrowser } from "../../../src/ui/torrent-browser";
import * as torrentPaths from "../../../src/ui/torrent-paths";

afterEach(() => mock.restore());

describe("TorrentBrowser", () => {
	test("uses Yazi navigation and reselects the departed folder on parent", async () => {
		const directoryResolution = Promise.withResolvers<string>();
		const reads: Array<{
			directory: string;
			resolve: (entries: torrentPaths.TorrentPathEntry[]) => void;
			promise: Promise<torrentPaths.TorrentPathEntry[]>;
		}> = [];
		spyOn(torrentPaths, "resolveBrowseDirectory").mockReturnValue(
			directoryResolution.promise,
		);
		spyOn(torrentPaths, "readTorrentDirectory").mockImplementation(
			(directory) => {
				const request =
					Promise.withResolvers<torrentPaths.TorrentPathEntry[]>();
				reads.push({ directory, ...request });
				return request.promise;
			},
		);
		const setup = await testRender(
			<TorrentBrowser
				source="/root"
				mode="source"
				onSelect={() => {}}
				onBack={() => {}}
			/>,
			{ width: 80, height: 16, kittyKeyboard: true },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				directoryResolution.resolve("/root");
				await directoryResolution.promise;
			});
			const rootRead = reads[0];
			expect(rootRead?.directory).toBe("/root");
			await act(async () => {
				rootRead?.resolve([
					{ name: "child", path: "/root/child", kind: "directory" },
				]);
				await rootRead?.promise;
			});
			await setup.renderOnce();

			const isFolderSelected = () => {
				const line = setup
					.captureSpans()
					.lines.find((candidate) =>
						candidate.spans.some((span) =>
							span.text.includes("child/"),
						),
					);
				return line?.spans.some(
					(span) =>
						span.text.includes("child/") &&
						span.fg.equals(RGBA.fromHex(theme.primary)),
				);
			};

			act(() => setup.mockInput.pressKey("j"));
			await setup.renderOnce();
			expect(isFolderSelected()).toBe(true);

			act(() => setup.mockInput.pressKey("l"));
			const childRead = reads[1];
			expect(childRead?.directory).toBe("/root/child");
			await act(async () => {
				childRead?.resolve([]);
				await childRead?.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("/root/child");

			act(() => setup.mockInput.pressKey("h"));
			const parentRead = reads[2];
			expect(parentRead?.directory).toBe("/root");
			await act(async () => {
				parentRead?.resolve([
					{ name: "child", path: "/root/child", kind: "directory" },
				]);
				await parentRead?.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("/root");
			expect(isFolderSelected()).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
