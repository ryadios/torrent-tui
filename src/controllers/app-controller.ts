import type { CliRenderer, KeyEvent } from "@opentui/core";
import { SIDEBAR_ITEMS } from "../constants";
import type { ConfirmDialog } from "../layout/confirm-dialog";
import type { ContentWindow } from "../layout/content-window";
import type { Sidebar } from "../layout/sidebar";
import type { ToastManager } from "../layout/toast-manager";
import type { Store } from "../store";
import { filterTorrents } from "../utils/filter";

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
	private tableSelectedIndex = 0;
	private pendingDeleteId: string | null = null;

	// Injected by App after bridge/dialog are created
	onAddTorrent?: () => void;
	onQuit?: () => void;
	onDialogClose?: () => void;
	onDialogInput?: (key: string) => boolean;
	onPauseTorrent?: (id: string) => Promise<void> | void;
	onResumeTorrent?: (id: string) => Promise<void> | void;
	onStartTorrent?: (id: string) => Promise<void> | void;
	onRemoveTorrent?: (id: string, deleteFiles: boolean) => Promise<void> | void;

	private _confirmDialog: ConfirmDialog | null = null;
	set confirmDialog(dialog: ConfirmDialog) {
		this._confirmDialog = dialog;
		dialog.onConfirm = () => {
			this.focusMode = "global";
			const pendingDeleteId = this.pendingDeleteId;
			if (pendingDeleteId) {
				this.runTorrentAction("remove torrent", () =>
					this.onRemoveTorrent?.(pendingDeleteId, true),
				);
				this.pendingDeleteId = null;
			}
		};
		dialog.onCancel = () => {
			this.focusMode = "global";
			this.pendingDeleteId = null;
		};
	}

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
			const len = filterTorrents(state.torrents, state.selectedView).length;
			if (len > 0 && this.tableSelectedIndex >= len) {
				this.tableSelectedIndex = len - 1;
			} else if (len === 0) {
				this.tableSelectedIndex = 0;
			}
			this.sidebar.update(state, this.focusArea);
			this.contentWindow.update(this.focusArea, this.tableSelectedIndex);
		});

		this.renderer.keyInput.on("keypress", (key) => {
			this.handleKeyPress(key);
		});

		this.refreshView();
	}

	private refreshView(): void {
		const state = this.store.getState();
		this.sidebar.update(state, this.focusArea);
		this.contentWindow.update(this.focusArea, this.tableSelectedIndex);
	}

	private runTorrentAction(
		label: string,
		action: () => Promise<void> | void,
	): void {
		Promise.resolve()
			.then(action)
			.catch((err: unknown) => {
				this.toastManager.show({
					id: `action-${Date.now()}`,
					type: "error",
					title: `Failed to ${label}`,
					message: err instanceof Error ? err.message : String(err),
				});
			});
	}

	private getSelectedId(): string | null {
		const state = this.store.getState();
		return (
			filterTorrents(state.torrents, state.selectedView)[
				this.tableSelectedIndex
			]?.id ?? null
		);
	}

	private handleKeyPress(key: KeyEvent): void {
		if (this.focusMode === "dialog") {
			if (this._confirmDialog?.getIsOpen()) {
				this._confirmDialog.handleInput(key.name);
			} else {
				if (key.name === "escape") {
					this.focusMode = "global";
					this.onDialogClose?.();
				} else {
					this.onDialogInput?.(key.name);
				}
			}
			return;
		}

		if (this.toastManager.handleInput(key.name)) {
			return;
		}

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
				this.store.setState({
					selectedIndex: next,
					selectedView: SIDEBAR_ITEMS.status[next] ?? "All",
				});
			} else {
				const state = this.store.getState();
				const len = filterTorrents(state.torrents, state.selectedView).length;
				if (len > 0) {
					this.tableSelectedIndex = Math.min(
						this.tableSelectedIndex + 1,
						len - 1,
					);
					this.refreshView();
				}
			}
		} else if (key.name === "k" || key.name === "up") {
			if (this.focusArea === "sidebar") {
				const total = SIDEBAR_ITEMS.status.length;
				const state = this.store.getState();
				const prev = (state.selectedIndex - 1 + total) % total;
				this.store.setState({
					selectedIndex: prev,
					selectedView: SIDEBAR_ITEMS.status[prev] ?? "All",
				});
			} else {
				if (this.tableSelectedIndex > 0) {
					this.tableSelectedIndex--;
					this.refreshView();
				}
			}
		} else if (key.name === "space") {
			if (this.focusArea === "table") {
				const id = this.getSelectedId();
				if (!id) return;
				const state = this.store.getState();
				const torrent = filterTorrents(state.torrents, state.selectedView)[
					this.tableSelectedIndex
				];
				if (!torrent) return;
				if (torrent.status === "downloading") {
					this.runTorrentAction("pause torrent", () =>
						this.onPauseTorrent?.(id),
					);
				} else if (torrent.status === "paused") {
					this.runTorrentAction("resume torrent", () =>
						this.onResumeTorrent?.(id),
					);
				} else if (
					torrent.status === "stopped" ||
					torrent.status === "stalled" ||
					torrent.status === "error"
				) {
					this.runTorrentAction("start torrent", () =>
						this.onStartTorrent?.(id),
					);
				}
			}
		} else if (key.name === "d" && !key.shift) {
			if (this.focusArea === "table") {
				const id = this.getSelectedId();
				if (id)
					this.runTorrentAction("remove torrent", () =>
						this.onRemoveTorrent?.(id, false),
					);
			}
		} else if (key.name === "d" && key.shift) {
			if (this.focusArea === "table") {
				const id = this.getSelectedId();
				if (!id) return;
				this.pendingDeleteId = id;
				this.focusMode = "dialog";
				this._confirmDialog?.open("Delete torrent and files?");
			}
		} else if (key.name === "a") {
			this.focusMode = "dialog";
			this.onAddTorrent?.();
		} else if (key.name === "q") {
			this.onQuit?.();
		}
	}
}
