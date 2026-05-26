import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { APP_NAME, SIDEBAR_ITEMS } from "../constants";
import type { AppState, Store } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

interface SidebarItem {
	text: TextRenderable;
	globalIndex: number;
}

export class Sidebar {
	private renderer: CliRenderer;
	private store: Store;
	private container: BoxRenderable;
	private titleText: TextRenderable | null = null;
	private itemTexts: SidebarItem[] = [];
	private layout: LayoutDimensions;

	constructor(renderer: CliRenderer, store: Store, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.store = store;
		this.layout = layout;
		this.container = this.build();
		this.renderer.root.add(this.container);
	}

	update(state?: AppState, focusArea: "sidebar" | "table" = "sidebar"): void {
		const s = state ?? this.store.getState();
		const theme = getTheme();
		const sidebarActive = focusArea === "sidebar";

		(this.container as unknown as { borderColor: string }).borderColor =
			sidebarActive ? theme.accent : theme.border;

		for (const item of this.itemTexts) {
			const itemName = SIDEBAR_ITEMS.status[item.globalIndex] ?? "";
			const isSelected = item.globalIndex === s.selectedIndex;
			(item.text as unknown as { content: string }).content =
				`${isSelected && sidebarActive ? "> " : "  "}${itemName}`;
			(item.text as unknown as { fg: string }).fg = isSelected
				? (sidebarActive ? theme.accent : theme.fgSecondary)
				: theme.fgPrimary;
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		this.container.width = layout.sidebar.width;
		this.container.height = layout.sidebar.height;
	}

	private build(): BoxRenderable {
		const theme = getTheme();
		const state = this.store.getState();

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
		yOffset += 2;

		for (let i = 0; i < SIDEBAR_ITEMS.status.length; i++) {
			const isSelected = i === state.selectedIndex;
			const itemName = SIDEBAR_ITEMS.status[i];

			const itemBox = new BoxRenderable(this.renderer, {
				position: "absolute",
				left: 1,
				top: yOffset,
			});

			const text = new TextRenderable(this.renderer, {
				content: `${isSelected ? "> " : "  "}${itemName}`,
				fg: isSelected ? theme.accent : theme.fgPrimary,
			});

			itemBox.add(text);
			this.container.add(itemBox);
			this.itemTexts.push({ text, globalIndex: i });
			yOffset += 1;
		}

		return this.container;
	}
}
