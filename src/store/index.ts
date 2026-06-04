export type TorrentUiStatus =
	| "queued"
	| "metadata"
	| "checking"
	| "connecting"
	| "downloading"
	| "stalled"
	| "paused"
	| "seeding"
	| "stopped"
	| "error"
	| "missing";

export interface TorrentFileState {
	path: string;
	length: number;
	downloadedBytes: number;
	selected: boolean;
}

export interface TorrentPeerState {
	address: string;
	client: string;
	pieces: number;
	choked: boolean;
	downloadBps: number;
	uploadBps: number;
}

export interface TorrentState {
	id: string;
	name: string;
	targetPath: string;
	totalSize: number;
	pieceLength: number;
	downloadedPieces: number;
	totalPieces: number;
	status: TorrentUiStatus;
	downloadBps: number;
	uploadBps: number;
	peers: number;
	seeds: number;
	leechers: number;
	peerDetails: TorrentPeerState[];
	files: TorrentFileState[];
	etaSeconds: number | null;
}

export interface AppState {
	selectedIndex: number;
	selectedView: string;
	torrents: TorrentState[];
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
