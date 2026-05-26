import { SIDEBAR_WIDTH } from "../constants";
import type { LayoutDimensions } from "../types/layout";

const STATUS_BAR_HEIGHT = 1;

export function calculateLayout(
	terminalWidth: number,
	terminalHeight: number,
): LayoutDimensions {
	const contentHeight = terminalHeight - STATUS_BAR_HEIGHT;
	return {
		terminal: { width: terminalWidth, height: terminalHeight },
		sidebar: {
			x: 0,
			y: 0,
			width: SIDEBAR_WIDTH,
			height: contentHeight,
		},
		content: {
			x: SIDEBAR_WIDTH,
			y: 0,
			width: terminalWidth - SIDEBAR_WIDTH,
			height: contentHeight,
		},
		statusBar: {
			x: 0,
			y: contentHeight,
			width: terminalWidth,
			height: STATUS_BAR_HEIGHT,
		},
	};
}
