import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ProgressBar } from "../../../src/ui/progress-bar";

describe("ProgressBar", () => {
	test("renders a ten-cell progress rule", async () => {
		const setup = await testRender(<ProgressBar percentDone={0.52} />, {
			width: 30,
			height: 1,
		});

		try {
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("━━━━━╸──── 52%");
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
