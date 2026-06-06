import {
	type CliRenderer,
	createCliRenderer,
	type PasteEvent,
} from "@opentui/core";
import { loadConfig, saveConfig } from "./config";
import { createCategory, updateCategory } from "./config/categories";
import type { AppSettings } from "./config/settings";
import { AppController } from "./controllers/app-controller";
import { AddTorrentDialog } from "./layout/add-torrent-dialog";
import {
	CategoryDialog,
	type CategoryDialogResult,
} from "./layout/category-dialog";
import { CategoryManagerDialog } from "./layout/category-manager-dialog";
import {
	CategorySelectDialog,
	type CategorySelectOption,
} from "./layout/category-select-dialog";
import { ConfirmDialog } from "./layout/confirm-dialog";
import { ContentWindow } from "./layout/content-window";
import { DirectoryPickerDialog } from "./layout/directory-picker-dialog";
import { FilePickerDialog } from "./layout/file-picker-dialog";
import { Sidebar } from "./layout/sidebar";
import { StatusBar } from "./layout/status-bar";
import { ToastManager } from "./layout/toast-manager";
import { Store } from "./store";
import { type PreparedTorrentAdd, TorrentBridge } from "./torrent/bridge";
import type { LayoutDimensions } from "./types/layout";
import { env } from "./utils/env";
import { calculateLayout } from "./utils/layout";
import { resolvePath } from "./utils/paths";

type ModalId =
	| "add-source"
	| "category-select"
	| "new-category"
	| "category-manager"
	| "directory-picker"
	| "file-picker";

type CategoryFlow = { kind: "add" } | { kind: "reassign"; torrentId: string };
type CategoryDialogContext =
	| { kind: "select-new" }
	| { kind: "manager-new" }
	| { kind: "manager-edit"; categoryId: string };

