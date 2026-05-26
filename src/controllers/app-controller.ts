import type { CliRenderer, KeyEvent } from "@opentui/core";
import { SIDEBAR_ITEMS } from "../constants";
import type { ContentWindow } from "../layout/content-window";
import type { Sidebar } from "../layout/sidebar";
import type { ToastManager } from "../layout/toast-manager";
import type { Store } from "../store";

type FocusMode = "global" | "dialog";
type FocusArea = "sidebar" | "table";

export class AppController {
	private renderer: CliRenderer;
	private store: Store;
	private sidebar: Sidebar;
	private contentWindow: ContentWindow;
	private toastManager: ToastManager;
	focusMode: FocusMode = "global";
	focusArea: FocusArea = "sidebar";

	// Callbacks wired by App after bridge/dialog are created
	onAddTorrent?: () => void;
	onQuit?: () => void;
	onDialogClose?: () => void;

	constructor(
		renderer: CliRenderer,
		store: Store,
		sidebar: Sidebar,
		contentWindow: ContentWindow,
		toastManager: ToastManager,
	) {
		this.renderer = renderer;
		this.store = store;
		this.sidebar = sidebar;
		this.contentWindow = contentWindow;
		this.toastManager = toastManager;
	}

	start(): void {
		this.store.subscribe((state) => {
			this.sidebar.update(state);
			this.contentWindow.update(this.focusArea);
		});

		this.renderer.keyInput.on("keypress", (key) => {
			this.handleKeyPress(key);
		});

		// Force initial render so components reflect the empty state correctly
		this.refreshView();
	}

	private refreshView(): void {
		const state = this.store.getState();
		this.sidebar.update(state);
		this.contentWindow.update(this.focusArea);
	}

	private handleKeyPress(key: KeyEvent): void {
		// Dialog mode: only Esc reaches global handler
		if (this.focusMode === "dialog") {
			if (key.name === "escape") {
				this.focusMode = "global";
				this.onDialogClose?.();
			}
			return;
		}

		if (this.toastManager.handleInput(key.name)) {
			return;
		}

		// Tab toggles focus between sidebar and table
		if (key.name === "tab") {
			this.focusArea = this.focusArea === "sidebar" ? "table" : "sidebar";
			this.refreshView();
			return;
		}

		if (key.name === "j" || key.name === "down") {
			if (this.focusArea === "sidebar") {
				const total = SIDEBAR_ITEMS.status.length;
				const state = this.store.getState();
				const next = (state.selectedIndex + 1) % total;
				this.store.setState({ selectedIndex: next, selectedView: SIDEBAR_ITEMS.status[next] ?? "All" });
			}
			// Table mode: no-op for single-torrent MVP
		} else if (key.name === "k" || key.name === "up") {
			if (this.focusArea === "sidebar") {
				const total = SIDEBAR_ITEMS.status.length;
				const state = this.store.getState();
				const prev = (state.selectedIndex - 1 + total) % total;
				this.store.setState({ selectedIndex: prev, selectedView: SIDEBAR_ITEMS.status[prev] ?? "All" });
			}
			// Table mode: no-op for single-torrent MVP
		} else if (key.name === "a") {
			this.focusMode = "dialog";
			this.onAddTorrent?.();
		} else if (key.name === "q") {
			this.onQuit?.();
		}
	}
}
