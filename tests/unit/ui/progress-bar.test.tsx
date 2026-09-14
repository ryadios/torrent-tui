import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ProgressBar } from "../../../src/ui/progress-bar";
import { theme } from "../../../src/ui/theme";

describe("ProgressBar", () => {
	test("renders a ten-cell progress rule", async () => {
		const setup = await testRender(<ProgressBar percentDone={0.52} />, {
			width: 30,
			height: 1,
		});

		try {
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("━━━━━━━━━━ 52%");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("distinguishes completed progress with the primary color", async () => {
		const setup = await testRender(<ProgressBar percentDone={0.52} />, {
			width: 30,
			height: 1,
		});

		try {
			await setup.renderOnce();
			const spans = setup.captureSpans().lines[0]?.spans ?? [];
			const completed = spans.find(
				(span) =>
					span.text === "━━━━━" &&
					span.fg.equals(RGBA.fromHex(theme.primary)),
			);
			const remaining = spans.find((span) =>
				span.text.includes("━━━━━ 52%"),
			);

			expect(completed?.fg.equals(RGBA.fromHex(theme.primary))).toBe(
				true,
			);
			expect(remaining?.fg.equals(RGBA.fromHex(theme.textMuted))).toBe(
				true,
			);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("clamps full progress and supports compact output", async () => {
		const setup = await testRender(
			<box>
				<ProgressBar percentDone={2} />
				<ProgressBar percentDone={-1} compact />
			</box>,
			{ width: 30, height: 2 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("━━━━━━━━━━ 100%");
			expect(frame).toContain("0%");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
