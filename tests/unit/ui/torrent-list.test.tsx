import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { TorrentSummary } from "../../../src/transmission/types/torrent";
import { theme } from "../../../src/ui/theme";
import { TorrentList } from "../../../src/ui/torrent-list";

function torrent(overrides: Partial<TorrentSummary> = {}): TorrentSummary {
	return {
		id: 1,
		hash_string: "hash-1",
		name: "Example torrent",
		status: 4,
		percent_done: 0.52,
		rate_download: 1_572_864,
		rate_upload: 256,
		eta: 0,
		total_size: 1,
		is_finished: false,
		error: 0,
		error_string: "",
		...overrides,
	};
}

describe("TorrentList", () => {
	test("renders torrents in order with status, progress, and rates", async () => {
		const setup = await testRender(
			<TorrentList
				torrents={[
					torrent({ hash_string: "hash-1", name: "First torrent" }),
					torrent({
						hash_string: "hash-2",
						name: "Second torrent",
						status: 6,
					}),
				]}
			/>,
			{ width: 120, height: 4 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame.indexOf("First torrent")).toBeLessThan(
				frame.indexOf("Second torrent"),
			);
			expect(frame).toContain("Downloading");
			expect(frame).toContain("Seeding");
			expect(frame).toContain("━━━━━╸──── 52%");
			expect(frame).toContain("1.5 MiB/s");
			expect(frame).toContain("256 B/s");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("renders unknown and error statuses", async () => {
		const setup = await testRender(
			<TorrentList
				torrents={[
					torrent({ status: 99, name: "Unknown" }),
					torrent({
						hash_string: "hash-2",
						name: "Failed",
						error: 1,
						error_string: "Tracker unavailable",
					}),
					torrent({
						hash_string: "hash-3",
						name: "Failed without message",
						error: 1,
					}),
				]}
			/>,
			{ width: 120, height: 4 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("Status 99");
			expect(frame).toContain("Error: Tracker unavailable");
			const fallbackLine = frame
				.split("\n")
				.find((line) => line.includes("Failed without message"));
			expect(fallbackLine).toContain("Error");
			expect(fallbackLine).not.toContain("Error:");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("uses a compact label for queued states", async () => {
		const setup = await testRender(
			<TorrentList
				torrents={[
					torrent({
						hash_string: "hash-1",
						name: "Verify",
						status: 1,
					}),
					torrent({
						hash_string: "hash-2",
						name: "Download",
						status: 3,
					}),
					torrent({ hash_string: "hash-3", name: "Seed", status: 5 }),
				]}
			/>,
			{ width: 120, height: 4 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			const queuedLines = frame
				.split("\n")
				.filter((line) => line.includes("Queued"));

			expect(queuedLines).toHaveLength(3);
			expect(frame).not.toContain("Queued to");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("uses compact progress and hides rates below the width threshold", async () => {
		const setup = await testRender(<TorrentList torrents={[torrent()]} />, {
			width: 59,
			height: 3,
		});

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("52%");
			expect(frame).not.toContain("━━━━");
			expect(frame).not.toContain("MiB/s");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("marks the selected row with the active left border", async () => {
		const setup = await testRender(
			<TorrentList
				torrents={[
					torrent({ hash_string: "hash-1", name: "First torrent" }),
					torrent({ hash_string: "hash-2", name: "Second torrent" }),
				]}
				selectedHash="hash-2"
			/>,
			{ width: 120, height: 4 },
		);

		try {
			await setup.renderOnce();
			const selectedLine = setup
				.captureCharFrame()
				.split("\n")
				.find((line) => line.includes("Second torrent"));
			const selectedSpanLine = setup
				.captureSpans()
				.lines.find((line) =>
					line.spans.some((span) =>
						span.text.includes("Second torrent"),
					),
				);
			const selectedBorder = selectedSpanLine?.spans.find((span) =>
				span.text.includes("│"),
			);

			expect(selectedLine?.includes("│")).toBe(true);
			expect(
				selectedBorder?.fg.equals(RGBA.fromHex(theme.borderActive)),
			).toBe(true);
			expect(
				selectedBorder?.bg.equals(
					RGBA.fromHex(theme.backgroundElement),
				),
			).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("renders the empty state", async () => {
		const setup = await testRender(<TorrentList torrents={[]} />, {
			width: 40,
			height: 4,
		});

		try {
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("No torrents");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
