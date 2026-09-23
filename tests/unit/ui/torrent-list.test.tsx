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
		rate_download: 1_500_000,
		rate_upload: 256,
		eta: 180,
		total_size: 1_500_000,
		upload_ratio: 0.5,
		peers_connected: 4,
		is_finished: false,
		error: 0,
		error_string: "",
		...overrides,
	};
}

type RendererSetup = Awaited<ReturnType<typeof testRender>>;

async function renderFrame(setup: RendererSetup): Promise<void> {
	await act(async () => {
		await setup.renderOnce();
		await setup.flush({ maxPasses: 2 });
	});
}

describe("TorrentList", () => {
	test("renders one-line torrents with balanced columns", async () => {
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
			{ width: 120, height: 8 },
		);

		try {
			await renderFrame(setup);
			const frame = setup.captureCharFrame();
			const lines = frame.split("\n");
			const header = lines.find((line) => line.includes("Name"));
			const first = lines.find((line) => line.includes("First torrent"));
			const second = lines.find((line) =>
				line.includes("Second torrent"),
			);

			expect(frame.indexOf("First torrent")).toBeLessThan(
				frame.indexOf("Second torrent"),
			);
			expect(header).toContain("Status");
			expect(header).toContain("ETA");
			expect(header).toContain("Size");
			expect(header).toContain("Rate");
			expect(header).not.toContain("Download");
			expect(header).not.toContain("Upload");
			expect(header).not.toContain("Progress");
			expect(header).not.toContain("Ratio");
			expect(header).not.toContain("Peers");
			expect(first?.indexOf("First torrent")).toBe(
				header?.indexOf("Name"),
			);
			expect(first?.indexOf("Downloading")).toBe(
				header?.indexOf("Status"),
			);
			expect(first?.indexOf("3 min")).toBe(header?.indexOf("ETA"));
			expect(first?.indexOf("1.5 MB")).toBe(header?.indexOf("Size"));
			expect(first?.indexOf("↓")).toBe(header?.indexOf("Rate"));
			expect(first).toContain("↓ 1.5 MB/s ↑ 256 B/s");
			expect(second?.indexOf("Seeding")).toBe(header?.indexOf("Status"));
			expect(first).toContain("52%");
			expect(frame).toContain("Downloading");
			expect(frame).toContain("Seeding");
			expect(frame).toContain("1.5 MB/s");
			expect(frame).toContain("256 B/s");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("renders unknown and error statuses", async () => {
		const setup = await testRender(
			<TorrentList
				torrents={[
					torrent({
						status: 99,
						name: "Unrecognized",
						eta: -1,
						total_size: 0,
						upload_ratio: -1,
						peers_connected: 3,
					}),
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
			{ width: 120, height: 11 },
		);

		try {
			await renderFrame(setup);
			const frame = setup.captureCharFrame();
			const lines = frame.split("\n");
			const header = lines.find((line) => line.includes("Name"));
			const errored = lines.find((line) => line.includes("Erro"));
			const unknownStatus = lines.find((line) =>
				line.includes("Status 99"),
			);

			expect(frame).toContain("Status 99");
			expect(unknownStatus).toContain("—");
			expect(frame).toContain("0 B");
			expect(frame).not.toContain("Error: Tracker unavailable");
			expect(errored).toContain("Erro");
			expect(header).not.toContain("Progress");
			expect(header).not.toContain("Ratio");
			expect(header).not.toContain("Peers");
			const fallbackIndex = lines.findIndex((line) =>
				line.includes("Failed without message"),
			);
			const fallbackLine = lines[fallbackIndex];
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
			{ width: 120, height: 11 },
		);

		try {
			await renderFrame(setup);
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

	test("uses stable responsive columns", async () => {
		const setup = await testRender(<TorrentList torrents={[torrent()]} />, {
			width: 79,
			height: 5,
		});

		try {
			await renderFrame(setup);
			const frame = setup.captureCharFrame();
			const header = frame
				.split("\n")
				.find((line) => line.includes("Name"));

			expect(frame).toContain("52%");
			expect(header).toContain("Name");
			expect(header).toContain("Status");
			expect(header).toContain("Size");
			expect(header).not.toContain("Rate");
			expect(header).not.toContain("Download");
			expect(header).not.toContain("Upload");
			expect(header).not.toContain("Progress");
			expect(frame).toContain("52%");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("hides lower-priority columns at narrow widths", async () => {
		const setup = await testRender(<TorrentList torrents={[torrent()]} />, {
			width: 38,
			height: 5,
		});

		try {
			await renderFrame(setup);
			const frame = setup.captureCharFrame();
			expect(frame).not.toContain("Status");
			expect(frame).toContain("━━━ 52% ━━━━");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("truncates long torrent names at the end", async () => {
		const setup = await testRender(
			<TorrentList
				torrents={[
					torrent({
						name: "Prefix torrent name with a suffix that must not survive",
					}),
				]}
			/>,
			{ width: 120, height: 4 },
		);

		try {
			await renderFrame(setup);
			const frame = setup.captureCharFrame();
			const row = frame
				.split("\n")
				.find((line) => line.includes("Prefix torrent name"));

			expect(row).toContain("Prefix torrent name");
			expect(row).toContain("…");
			expect(row).not.toContain("suffix that must not survive");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("uses percentage-only output at very narrow widths", async () => {
		const setup = await testRender(<TorrentList torrents={[torrent()]} />, {
			width: 8,
			height: 6,
		});

		try {
			await renderFrame(setup);
			const frame = setup.captureCharFrame();
			expect(frame).not.toContain("Status");
			expect(frame).toContain("52%");
			expect(frame).not.toContain("━━━━━━━━");
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
			{ width: 120, height: 8 },
		);

		try {
			await renderFrame(setup);
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
			expect(selectedBorder?.fg.equals(RGBA.fromHex(theme.primary))).toBe(
				true,
			);
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
			await renderFrame(setup);
			expect(setup.captureCharFrame()).toContain("No torrents");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("keeps the full column layout when the list is empty", async () => {
		const setup = await testRender(<TorrentList torrents={[]} />, {
			width: 120,
			height: 4,
		});

		try {
			await renderFrame(setup);
			const header = setup
				.captureCharFrame()
				.split("\n")
				.find((line) => line.includes("Name"));

			expect(header).toContain("Status");
			expect(header).toContain("ETA");
			expect(header).toContain("Size");
			expect(header).toContain("Rate");
			expect(header).not.toContain("Download");
			expect(header).not.toContain("Upload");
			expect(header).not.toContain("Ratio");
			expect(header).not.toContain("Peers");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
