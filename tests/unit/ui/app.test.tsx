import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import packageJson from "../../../package.json" with { type: "json" };
import { App } from "../../../src/ui/app";

describe("App", () => {
	test("renders the normal shell", async () => {
		const setup = await testRender(<App onQuit={() => {}} />, {
			width: 80,
			height: 8,
		});

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			const titleLine = frame
				.split("\n")
				.find((line) => line.includes("List"));

			expect(frame).toContain("torrent-tui");
			expect(frame).toContain(`v${packageJson.version}`);
			expect(frame).toContain("No torrents");
			expect(frame).toContain("q quit  ^c quit");
			expect(titleLine?.startsWith(" ┌")).toBe(true);
			expect(titleLine).toContain(" List ──┐");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("hides the version in a medium terminal", async () => {
		const setup = await testRender(<App onQuit={() => {}} />, {
			width: 59,
			height: 8,
		});

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
		const setup = await testRender(<App onQuit={() => {}} />, {
			width: 29,
			height: 8,
		});

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
