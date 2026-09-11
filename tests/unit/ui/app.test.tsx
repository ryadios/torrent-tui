import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import packageJson from "../../../package.json" with { type: "json" };
import type { TorrentOperations } from "../../../src/torrent/actions";
import type {
	TorrentList,
	TorrentSummary,
} from "../../../src/transmission/types/torrent";
import { App } from "../../../src/ui/app";
import { theme } from "../../../src/ui/theme";

const operations: TorrentOperations = {
	listTorrents: () => new Promise(() => {}),
	addTorrent: async () => ({
		torrent_added: {
			id: 1,
			hash_string: "abc123",
			name: "example.torrent",
		},
	}),
	startTorrent: async () => {},
	stopTorrent: async () => {},
	removeTorrent: async () => {},
};

function withListRequest(
	listTorrents: TorrentOperations["listTorrents"],
): TorrentOperations {
	return { ...operations, listTorrents };
}

function torrent(hash: string, name: string): TorrentSummary {
	return {
		id: 1,
		hash_string: hash,
		name,
		status: 4,
		percent_done: 0.5,
		rate_download: 0,
		rate_upload: 0,
		eta: 0,
		total_size: 1,
		is_finished: false,
		error: 0,
		error_string: "",
	};
}

describe("App", () => {
	test("renders the normal shell", async () => {
		const setup = await testRender(
			<App operations={operations} onQuit={() => {}} />,
			{
				width: 80,
				height: 8,
			},
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			const titleLine = frame
				.split("\n")
				.find((line) => line.includes("List"));

			expect(frame).toContain("torrent-tui");
			expect(frame).toContain(`v${packageJson.version}`);
			expect(frame).toContain("( o.o )");
			expect(frame).toContain("Loading torrents...");
			expect(frame).toContain("q quit  ^c quit");
			expect(titleLine?.startsWith(" ┌")).toBe(true);
			expect(titleLine).toContain(" List ──┐");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("loads torrents once and selects the first row", async () => {
		const request = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					return request.promise;
				})}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 8 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({
					torrents: [
						torrent("hash-1", "First torrent"),
						torrent("hash-2", "Second torrent"),
					],
				});
				await request.promise;
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			const captured = setup.captureSpans();
			const activeBorder = RGBA.fromHex(theme.borderActive);
			const firstLine = captured.lines.find((line) =>
				line.spans.some((span) => span.text.includes("First torrent")),
			);
			const secondLine = captured.lines.find((line) =>
				line.spans.some((span) => span.text.includes("Second torrent")),
			);

			expect(listCalls).toBe(1);
			expect(frame.indexOf("First torrent")).toBeLessThan(
				frame.indexOf("Second torrent"),
			);
			expect(
				firstLine?.spans.some((span) => span.fg.equals(activeBorder)),
			).toBe(true);
			expect(
				secondLine?.spans.some((span) => span.fg.equals(activeBorder)),
			).toBe(false);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("renders the empty state after loading", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 80, height: 8 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({ torrents: [] });
				await request.promise;
			});
			await setup.renderOnce();

			expect(setup.captureCharFrame()).toContain("No torrents");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("shows a concise initial load error", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 80, height: 8 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.reject(new Error("private transport detail"));
				await request.promise.catch(() => {});
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			expect(frame).toContain("Unable to load torrents");
			expect(frame).not.toContain("private transport detail");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("hides the version in a medium terminal", async () => {
		const setup = await testRender(
			<App operations={operations} onQuit={() => {}} />,
			{ width: 59, height: 8 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("torrent-tui");
			expect(frame).not.toContain(`v${packageJson.version}`);
			expect(frame).toContain("q quit  ^c quit");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("keeps only the essential quit binding in a compact terminal", async () => {
		const setup = await testRender(
			<App operations={operations} onQuit={() => {}} />,
			{ width: 29, height: 8 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("torrent-tui");
			expect(frame).not.toContain(`v${packageJson.version}`);
			expect(frame).toContain("q quit");
			expect(frame).not.toContain("^c");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("calls onQuit when q is pressed", async () => {
		let quitCalls = 0;
		const setup = await testRender(
			<App
				operations={operations}
				onQuit={() => {
					quitCalls += 1;
				}}
			/>,
			{ width: 40, height: 8 },
		);

		try {
			await setup.renderOnce();
			setup.mockInput.pressKey("q");

			expect(quitCalls).toBe(1);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
