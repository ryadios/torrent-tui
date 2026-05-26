import { BoxRenderable, type CliRenderer } from "@opentui/core";
import type { Store } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { TorrentTable } from "./torrent-view";

function innerLayout(layout: LayoutDimensions): LayoutDimensions {
	return {
		...layout,
		content: {
			...layout.content,
			width: layout.content.width - 2,
			height: layout.content.height - 2,
		},
	};
}

export class ContentWindow {
	private renderer: CliRenderer;
	private store: Store;
	private layout: LayoutDimensions;
	private container: BoxRenderable;
	private torrentTable: TorrentTable;

	constructor(renderer: CliRenderer, store: Store, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.store = store;
		this.layout = layout;
		this.torrentTable = new TorrentTable(renderer, innerLayout(layout));
		this.container = this.build();
		this.renderer.root.add(this.container);
	}

	update(focusArea: "sidebar" | "table"): void {
		const state = this.store.getState();
		this.torrentTable.update(state.torrent, focusArea);
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		(this.container as unknown as { left: number }).left = layout.content.x;
		(this.container as unknown as { top: number }).top = layout.content.y;
		(this.container as unknown as { width: number }).width = layout.content.width;
		(this.container as unknown as { height: number }).height = layout.content.height;
		this.torrentTable.updateLayout(innerLayout(layout));
	}

	private build(): BoxRenderable {
		const theme = getTheme();
		const layout = this.layout;

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: layout.content.x,
			top: layout.content.y,
			width: layout.content.width,
			height: layout.content.height,
			border: true,
			borderColor: theme.border,
		});

		// Inner wrapper offset by 1 on each side to sit inside the border
		const inner = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 1,
			top: 1,
			width: layout.content.width - 2,
			height: layout.content.height - 2,
		});
		inner.add(this.torrentTable.getContainer());
		container.add(inner);

		return container;
	}
}
