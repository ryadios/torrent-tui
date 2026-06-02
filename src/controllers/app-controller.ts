import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";
import { SIDEBAR_ITEMS } from "../constants";
import type { ConfirmDialog } from "../layout/confirm-dialog";
import type { ContentWindow, FocusArea } from "../layout/content-window";
import {
	type DetailTab,
	getDetailMaxScrollOffset,
} from "../layout/detail-panel";
import type { Sidebar } from "../layout/sidebar";
import type { StatusBar } from "../layout/status-bar";
import type { ToastManager } from "../layout/toast-manager";
import type { Store } from "../store";
import { filterTorrents } from "../utils/filter";

type FocusMode = "global" | "dialog";
const DETAIL_TABS: DetailTab[] = ["Pieces", "Peers", "Files"];

export class AppController {
	private renderer: CliRenderer;
	private store: Store;
	private sidebar: Sidebar;
	private contentWindow: ContentWindow;
	private statusBar: StatusBar;
	private toastManager: ToastManager;
	focusMode: FocusMode = "global";
	focusArea: FocusArea = "sidebar";
	private tableSelectedIndex = 0;
	private detailTabIndex = 0;
	private detailScrollOffsets: Record<DetailTab, number> = {
		Pieces: 0,
		Peers: 0,
		Files: 0,
	};
	private lastDetailTorrentId: string | null = null;
	private pendingDeleteId: string | null = null;

	// Injected by App after bridge/dialog are created
	onAddTorrent?: () => void;
	onQuit?: () => void;
	onDialogClose?: () => void;
	onDialogInput?: (key: KeyEvent) => boolean;
	onDialogPaste?: (event: PasteEvent) => boolean;
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
		statusBar: StatusBar,
		toastManager: ToastManager,
	) {
		this.renderer = renderer;
		this.store = store;
		this.sidebar = sidebar;
		this.contentWindow = contentWindow;
		this.statusBar = statusBar;
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
			this.syncDetailState();
			this.sidebar.update(state, this.focusArea);
			this.contentWindow.update(
				this.focusArea,
				this.tableSelectedIndex,
				this.getDetailTab(),
				this.getDetailScrollOffset(),
			);
			this.statusBar.update(state, this.focusArea);
		});

		this.renderer.keyInput.on("keypress", (key) => {
			this.handleKeyPress(key);
		});
		this.renderer.keyInput.on("paste", (event: PasteEvent) => {
			this.handlePaste(event);
		});

		this.refreshView();
	}

	private refreshView(): void {
		const state = this.store.getState();
		this.sidebar.update(state, this.focusArea);
		this.contentWindow.update(
			this.focusArea,
			this.tableSelectedIndex,
			this.getDetailTab(),
			this.getDetailScrollOffset(),
		);
		this.statusBar.update(state, this.focusArea);
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

	private getDetailTab(): DetailTab {
		return DETAIL_TABS[this.detailTabIndex] ?? "Pieces";
	}

	private moveDetailTab(delta: number): void {
		this.detailTabIndex =
			(this.detailTabIndex + delta + DETAIL_TABS.length) % DETAIL_TABS.length;
		this.refreshView();
	}

	private getDetailScrollOffset(): number {
		return this.detailScrollOffsets[this.getDetailTab()] ?? 0;
	}

	private setDetailScrollOffset(offset: number): void {
		this.detailScrollOffsets[this.getDetailTab()] = offset;
	}

	private resetDetailScrollOffsets(): void {
		this.detailScrollOffsets = {
			Pieces: 0,
			Peers: 0,
			Files: 0,
		};
	}

	private getSelectedTorrent() {
		const state = this.store.getState();
		return (
			filterTorrents(state.torrents, state.selectedView)[
				this.tableSelectedIndex
			] ?? null
		);
	}

	private syncDetailState(): void {
		const torrentId = this.getSelectedTorrent()?.id ?? null;
		if (torrentId !== this.lastDetailTorrentId) {
			this.lastDetailTorrentId = torrentId;
			this.resetDetailScrollOffsets();
		}
		const maxOffset = getDetailMaxScrollOffset(
			this.getSelectedTorrent(),
			this.getDetailTab(),
			this.contentWindow.getDetailBodyRowCount(),
		);
		this.setDetailScrollOffset(
			Math.max(0, Math.min(this.getDetailScrollOffset(), maxOffset)),
		);
	}

	private moveDetailScroll(delta: number): void {
		const maxOffset = getDetailMaxScrollOffset(
			this.getSelectedTorrent(),
			this.getDetailTab(),
			this.contentWindow.getDetailBodyRowCount(),
		);
		const nextOffset = Math.max(
			0,
			Math.min(this.getDetailScrollOffset() + delta, maxOffset),
		);
		if (nextOffset === this.getDetailScrollOffset()) return;
		this.setDetailScrollOffset(nextOffset);
		this.refreshView();
	}

	private handleKeyPress(key: KeyEvent): void {
		if (this.focusMode === "dialog") {
			if (this._confirmDialog?.getIsOpen()) {
				this._confirmDialog.handleInput(key.name);
			} else {
				if (key.name === "escape") {
					this.focusMode = "global";
					this.onDialogClose?.();
					key.preventDefault();
					key.stopPropagation();
				} else {
					if (this.onDialogInput?.(key)) {
						key.preventDefault();
						key.stopPropagation();
					}
				}
			}
			return;
		}

		if (this.toastManager.handleInput(key.name)) {
			return;
		}

		if (key.shift && key.name === "tab") {
			this.focusArea = this.previousFocusArea();
			this.refreshView();
			return;
		}

		if (key.name === "tab") {
			this.focusArea = this.nextFocusArea();
			this.refreshView();
			return;
		}

		if (this.focusArea === "details") {
			if (
				key.name === "h" ||
				key.name === "[" ||
				key.name === "leftbracket" ||
				key.name === "left"
			) {
				this.moveDetailTab(-1);
				return;
			}
			if (
				key.name === "l" ||
				key.name === "]" ||
				key.name === "rightbracket" ||
				key.name === "right"
			) {
				this.moveDetailTab(1);
				return;
			}
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
			} else if (this.focusArea === "table") {
				const state = this.store.getState();
				const len = filterTorrents(state.torrents, state.selectedView).length;
				if (len > 0) {
					this.tableSelectedIndex = Math.min(
						this.tableSelectedIndex + 1,
						len - 1,
					);
					this.refreshView();
				}
			} else if (this.focusArea === "details") {
				this.moveDetailScroll(1);
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
			} else if (this.focusArea === "table") {
				if (this.tableSelectedIndex > 0) {
					this.tableSelectedIndex--;
					this.refreshView();
				}
			} else if (this.focusArea === "details") {
				this.moveDetailScroll(-1);
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
					torrent.status === "error" ||
					torrent.status === "missing"
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
			key.preventDefault();
			key.stopPropagation();
		} else if (key.name === "q") {
			this.onQuit?.();
		}
	}

	private handlePaste(event: PasteEvent): void {
		if (this.focusMode !== "dialog" || this._confirmDialog?.getIsOpen()) return;
		if (this.onDialogPaste?.(event)) {
			event.preventDefault();
		}
	}

	private nextFocusArea(): FocusArea {
		switch (this.focusArea) {
			case "sidebar":
				return "table";
			case "table":
				return "details";
			case "details":
				return "sidebar";
		}
	}

	private previousFocusArea(): FocusArea {
		switch (this.focusArea) {
			case "sidebar":
				return "details";
			case "table":
				return "sidebar";
			case "details":
				return "table";
		}
	}
}
