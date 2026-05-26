export interface TorrentState {
	id: string;
	name: string;
	totalSize: number;
	downloadedPieces: number;
	totalPieces: number;
	status: "verifying" | "downloading" | "seeding" | "stopped" | "error";
	downloadBps: number;
	uploadBps: number;
	peers: number;
	etaSeconds: number | null;
}

export interface AppState {
	selectedIndex: number;
	selectedView: string;
	torrent: TorrentState | null;
	totalDownloadBps: number;
	totalUploadBps: number;
}

type Listener = (state: AppState) => void;

export class Store {
	private state: AppState;
	private listeners: Set<Listener> = new Set();

	constructor(initial: AppState) {
		this.state = { ...initial };
	}

	getState(): AppState {
		return { ...this.state };
	}

	setState(partial: Partial<AppState>): void {
		this.state = { ...this.state, ...partial };
		this.notify();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener(this.getState());
		}
	}
}
