import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { loadConfig } from "./config";
import { AppController } from "./controllers/app-controller";
import { AddTorrentDialog } from "./layout/add-torrent-dialog";
import { ConfirmDialog } from "./layout/confirm-dialog";
import { ContentWindow } from "./layout/content-window";
import { Sidebar } from "./layout/sidebar";
import { StatusBar } from "./layout/status-bar";
import { ToastManager } from "./layout/toast-manager";
import { Store } from "./store";
import { TorrentBridge } from "./torrent/bridge";
import type { LayoutDimensions } from "./types/layout";
import { calculateLayout } from "./utils/layout";

const INITIAL_STATE = {
	selectedIndex: 0,
	selectedView: "All",
	torrents: [],
	totalDownloadBps: 0,
	totalUploadBps: 0,
};

export class App {
	private renderer!: CliRenderer;
	private store!: Store;
	private sidebar!: Sidebar;
	private contentWindow!: ContentWindow;
	private statusBar!: StatusBar;
	private toastManager!: ToastManager;
	private controller!: AppController;
	private bridge!: TorrentBridge;
	private addDialog!: AddTorrentDialog;
	private confirmDialog!: ConfirmDialog;
	private layout!: LayoutDimensions;
	private resizeTimeout: ReturnType<typeof setTimeout> | null = null;

	async start(): Promise<void> {
		const config = loadConfig();

		this.renderer = await createCliRenderer({ exitOnCtrlC: true });
		this.store = new Store(INITIAL_STATE);
		this.layout = calculateLayout(this.renderer.width, this.renderer.height);
		this.bridge = new TorrentBridge(this.store, config);

		this.sidebar = new Sidebar(this.renderer, this.store, this.layout);
		this.contentWindow = new ContentWindow(
			this.renderer,
			this.store,
			this.layout,
		);
		this.statusBar = new StatusBar(this.renderer, this.layout);
		this.toastManager = new ToastManager(this.renderer, this.layout);
		this.addDialog = new AddTorrentDialog(
			this.renderer,
			this.layout,
			config.torrentFolder,
		);
		this.confirmDialog = new ConfirmDialog(this.renderer, this.layout);

		this.controller = new AppController(
			this.renderer,
			this.store,
			this.sidebar,
			this.contentWindow,
			this.toastManager,
		);
		// Wire ConfirmDialog — callbacks are set inside the controller setter
		this.controller.confirmDialog = this.confirmDialog;

		// Wire controller callbacks
		this.controller.onAddTorrent = () => {
			this.addDialog.open();
		};

		this.controller.onDialogClose = () => {
			this.addDialog.close();
		};

		this.controller.onDialogInput = (key) => {
			return this.addDialog.handleInput(key);
		};

		this.controller.onQuit = async () => {
			await this.bridge.stopAll();
			this.renderer.destroy();
		};

		this.controller.onPauseTorrent = (id) => {
			this.bridge.pauseTorrent(id);
		};

		this.controller.onResumeTorrent = (id) => {
			this.bridge.resumeTorrent(id);
		};

		this.controller.onStartTorrent = (id) => {
			this.bridge.startTorrent(id);
		};

		this.controller.onRemoveTorrent = (id, deleteFiles) => {
			this.bridge.removeTorrent(id, deleteFiles);
		};

		this.addDialog.onSelect = async (filePath) => {
			this.controller.focusMode = "global";
			const filename = filePath.split("/").pop() ?? filePath;
			this.toastManager.show({
				id: `add-${Date.now()}`,
				type: "info",
				title: "Adding torrent",
				message: filename,
			});

			try {
				await this.bridge.addTorrent(filePath);
				this.toastManager.show({
					id: `added-${Date.now()}`,
					type: "success",
					title: "Download started",
					message: filename,
				});
			} catch (err) {
				this.toastManager.show({
					id: `err-${Date.now()}`,
					type: "error",
					title: "Failed to add",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		};

		this.store.subscribe((state) => {
			this.statusBar.update(state);
		});

		await this.bridge.restoreSession();
		this.controller.start();

		this.renderer.on("resize", (width: number, height: number) => {
			this.handleResize(width, height);
		});
	}

	private handleResize(width: number, height: number): void {
		if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
		this.resizeTimeout = setTimeout(() => {
			this.resizeTimeout = null;
			this.layout = calculateLayout(width, height);
			this.sidebar.updateLayout(this.layout);
			this.contentWindow.updateLayout(this.layout);
			this.statusBar.updateLayout(this.layout);
			this.toastManager.updateLayout(this.layout);
			this.addDialog.updateLayout(this.layout);
			this.confirmDialog.updateLayout(this.layout);
		}, 100);
	}
}
