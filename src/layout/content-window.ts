import { BoxRenderable, type CliRenderer } from "@opentui/core";
import type { Store } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { filterTorrents } from "../utils/filter";
import { DetailPanel, type DetailTab } from "./detail-panel";
import { TorrentTable } from "./torrent-view";

export type FocusArea = "sidebar" | "table" | "details";

export class ContentWindow {
	private renderer: CliRenderer;
	private store: Store;
	private layout: LayoutDimensions;
	private container: BoxRenderable;
	private tableFrame: BoxRenderable;
	private tableInner!: BoxRenderable;
	private torrentTable: TorrentTable;
	private detailPanel: DetailPanel;

	constructor(renderer: CliRenderer, store: Store, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.store = store;
		this.layout = layout;
		this.torrentTable = new TorrentTable(renderer, tableLayout(layout));
		this.detailPanel = new DetailPanel(renderer, detailLayout(layout));
		const built = this.build();
		this.container = built.container;
		this.tableFrame = built.tableFrame;
		this.renderer.root.add(this.container);
	}

	update(
		focusArea: FocusArea,
		selectedIndex: number,
		detailTab: DetailTab = "Pieces",
		detailScrollOffset = 0,
		filesTabCursor = -1,
	): void {
		const theme = getTheme();
		const state = this.store.getState();
		(this.tableFrame as unknown as { borderColor: string }).borderColor =
			focusArea === "table" ? theme.accent : theme.border;
		const visible = filterTorrents(state.torrents, {
			view: state.selectedView,
			searchQuery: state.searchQuery,
		});
		this.torrentTable.update(visible, selectedIndex, focusArea);
		const selectedTorrent =
			focusArea === "sidebar" ? null : (visible[selectedIndex] ?? null);
		const detailPlaceholder = resolveDetailPlaceholder(
			focusArea,
			state.torrents.length,
			visible.length,
			selectedTorrent !== null,
		);
		this.detailPanel.update(
			selectedTorrent,
			detailTab,
			focusArea === "details",
			detailScrollOffset,
			detailPlaceholder,
			filesTabCursor,
		);
	}

	getDetailBodyRowCount(): number {
		return this.detailPanel.getBodyRowCount();
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		(this.container as unknown as { left: number }).left = layout.content.x;
		(this.container as unknown as { top: number }).top = layout.content.y;
		(this.container as unknown as { width: number }).width =
			layout.content.width;
		(this.container as unknown as { height: number }).height =
			layout.content.height;

		const table = tableFrameLayout(layout);
		(this.tableFrame as unknown as { left: number }).left = table.content.x;
		(this.tableFrame as unknown as { top: number }).top = table.content.y;
		(this.tableFrame as unknown as { width: number }).width =
			table.content.width;
		(this.tableFrame as unknown as { height: number }).height =
			table.content.height;
		(this.tableInner as unknown as { width: number }).width =
			table.content.width - 2;
		(this.tableInner as unknown as { height: number }).height =
			table.content.height - 2;

		this.torrentTable.updateLayout(tableLayout(layout));
		this.detailPanel.updateLayout(detailLayout(layout));
	}

	private build(): { container: BoxRenderable; tableFrame: BoxRenderable } {
		const theme = getTheme();
		const layout = this.layout;
		const table = tableFrameLayout(layout);

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: layout.content.x,
			top: layout.content.y,
			width: layout.content.width,
			height: layout.content.height,
		});

		const tableFrame = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: table.content.x,
			top: table.content.y,
			width: table.content.width,
			height: table.content.height,
			border: true,
			borderColor: theme.border,
		});

		this.tableInner = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 1,
			top: 1,
			width: table.content.width - 2,
			height: table.content.height - 2,
		});
		this.tableInner.add(this.torrentTable.getContainer());
		tableFrame.add(this.tableInner);

		container.add(tableFrame);
		container.add(this.detailPanel.getContainer());

		return { container, tableFrame };
	}
}

function resolveDetailPlaceholder(
	focusArea: FocusArea,
	totalTorrents: number,
	visibleTorrents: number,
	hasSelectedTorrent: boolean,
): string | null {
	if (hasSelectedTorrent) return null;
	if (totalTorrents === 0) return "No torrents added yet";
	if (visibleTorrents === 0) return "Select a torrent to inspect details";
	if (focusArea === "sidebar") return "Select a torrent to inspect details";
	return "No torrent selected";
}

function tableLayout(layout: LayoutDimensions): LayoutDimensions {
	const frame = tableFrameLayout(layout);
	return {
		...layout,
		content: {
			x: 0,
			y: 0,
			width: frame.content.width - 2,
			height: frame.content.height - 2,
		},
	};
}

function detailLayout(layout: LayoutDimensions): LayoutDimensions {
	const detailHeight = getDetailHeight(layout.content.height);
	return {
		...layout,
		content: {
			x: 0,
			y: layout.content.height - detailHeight,
			width: layout.content.width,
			height: detailHeight,
		},
	};
}

function tableFrameLayout(layout: LayoutDimensions): LayoutDimensions {
	const detailHeight = getDetailHeight(layout.content.height);
	return {
		...layout,
		content: {
			x: 0,
			y: 0,
			width: layout.content.width,
			height: Math.max(5, layout.content.height - detailHeight),
		},
	};
}

function getDetailHeight(contentHeight: number): number {
	return Math.max(6, Math.min(10, Math.floor(contentHeight * 0.35)));
}