const INITIAL_STATE = {
	selectedIndex: 0,
	selectedView: "All",
	searchQuery: "",
	categories: [],
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
	private filePickerDialog!: FilePickerDialog;
	private directoryPickerDialog!: DirectoryPickerDialog;
	private categoryDialog!: CategoryDialog;
	private categoryManagerDialog!: CategoryManagerDialog;
	private categorySelectDialog!: CategorySelectDialog;
	private layout!: LayoutDimensions;
	private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
	private config!: AppSettings;
	private pendingAdd: PreparedTorrentAdd | null = null;
	private modalStack: ModalId[] = [];
	private categoryFlow: CategoryFlow | null = null;
	private categoryDialogContext: CategoryDialogContext | null = null;

	async start(initialTorrentPath?: string): Promise<void> {
		this.config = loadConfig();

		this.renderer = await createCliRenderer({
			exitOnCtrlC: true,
			openConsoleOnError: env.SHOW_CONSOLE,
			useConsole: env.SHOW_CONSOLE,
		});
		this.store = new Store({
			...INITIAL_STATE,
			categories: this.config.categories,
		});
		this.layout = calculateLayout(this.renderer.width, this.renderer.height);
		this.bridge = new TorrentBridge(this.store, this.config);

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
			this.config.torrentFolder,
		);
		this.confirmDialog = new ConfirmDialog(this.renderer, this.layout);
		this.filePickerDialog = new FilePickerDialog(this.renderer, this.layout);
		this.directoryPickerDialog = new DirectoryPickerDialog(
			this.renderer,
			this.layout,
		);
		this.categoryDialog = new CategoryDialog(this.renderer, this.layout);
		this.categoryManagerDialog = new CategoryManagerDialog(
			this.renderer,
			this.layout,
		);
		this.categorySelectDialog = new CategorySelectDialog(
			this.renderer,
			this.layout,
		);

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
			this.modalStack = ["add-source"];
			this.addDialog.open();
			this.syncDialogFocusMode();
		};

		this.controller.onDialogClose = () => {
			this.closeTopModal();
		};

		this.controller.onDialogInput = (key) => {
			switch (this.currentModal()) {
				case "add-source":
					return this.addDialog.handleInput(key);
				case "category-select":
					return this.categorySelectDialog.handleInput(key);
				case "new-category":
					return this.categoryDialog.handleInput(key);
				case "category-manager":
					return this.categoryManagerDialog.handleInput(key);
				case "directory-picker":
					return this.directoryPickerDialog.handleInput(key);
				case "file-picker":
					return this.filePickerDialog.handleInput(key);
				default:
					return false;
			}
		};

		this.filePickerDialog.onConfirm = (id, selectedIndices) => {
			this.removeModal("file-picker");
			this.syncDialogFocusMode();
			this.bridge.setFileSelection(id, selectedIndices);
			this.startTorrentWithToast(id);
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
		this.controller.onSetTorrentCategory = (id) => {
			const torrent = this.store.getState().torrents.find((t) => t.id === id);
			if (!torrent) return;
			this.openCategorySelectForReassign(id);
		};
		this.controller.onManageCategories = () => {
			this.openCategoryManager();
		};

		this.addDialog.onSelect = (filePath) => {
			this.removeModal("add-source");
			this.syncDialogFocusMode();
			const filename = filePath.split("/").pop() ?? filePath;
			this.renderer.requestRender();

			setTimeout(() => {
				this.addTorrentInBackground(filePath, filename);
			}, 0);
		};

		this.directoryPickerDialog.onSelect = (path) => {
			this.removeModal("directory-picker");
			this.categoryDialog.setSavePath(path);
			this.categoryDialog.show();
			this.syncDialogFocusMode();
		};
		this.directoryPickerDialog.onCancel = () => {
			this.removeModal("directory-picker");
			this.categoryDialog.show();
			this.syncDialogFocusMode();
		};
		this.categoryDialog.onBrowse = (initialPath) => {
			this.openDirectoryPickerForNewCategory(initialPath);
		};
		this.categoryDialog.onConfirm = (result) => this.createCategory(result);
		this.categoryDialog.onCancel = () => {
			this.removeModal("new-category");
			if (this.categoryDialogContext?.kind === "select-new") {
				this.categorySelectDialog.show();
			} else {
				this.categoryManagerDialog.show(this.config.categories);
			}
			this.categoryDialogContext = null;
			this.syncDialogFocusMode();
		};
		this.categorySelectDialog.onSelect = (category) =>
			this.applySelectedCategory(category);
		this.categorySelectDialog.onNewCategory = () => {
			this.categorySelectDialog.hide();
			this.modalStack.push("new-category");
			this.categoryDialogContext = { kind: "select-new" };
			this.categoryDialog.open(this.config.downloadPath);
			this.syncDialogFocusMode();
		};
		this.categorySelectDialog.onCancel = () => {
			this.cancelCategoryFlow();
		};
		this.categoryManagerDialog.onCancel = () => {
			this.removeModal("category-manager");
			this.syncDialogFocusMode();
		};
		this.categoryManagerDialog.onNew = () => {
			this.categoryManagerDialog.hide();
			this.modalStack.push("new-category");
			this.categoryDialogContext = { kind: "manager-new" };
			this.categoryDialog.open(this.config.downloadPath);
			this.syncDialogFocusMode();
		};
		this.categoryManagerDialog.onEdit = (category) => {
			this.categoryManagerDialog.hide();
			this.modalStack.push("new-category");
			this.categoryDialogContext = {
				kind: "manager-edit",
				categoryId: category.id,
			};
			this.categoryDialog.open(category.savePath ?? this.config.downloadPath, {
				name: category.name,
				savePath: category.savePath,
				title: "Edit category",
			});
			this.syncDialogFocusMode();
		};
		this.categoryManagerDialog.onDelete = (category) => {
			this.categoryManagerDialog.hide();
			this.controller.confirm(
				`Delete category ${category.name}?`,
				"Torrents stay in place and become uncategorized.",
				() => {
					this.deleteCategory(category.id);
					this.categoryManagerDialog.show(this.config.categories);
					this.syncDialogFocusMode();
				},
				() => {
					this.categoryManagerDialog.show(this.config.categories);
					this.syncDialogFocusMode();
				},
			);
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
			this.filePickerDialog.updateLayout(this.layout);
			this.directoryPickerDialog.updateLayout(this.layout);
			this.categoryDialog.updateLayout(this.layout);
			this.categoryManagerDialog.updateLayout(this.layout);
			this.categorySelectDialog.updateLayout(this.layout);
		}, 100);
	}

	private async addTorrentInBackground(
		input: string,
		filename: string,
	): Promise<void> {
		try {
			const result = await this.bridge.prepareAdd(input);
			this.toastManager.show({
				id: `added-${Date.now()}`,
				type: result.added ? "success" : "info",
				title: result.added ? "Torrent added" : "Torrent already added",
				message: result.name || filename,
			});
			this.renderer.requestRender();

			if (result.added) {
				this.pendingAdd = result;
				this.openCategorySelectForAdd();
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

	private confirmPendingAdd(selection: {
		categoryId: string | null;
		categoryName: string | null;
		savePath: string;
	}): void {
		const pending = this.pendingAdd;
		if (!pending) return;
		this.pendingAdd = null;
		this.bridge
			.confirmAdd(pending, {
				categoryId: selection.categoryId,
				categoryName: selection.categoryName,
				savePath: selection.savePath,
			})
			.then((result) => {
				if (!result.added) {
					this.clearCategoryFlow();
					return;
				}
				const torrent = this.store
					.getState()
					.torrents.find((t) => t.id === result.id);
				if (torrent && torrent.files.length > 1) {
					this.clearCategoryFlow({ keepFocus: true });
					this.modalStack = ["file-picker"];
					this.filePickerDialog.open(result.id, torrent.files, torrent.name);
					this.syncDialogFocusMode();
				} else {
					this.clearCategoryFlow();
					this.startTorrentWithToast(result.id);
				}
			})
			.catch((err: unknown) => {
				this.clearCategoryFlow();
				this.toastManager.show({
					id: `confirm-add-err-${Date.now()}`,
					type: "error",
					title: "Failed to add",
					message: err instanceof Error ? err.message : String(err),
				});
			});
	}

	private createCategory(result: CategoryDialogResult): void {
		if (this.categoryDialogContext?.kind === "manager-edit") {
			this.updateExistingCategory(
				this.categoryDialogContext.categoryId,
				result,
			);
			this.removeModal("new-category");
			this.categoryDialogContext = null;
			this.categoryManagerDialog.show(this.config.categories);
			this.syncDialogFocusMode();
			return;
		}

		const category = createCategory(this.config.categories, {
			name: result.name,
			savePath: result.savePath,
		});
		this.config = {
			...this.config,
			categories: [...this.config.categories, category],
		};
		saveConfig(this.config);
		this.store.setState({ categories: this.config.categories });
		this.removeModal("new-category");
		if (this.categoryDialogContext?.kind === "manager-new") {
			this.categoryDialogContext = null;
			this.categoryManagerDialog.show(this.config.categories);
			this.syncDialogFocusMode();
			return;
		}
		this.categoryDialogContext = null;
		this.categorySelectDialog.close();
		this.removeModal("category-select");
		this.applySelectedCategory(category);
	}

	private updateExistingCategory(
		categoryId: string,
		result: CategoryDialogResult,
	): void {
		const before = this.config.categories.find(
			(category) => category.id === categoryId,
		);
		this.config = {
			...this.config,
			categories: updateCategory(this.config.categories, categoryId, {
				name: result.name,
				savePath: result.savePath,
			}),
		};
		saveConfig(this.config);
		this.store.setState({ categories: this.config.categories });
		const after = this.config.categories.find(
			(category) => category.id === categoryId,
		);
		if (before && after && before.name !== after.name) {
			this.bridge.renameCategory(categoryId, after.name);
		}
	}

	private deleteCategory(categoryId: string): void {
		this.config = {
			...this.config,
			categories: this.config.categories.filter(
				(category) => category.id !== categoryId,
			),
			defaultCategoryId:
				this.config.defaultCategoryId === categoryId
					? null
					: this.config.defaultCategoryId,
		};
		saveConfig(this.config);
		this.store.setState({
			categories: this.config.categories,
		});
		this.bridge.clearCategory(categoryId);
	}

	private openCategoryManager(): void {
		this.modalStack = ["category-manager"];
		this.categoryManagerDialog.open(this.config.categories);
		this.syncDialogFocusMode();
	}

	private openCategorySelectForAdd(): void {
		this.categoryFlow = { kind: "add" };
		this.modalStack = ["category-select"];
		this.categorySelectDialog.open({
			categories: this.store.getState().categories,
			defaultCategoryId: this.config.defaultCategoryId,
			globalDownloadPath: resolvePath(this.config.downloadPath),
			mode: "add",
		});
		this.syncDialogFocusMode();
	}

	private openCategorySelectForReassign(torrentId: string): void {
		const torrent = this.store
			.getState()
			.torrents.find((t) => t.id === torrentId);
		if (!torrent) return;
		this.categoryFlow = { kind: "reassign", torrentId };
		this.modalStack = ["category-select"];
		this.categorySelectDialog.open({
			categories: this.store.getState().categories,
			currentCategoryId: torrent.categoryId,
			mode: "reassign",
		});
		this.syncDialogFocusMode();
	}

	private openDirectoryPickerForNewCategory(initialPath: string): void {
		this.categoryDialog.hide();
		this.modalStack.push("directory-picker");
		this.directoryPickerDialog.open(initialPath, "Choose category path");
		this.syncDialogFocusMode();
	}

	private applySelectedCategory(category: CategorySelectOption | null): void {
		const flow = this.categoryFlow;
		if (!flow) {
			this.syncDialogFocusMode();
			return;
		}

		if (flow.kind === "reassign") {
			this.bridge.setTorrentCategory(
				flow.torrentId,
				category ? { id: category.id ?? "", name: category.name } : null,
			);
			this.clearCategoryFlow();
			return;
		}

		const savePath = resolvePath(
			category?.savePath ?? this.config.downloadPath,
		);
		this.confirmPendingAdd({
			categoryId: category?.id ?? null,
			categoryName: category?.name ?? null,
			savePath,
		});
	}

	private closeTopModal(): void {
		switch (this.currentModal()) {
			case "add-source":
				this.addDialog.close();
				this.removeModal("add-source");
				this.syncDialogFocusMode();
				return;
			case "category-select":
				this.cancelCategoryFlow();
				return;
			case "new-category":
				this.categoryDialog.close();
				this.removeModal("new-category");
				if (this.categoryDialogContext?.kind === "select-new") {
					this.categorySelectDialog.show();
				} else {
					this.categoryManagerDialog.show(this.config.categories);
				}
				this.categoryDialogContext = null;
				this.syncDialogFocusMode();
				return;
			case "category-manager":
				this.categoryManagerDialog.close();
				this.removeModal("category-manager");
				this.syncDialogFocusMode();
				return;
			case "directory-picker":
				this.directoryPickerDialog.close();
				this.removeModal("directory-picker");
				this.categoryDialog.show();
				this.syncDialogFocusMode();
				return;
			case "file-picker":
				this.filePickerDialog.confirmWithAllFiles();
				return;
			default:
				this.syncDialogFocusMode();
		}
	}

	private cancelCategoryFlow(): void {
		this.pendingAdd = null;
		this.clearCategoryFlow();
	}

	private clearCategoryFlow(options: { keepFocus?: boolean } = {}): void {
		this.categoryFlow = null;
		this.categoryDialogContext = null;
		this.categorySelectDialog.close();
		this.categoryDialog.close();
		this.directoryPickerDialog.close();
		this.modalStack = this.modalStack.filter(
			(modal) =>
				modal !== "category-select" &&
				modal !== "new-category" &&
				modal !== "directory-picker",
		);
		if (!options.keepFocus) this.syncDialogFocusMode();
	}

	private currentModal(): ModalId | null {
		return this.modalStack[this.modalStack.length - 1] ?? null;
	}

	private removeModal(modal: ModalId): void {
		const index = this.modalStack.lastIndexOf(modal);
		if (index >= 0) this.modalStack.splice(index, 1);
	}

	private syncDialogFocusMode(): void {
		this.controller.focusMode =
			this.modalStack.length > 0 ? "dialog" : "global";
	}

	private startTorrentWithToast(id: string): void {
		this.bridge.startTorrent(id).catch((err: unknown) => {
			this.toastManager.show({
				id: `start-err-${Date.now()}`,
				type: "error",
				title: "Failed to start",
				message: err instanceof Error ? err.message : String(err),
			});
		});
	}
}
