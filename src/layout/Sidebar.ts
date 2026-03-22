import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { APP_NAME, SIDEBAR_ITEMS, SIDEBAR_WIDTH } from "../constants";
import type { Store } from "../store";
import { getTheme } from "../theme";

export class Sidebar {
	private renderer: CliRenderer;
	private store: Store;
	private container: BoxRenderable | null = null;

	constructor(renderer: CliRenderer, store: Store) {
		this.renderer = renderer;
		this.store = store;
	}

	update(): void {
		this.render();
	}

	render(): void {
		// Remove existing container if present
		if (this.container) {
			this.container.destroy();
		}

		this.container = this.build();
		this.renderer.root.add(this.container);
	}

	private build(): BoxRenderable {
		const theme = getTheme();
		const state = this.store.getState();
		const statusItems = SIDEBAR_ITEMS.status;
		const categoryItems = SIDEBAR_ITEMS.category;

		// Title
		const titleBox = new BoxRenderable(this.renderer, {
			paddingY: 1,
			paddingX: 1,
		});

		titleBox.add(
			new TextRenderable(this.renderer, {
				content: APP_NAME,
				fg: theme.accent,
			}),
		);

		// Status section (starts at index 0)
		const statusSection = this.buildSection(
			"Status",
			statusItems,
			0,
			state.selectedIndex,
		);

		// Spacer
		const spacer = new BoxRenderable(this.renderer, { height: 1 });

		// Category section (starts after status items)
		const categorySection = this.buildSection(
			"Category",
			categoryItems,
			statusItems.length,
			state.selectedIndex,
		);

		// Main container (transparent background)
		const container = new BoxRenderable(this.renderer, {
			width: SIDEBAR_WIDTH,
			height: "100%",
			flexDirection: "column",
			border: true,
			borderColor: theme.border,
		});

		container.add(titleBox);
		container.add(statusSection);
		container.add(spacer);
		container.add(categorySection);

		return container;
	}

	private buildSection(
		title: string,
		items: readonly string[],
		startIndex: number,
		selectedGlobalIndex: number,
	): BoxRenderable {
		const theme = getTheme();
		const section = new BoxRenderable(this.renderer, {
			flexDirection: "column",
		});

		// Section title
		const titleBox = new BoxRenderable(this.renderer, { paddingLeft: 1 });
		titleBox.add(
			new TextRenderable(this.renderer, {
				content: title,
				fg: theme.fgMuted,
			}),
		);
		section.add(titleBox);

		// Items
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const globalIndex = startIndex + i;
			const isSelected = globalIndex === selectedGlobalIndex;

			const itemBox = new BoxRenderable(this.renderer, { paddingLeft: 1 });
			itemBox.add(
				new TextRenderable(this.renderer, {
					content: `${isSelected ? "> " : "  "}${item}`,
					fg: isSelected ? theme.accent : theme.fgPrimary,
				}),
			);
			section.add(itemBox);
		}

		return section;
	}
}
