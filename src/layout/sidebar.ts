import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { APP_NAME, SIDEBAR_ITEMS } from "../constants";
import type { AppState, Store } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import type { FocusArea } from "./content-window";

interface SidebarItem {
	container: BoxRenderable;
	text: TextRenderable;
	globalIndex: number;
}

export interface SidebarSelectableItem {
	label: string;
	selectedView: string;
}

export class Sidebar {
	private renderer: CliRenderer;
	private store: Store;
	private container: BoxRenderable;
	private titleText: TextRenderable | null = null;
	private headingRows: BoxRenderable[] = [];
	private itemTexts: SidebarItem[] = [];
	private rowCount = 0;
	private layout: LayoutDimensions;

	constructor(renderer: CliRenderer, store: Store, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.store = store;
		this.layout = layout;
		this.container = this.build();
		this.renderer.root.add(this.container);
	}

	update(state?: AppState, focusArea: FocusArea = "sidebar"): void {
		const s = state ?? this.store.getState();
		const theme = getTheme();
		const sidebarActive = focusArea === "sidebar";
		const items = buildSidebarSelectableItems();
		if (items.length !== this.rowCount) this.rebuildItems();

		(this.container as unknown as { borderColor: string }).borderColor =
			sidebarActive ? theme.accent : theme.border;

		for (const item of this.itemTexts) {
			const itemName = items[item.globalIndex]?.label ?? "";
			const isSelected = item.globalIndex === s.selectedIndex;
			(item.text as unknown as { content: string }).content =
				`${isSelected && sidebarActive ? "> " : "  "}${itemName}`;
			(item.text as unknown as { fg: string }).fg = isSelected
				? sidebarActive
					? theme.accent
					: theme.fgSecondary
				: theme.fgPrimary;
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		this.container.width = layout.sidebar.width;
		this.container.height = layout.sidebar.height;
		this.rebuildItems();
	}

	private build(): BoxRenderable {
		const theme = getTheme();
		this.container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: this.layout.sidebar.x,
			top: this.layout.sidebar.y,
			width: this.layout.sidebar.width,
			height: this.layout.sidebar.height,
			border: true,
			borderColor: theme.border,
		});

		const titleBox = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 0,
			top: 0,
			width: this.layout.sidebar.width,
			paddingY: 1,
			paddingX: 1,
		});

		this.titleText = new TextRenderable(this.renderer, {
			content: APP_NAME,
			fg: theme.accent,
		});
		titleBox.add(this.titleText);
		this.container.add(titleBox);

		this.rebuildItems();

		return this.container;
	}

	private rebuildItems(): void {
		for (const heading of this.headingRows) heading.destroy();
		for (const item of this.itemTexts) item.container.destroy();
		this.headingRows = [];
		this.itemTexts = [];
		const theme = getTheme();
		let yOffset = 3;
		const statusTitle = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 1,
			top: yOffset,
		});
		const statusTitleText = new TextRenderable(this.renderer, {
			content: "Status",
			fg: theme.fgMuted,
		});
		statusTitle.add(statusTitleText);
		this.container.add(statusTitle);
		this.headingRows.push(statusTitle);
		yOffset += 2;

		for (let i = 0; i < SIDEBAR_ITEMS.status.length; i++) {
			const item = SIDEBAR_ITEMS.status[i];
			if (!item) continue;
			const isSelected = i === this.store.getState().selectedIndex;
			const itemBox = new BoxRenderable(this.renderer, {
				position: "absolute",
				left: 1,
				top: yOffset,
				width: this.layout.sidebar.width - 2,
			});
			const text = new TextRenderable(this.renderer, {
				content: `${isSelected ? "> " : "  "}${item}`,
				fg: isSelected ? theme.accent : theme.fgPrimary,
			});
			itemBox.add(text);
			this.container.add(itemBox);
			this.itemTexts.push({ container: itemBox, text, globalIndex: i });
			yOffset += 1;
		}
		this.rowCount = buildSidebarSelectableItems().length;
	}
}

export function buildSidebarSelectableItems(): SidebarSelectableItem[] {
	return SIDEBAR_ITEMS.status.map((status) => ({
		label: status,
		selectedView: status,
	}));
}
