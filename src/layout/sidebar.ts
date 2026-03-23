import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { APP_NAME, SIDEBAR_ITEMS } from "../constants";
import type { Store } from "../store";
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

	update(): void {
		const state = this.store.getState();
		const theme = getTheme();

		for (const item of this.itemTexts) {
			const itemName = this.getItemName(item.globalIndex);
			const isSelected = item.globalIndex === state.selectedIndex;
			(item.text as unknown as { content: string }).content =
				`${isSelected ? "> " : "  "}${itemName}`;
			(item.text as unknown as { fg: string }).fg = isSelected
				? theme.accent
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
		const _allItems = [...SIDEBAR_ITEMS.status, ...SIDEBAR_ITEMS.category];

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
			const globalIndex = i;
			const isSelected = globalIndex === state.selectedIndex;
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
			this.itemTexts.push({ text, globalIndex });
			yOffset += 1;
		}

		yOffset += 1;

		const categoryTitle = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 1,
			top: yOffset,
		});
		const categoryTitleText = new TextRenderable(this.renderer, {
			content: "Category",
			fg: theme.fgMuted,
		});
		categoryTitle.add(categoryTitleText);
		this.container.add(categoryTitle);
		yOffset += 2;

		for (let i = 0; i < SIDEBAR_ITEMS.category.length; i++) {
			const globalIndex = SIDEBAR_ITEMS.status.length + i;
			const isSelected = globalIndex === state.selectedIndex;
			const itemName = SIDEBAR_ITEMS.category[i];

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
			this.itemTexts.push({ text, globalIndex });
			yOffset += 1;
		}

		return this.container;
	}

	private getItemName(globalIndex: number): string {
		const statusLen = SIDEBAR_ITEMS.status.length;
		if (globalIndex < statusLen) {
			return SIDEBAR_ITEMS.status[globalIndex] ?? "";
		}
		return SIDEBAR_ITEMS.category[globalIndex - statusLen] ?? "";
	}
}
