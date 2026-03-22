import type { CliRenderer, KeyEvent } from "@opentui/core";
import { SIDEBAR_ITEMS } from "../constants";
import type { Sidebar } from "../layout/Sidebar";
import type { Store } from "../store";

export class AppController {
	private renderer: CliRenderer;
	private store: Store;
	private sidebar: Sidebar;

	constructor(renderer: CliRenderer, store: Store, sidebar: Sidebar) {
		this.renderer = renderer;
		this.store = store;
		this.sidebar = sidebar;
	}

	start(): void {
		// Subscribe to store changes
		this.store.subscribe(() => {
			this.sidebar.update();
		});

		// Register keyboard handler
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
			this.store.setState({ selectedIndex: nextIndex });
		} else if (key.name === "k" || key.name === "up") {
			const prevIndex = (state.selectedIndex - 1 + totalItems) % totalItems;
			this.store.setState({ selectedIndex: prevIndex });
		}
	}
}
