import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { AppState } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

function formatSpeed(bps: number): string {
	if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
	if (bps >= 1_000) return `${Math.round(bps / 1_000)} KB/s`;
	return `${bps} B/s`;
}

export class StatusBar {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable;
	private leftText: TextRenderable;
	private rightText: TextRenderable;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		const { container, leftText, rightText } = this.build();
		this.container = container;
		this.leftText = leftText;
		this.rightText = rightText;
		this.renderer.root.add(this.container);
	}

	update(state: AppState): void {
		const theme = getTheme();
		const dl = formatSpeed(state.totalDownloadBps);
		const ul = formatSpeed(state.totalUploadBps);
		const count = state.torrents.length;
		const status = count === 0 ? "idle" : `${count} torrent${count !== 1 ? "s" : ""}`;

		(this.leftText as unknown as { content: string }).content =
			` ↓ ${dl}  ↑ ${ul}  |  ${status}`;
		(this.leftText as unknown as { fg: string }).fg = theme.fgPrimary;

		(this.rightText as unknown as { content: string }).content =
			"Tab focus  Space pause  d del  D del+files  a add  q quit ";
		(this.rightText as unknown as { fg: string }).fg = theme.fgMuted;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		(this.container as unknown as { top: number }).top = layout.statusBar.y;
		(this.container as unknown as { width: number }).width = layout.statusBar.width;
	}

	private build(): { container: BoxRenderable; leftText: TextRenderable; rightText: TextRenderable } {
		const theme = getTheme();

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: this.layout.statusBar.x,
			top: this.layout.statusBar.y,
			width: this.layout.statusBar.width,
			height: this.layout.statusBar.height,
			flexDirection: "row",
			justifyContent: "space-between",
		});

		const leftText = new TextRenderable(this.renderer, {
			content: " ↓ 0 B/s  ↑ 0 B/s  |  idle",
			fg: theme.fgPrimary,
		});

		const rightText = new TextRenderable(this.renderer, {
			content: "j/k nav  a add  q quit ",
			fg: theme.fgMuted,
		});

		container.add(leftText);
		container.add(rightText);

		return { container, leftText, rightText };
	}
}
