import type { CliRenderer, KeyEvent } from "@opentui/core";
import { SIDEBAR_ITEMS } from "../constants";
import type { ContentWindow } from "../layout/content-window";
import type { Sidebar } from "../layout/sidebar";
import type { Store } from "../store";

export class AppController {
	private renderer: CliRenderer;
	private store: Store;
	private sidebar: Sidebar;
	private contentWindow: ContentWindow;

	constructor(
		renderer: CliRenderer,
		store: Store,
		sidebar: Sidebar,
		contentWindow: ContentWindow,
	) {
		this.renderer = renderer;
		this.store = store;
		this.sidebar = sidebar;
		this.contentWindow = contentWindow;
	}

	start(): void {
		this.store.subscribe(() => {
			this.sidebar.update();
			this.contentWindow.update();
		});

		this.renderer.keyInput.on("keypress", (key) => {
			this.handleKeyPress(key);
		});
	}

	private handleKeyPress(key: KeyEvent): void {
		const totalItems =
			SIDEBAR_ITEMS.status.length + SIDEBAR_ITEMS.category.length;
		const state = this.store.getState();

		if (key.name === "j" || key.name === "down") {
			const nextIndex = (state.selectedIndex + 1) % totalItems;
			this.store.setState({
				selectedIndex: nextIndex,
				selectedView: this.getViewName(nextIndex),
			});
		} else if (key.name === "k" || key.name === "up") {
			const prevIndex = (state.selectedIndex - 1 + totalItems) % totalItems;
			this.store.setState({
				selectedIndex: prevIndex,
				selectedView: this.getViewName(prevIndex),
			});
		}
	}

	private getViewName(globalIndex: number): string {
		const statusLen = SIDEBAR_ITEMS.status.length;
		if (globalIndex < statusLen) {
			return SIDEBAR_ITEMS.status[globalIndex] ?? "All";
		}
		return SIDEBAR_ITEMS.category[globalIndex - statusLen] ?? "All";
	}
}
