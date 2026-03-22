import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { loadConfig } from "./config";
import { AppController } from "./controllers/app-controller";
import { Sidebar } from "./layout/Sidebar";
import { type AppState, Store } from "./store";

const INITIAL_STATE: AppState = {
	selectedIndex: 0,
	selectedView: "All",
};

export class App {
	private renderer!: CliRenderer;
	private store!: Store;
	private sidebar!: Sidebar;
	private controller!: AppController;

	async start(): Promise<void> {
		loadConfig();

		await this.initialize();
		this.setupComponents();
		this.setupControllers();
		this.render();
	}

	private async initialize(): Promise<void> {
		this.renderer = await createCliRenderer({ exitOnCtrlC: true });
		this.store = new Store(INITIAL_STATE);
	}

	private setupComponents(): void {
		this.sidebar = new Sidebar(this.renderer, this.store);
	}

	private setupControllers(): void {
		this.controller = new AppController(
			this.renderer,
			this.store,
			this.sidebar,
		);
		this.controller.start();
	}

	private render(): void {
		this.sidebar.render();
	}
}
