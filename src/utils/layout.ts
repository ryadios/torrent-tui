import { SIDEBAR_WIDTH } from "../constants";
import type { LayoutDimensions } from "../types/layout";

export function calculateLayout(
	terminalWidth: number,
	terminalHeight: number,
): LayoutDimensions {
	return {
		terminal: { width: terminalWidth, height: terminalHeight },
		sidebar: {
			x: 0,
			y: 0,
			width: SIDEBAR_WIDTH,
			height: terminalHeight,
		},
		content: {
			x: SIDEBAR_WIDTH,
			y: 0,
			width: terminalWidth - SIDEBAR_WIDTH,
			height: terminalHeight,
		},
	};
}
