import {
	type CliRenderer,
	createCliRenderer,
	type PasteEvent,
} from "@opentui/core";
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
import { isMagnetUri } from "./torrent/magnet";
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

	async start(initialTorrentPath?: string): Promise<void> {
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
			this.statusBar,
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

		this.controller.onDialogPaste = (event: PasteEvent) => {
			return this.addDialog.handlePaste(event);
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

		this.addDialog.onSelect = (filePath) => {
			this.controller.focusMode = "global";
			const filename = filePath.split("/").pop() ?? filePath;
			this.renderer.requestRender();

			setTimeout(() => {
				this.addTorrentInBackground(filePath, filename);
			}, 0);
		};

		await this.bridge.restoreSession();
		this.controller.start();

		if (initialTorrentPath) {
			const filename =
				initialTorrentPath.split("/").pop() ?? initialTorrentPath;
			setTimeout(() => {
				this.addTorrentInBackground(initialTorrentPath, filename);
			}, 0);
		}

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

	private async addTorrentInBackground(
		input: string,
		filename: string,
	): Promise<void> {
		try {
			const result = isMagnetUri(input)
				? await this.bridge.addMagnet(input)
				: await this.bridge.addTorrent(input);
			this.toastManager.show({
				id: `added-${Date.now()}`,
				type: result.added ? "success" : "info",
				title: result.added ? "Torrent added" : "Torrent already added",
				message: result.name || filename,
			});
			this.renderer.requestRender();

			if (result.added) {
				this.bridge.startTorrent(result.id).catch((err: unknown) => {
					this.toastManager.show({
						id: `start-err-${Date.now()}`,
						type: "error",
						title: "Failed to start",
						message: err instanceof Error ? err.message : String(err),
					});
				});
			}
		} catch (err) {
			this.toastManager.show({
				id: `err-${Date.now()}`,
				type: "error",
				title: "Failed to add",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
