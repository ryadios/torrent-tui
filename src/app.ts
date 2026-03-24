import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { loadConfig } from "./config";
import { AppController } from "./controllers/app-controller";
import { ContentWindow } from "./layout/content-window";
import { Sidebar } from "./layout/sidebar";
import { ToastManager } from "./layout/toast-manager";
import { Store } from "./store";
import type { LayoutDimensions } from "./types/layout";
import { calculateLayout } from "./utils/layout";

const INITIAL_STATE = {
	selectedIndex: 0,
	selectedView: "All",
};

export class App {
	private renderer!: CliRenderer;
	private store!: Store;
	private sidebar!: Sidebar;
	private contentWindow!: ContentWindow;
	private toastManager!: ToastManager;
	private controller!: AppController;
	private layout!: LayoutDimensions;
	private resizeTimeout: ReturnType<typeof setTimeout> | null = null;

	async start(): Promise<void> {
		loadConfig();

		await this.initialize();
		this.setupComponents();
		this.setupControllers();
		this.setupResizeHandler();
	}

	private async initialize(): Promise<void> {
		this.renderer = await createCliRenderer({
			exitOnCtrlC: true,
		});
		this.store = new Store(INITIAL_STATE);
		this.layout = calculateLayout(this.renderer.width, this.renderer.height);
	}

	private setupComponents(): void {
		this.sidebar = new Sidebar(this.renderer, this.store, this.layout);
		this.contentWindow = new ContentWindow(
			this.renderer,
			this.store,
			this.layout,
		);
		this.toastManager = new ToastManager(this.renderer, this.layout);
	}

	private setupControllers(): void {
		this.controller = new AppController(
			this.renderer,
			this.store,
			this.sidebar,
			this.contentWindow,
			this.toastManager,
		);
		this.controller.start();
	}

	private setupResizeHandler(): void {
		this.renderer.on("resize", (width: number, height: number) => {
			this.handleResize(width, height);
		});
	}

	private handleResize(width: number, height: number): void {
		if (this.resizeTimeout) {
			clearTimeout(this.resizeTimeout);
		}

		this.resizeTimeout = setTimeout(() => {
			this.resizeTimeout = null;
			this.layout = calculateLayout(width, height);
			this.sidebar.updateLayout(this.layout);
			this.contentWindow.updateLayout(this.layout);
			this.toastManager.updateLayout(this.layout);
		}, 100);
	}
}
