import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";
import type { ConfirmDialog } from "../layout/confirm-dialog";
import type { ContentWindow, FocusArea } from "../layout/content-window";
import {
	type DetailTab,
	FILE_TAB_FIXED_LINES,
	getDetailMaxScrollOffset,
} from "../layout/detail-panel";
import { buildSidebarSelectableItems, type Sidebar } from "../layout/sidebar";
import type { StatusBar } from "../layout/status-bar";
import type { ToastManager } from "../layout/toast-manager";
import type { AppState, Store } from "../store";
import { filterTorrents } from "../utils/filter";

type FocusMode = "global" | "dialog" | "search";
const DETAIL_TABS: DetailTab[] = ["Pieces", "Peers", "Files"];
const RENDER_THROTTLE_MS = 100;

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
	private filesTabCursor = 0;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private lastRenderAt = 0;
	private stopped = false;

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
	onSetTorrentCategory?: (id: string) => Promise<void> | void;
	onManageCategories?: () => Promise<void> | void;

	private _confirmDialog: ConfirmDialog | null = null;
	private pendingConfirmAction: (() => Promise<void> | void) | null = null;
	private pendingConfirmCancel: (() => void) | null = null;
	set confirmDialog(dialog: ConfirmDialog) {
		this._confirmDialog = dialog;
		dialog.onConfirm = () => {
			this.focusMode = "global";
			const confirmAction = this.pendingConfirmAction;
			if (confirmAction) {
				this.pendingConfirmAction = null;
				this.pendingConfirmCancel = null;
				this.runTorrentAction("confirm action", confirmAction);
				return;
			}
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
			const cancelAction = this.pendingConfirmCancel;
			this.pendingConfirmAction = null;
			this.pendingConfirmCancel = null;
			cancelAction?.();
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
		this.stopped = false;
		this.store.subscribe(() => this.scheduleRender());

		this.renderer.keyInput.on("keypress", (key) => {
			this.handleKeyPress(key);
		});
		this.renderer.keyInput.on("paste", (event: PasteEvent) => {
			this.handlePaste(event);
		});

		this.refreshView();
	}

	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
	}

	confirm(
		message: string,
		detail: string,
		onConfirm: () => Promise<void> | void,
		onCancel?: () => void,
	): void {
		this.pendingConfirmAction = onConfirm;
		this.pendingConfirmCancel = onCancel ?? null;
		this.focusMode = "dialog";
		this._confirmDialog?.open(message, detail);
	}

	private refreshView(): void {
		if (this.stopped) return;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		this.renderView();
	}

	private scheduleRender(): void {
		if (this.stopped) return;
		if (this.renderTimer) return;
		const elapsed = Date.now() - this.lastRenderAt;
		const delay = Math.max(0, RENDER_THROTTLE_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			if (this.stopped) return;
			this.renderView();
		}, delay);
	}

	private renderView(): void {
		if (this.stopped) return;
		this.lastRenderAt = Date.now();
		const state = this.store.getState();
		const len = this.getVisibleTorrents(state).length;
		if (len > 0 && this.tableSelectedIndex >= len) {
			this.tableSelectedIndex = len - 1;
		} else if (len === 0) {
			this.tableSelectedIndex = 0;
		}
		this.syncDetailState(state);
		this.sidebar.update(state, this.focusArea);
		this.contentWindow.update(
			this.focusArea,
			this.tableSelectedIndex,
			this.getDetailTab(),
			this.getDetailScrollOffset(),
			this.filesTabCursor,
		);
		this.statusBar.update(state, this.focusArea, this.focusMode === "search");
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
		return this.getVisibleTorrents(state)[this.tableSelectedIndex]?.id ?? null;
	}

	private getVisibleTorrents(state = this.store.getState()) {
		return filterTorrents(state.torrents, {
			view: state.selectedView,
			searchQuery: state.searchQuery,
		});
	}

	private getDetailTab(): DetailTab {
		return DETAIL_TABS[this.detailTabIndex] ?? "Pieces";
	}

	private moveDetailTab(delta: number): void {
		this.detailTabIndex =
			(this.detailTabIndex + delta + DETAIL_TABS.length) % DETAIL_TABS.length;
		this.scheduleRender();
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

	private getSelectedTorrent(state = this.store.getState()) {
		return this.getVisibleTorrents(state)[this.tableSelectedIndex] ?? null;
	}

	private syncDetailState(state: AppState = this.store.getState()): void {
		const selectedTorrent = this.getSelectedTorrent(state);
		const torrentId = selectedTorrent?.id ?? null;
		if (torrentId !== this.lastDetailTorrentId) {
			this.lastDetailTorrentId = torrentId;
			this.resetDetailScrollOffsets();
			this.filesTabCursor = 0;
		}
		const maxOffset = getDetailMaxScrollOffset(
			selectedTorrent,
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
		this.scheduleRender();
	}

	private handleKeyPress(key: KeyEvent): void {
		if (this.focusMode === "search") {
			if (key.name === "escape") {
				this.focusMode = "global";
				this.store.setState({ searchQuery: "" });
				key.preventDefault();
				key.stopPropagation();
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				this.focusMode = "global";
				this.scheduleRender();
				key.preventDefault();
				key.stopPropagation();
				return;
			}
			if (key.name === "backspace") {
				const query = this.store.getState().searchQuery;
				this.store.setState({ searchQuery: query.slice(0, -1) });
				key.preventDefault();
				key.stopPropagation();
				return;
			}
			const char = searchCharFromKey(key);
			if (char) {
				const query = this.store.getState().searchQuery;
				this.store.setState({ searchQuery: `${query}${char}` });
				key.preventDefault();
				key.stopPropagation();
			}
			return;
		}

		if (this.focusMode === "dialog") {
			if (this._confirmDialog?.getIsOpen()) {
				if (this._confirmDialog.handleInput(key.name)) {
					key.preventDefault();
					key.stopPropagation();
				}
			} else {
				if (key.name === "escape") {
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
			this.scheduleRender();
			key.preventDefault();
			key.stopPropagation();
			return;
		}

		if (key.name === "tab") {
			this.focusArea = this.nextFocusArea();
			this.scheduleRender();
			key.preventDefault();
			key.stopPropagation();
			return;
		}

		if (key.name === "/") {
			this.focusMode = "search";
			this.focusArea = "table";
			this.scheduleRender();
			key.preventDefault();
			key.stopPropagation();
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
				const state = this.store.getState();
				const total = buildSidebarSelectableItems().length;
				const next = (state.selectedIndex + 1) % total;
				const item = buildSidebarSelectableItems()[next];
				this.store.setState({
					selectedIndex: next,
					selectedView: item?.selectedView ?? state.selectedView,
				});
			} else if (this.focusArea === "table") {
				const state = this.store.getState();
				const len = this.getVisibleTorrents(state).length;
				if (len > 0) {
					this.tableSelectedIndex = Math.min(
						this.tableSelectedIndex + 1,
						len - 1,
					);
					this.scheduleRender();
				}
			} else if (this.focusArea === "details") {
				if (this.getDetailTab() === "Files") {
					this.moveFileCursor(1);
				} else {
					this.moveDetailScroll(1);
				}
			}
		} else if (key.name === "k" || key.name === "up") {
			if (this.focusArea === "sidebar") {
				const state = this.store.getState();
				const total = buildSidebarSelectableItems().length;
				const prev = (state.selectedIndex - 1 + total) % total;
				const item = buildSidebarSelectableItems()[prev];
				this.store.setState({
					selectedIndex: prev,
					selectedView: item?.selectedView ?? state.selectedView,
				});
			} else if (this.focusArea === "table") {
				if (this.tableSelectedIndex > 0) {
					this.tableSelectedIndex--;
					this.scheduleRender();
				}
			} else if (this.focusArea === "details") {
				if (this.getDetailTab() === "Files") {
					this.moveFileCursor(-1);
				} else {
					this.moveDetailScroll(-1);
				}
			}
		} else if (key.name === "space") {
			if (this.focusArea === "table") {
				const id = this.getSelectedId();
				if (!id) return;
				const state = this.store.getState();
				const torrent = this.getVisibleTorrents(state)[this.tableSelectedIndex];
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
		} else if (key.name === "c") {
			if (this.focusArea === "table") {
				const id = this.getSelectedId();
				if (id)
					this.runTorrentAction("set torrent category", () =>
						this.onSetTorrentCategory?.(id),
					);
			}
		} else if (key.name === "m") {
			if (this.focusArea === "sidebar") {
				this.runTorrentAction("manage categories", () =>
					this.onManageCategories?.(),
				);
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

	private moveFileCursor(delta: number): void {
		const torrent = this.getSelectedTorrent();
		if (!torrent || torrent.files.length === 0) return;
		const max = torrent.files.length - 1;
		this.filesTabCursor = Math.max(
			0,
			Math.min(this.filesTabCursor + delta, max),
		);

		// Scroll to keep cursor visible
		const bodyRows = this.contentWindow.getDetailBodyRowCount();
		const visibleRows = Math.max(1, bodyRows - FILE_TAB_FIXED_LINES);
		const offset = this.detailScrollOffsets.Files ?? 0;
		if (this.filesTabCursor >= offset + visibleRows) {
			this.detailScrollOffsets.Files = this.filesTabCursor - visibleRows + 1;
		} else if (this.filesTabCursor < offset) {
			this.detailScrollOffsets.Files = this.filesTabCursor;
		}

		this.scheduleRender();
	}

	private handlePaste(event: PasteEvent): void {
		if (this.focusMode === "search") {
			this.store.setState({
				searchQuery: `${this.store.getState().searchQuery}${Buffer.from(event.bytes).toString("utf-8")}`,
			});
			event.preventDefault();
			return;
		}
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

function searchCharFromKey(key: KeyEvent): string {
	if (key.ctrl || key.meta) return "";
	if (key.name === "space") return " ";
	if (key.name.length !== 1) return "";
	if (key.shift && /^[a-z]$/.test(key.name)) return key.name.toUpperCase();
	return key.name;
}
