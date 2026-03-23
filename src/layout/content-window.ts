import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { Store } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

export class ContentWindow {
	private renderer: CliRenderer;
	private store: Store;
	private container: BoxRenderable;
	private titleText: TextRenderable | null = null;
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
		if (this.titleText) {
			(this.titleText as unknown as { content: string }).content =
				state.selectedView;
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		this.container.left = layout.content.x;
		this.container.top = layout.content.y;
		this.container.width = layout.content.width;
		this.container.height = layout.content.height;
	}

	private build(): BoxRenderable {
		const theme = getTheme();
		const state = this.store.getState();

		this.container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: this.layout.content.x,
			top: this.layout.content.y,
			width: this.layout.content.width,
			height: this.layout.content.height,
			border: true,
			borderColor: theme.border,
		});

		const titleBox = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 0,
			top: 0,
			width: this.layout.content.width,
			paddingY: 1,
			paddingX: 1,
		});

		this.titleText = new TextRenderable(this.renderer, {
			content: state.selectedView,
			fg: theme.accent,
		});
		titleBox.add(this.titleText);
		this.container.add(titleBox);

		const contentText = new TextRenderable(this.renderer, {
			content: "Welcome to torrent-tui",
			fg: theme.fgPrimary,
		});

		const contentBox = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 1,
			top: 4,
		});
		contentBox.add(contentText);
		this.container.add(contentBox);

		return this.container;
	}
}
