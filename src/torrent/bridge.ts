import { existsSync, readFileSync } from "node:fs";
import type { AppSettings } from "../config/settings";
import type { Store, TorrentState } from "../store";
import { resolvePath } from "../utils/paths";
import { TorrentMetadata } from "./metadata";
import { decode } from "./parser";
import { TorrentSession } from "./session";
import { announce } from "./tracker/announce";
import { PeerManager } from "./peer/manager";

export class TorrentBridge {
	private store: Store;
	private config: AppSettings;
	private session: TorrentSession | null = null;
	private manager: PeerManager | null = null;
	private currentState: TorrentState | null = null;
	private pendingFlush = false;
	private downloadPath: string;

	constructor(store: Store, config: AppSettings) {
		this.store = store;
		this.config = config;
		this.downloadPath = resolvePath(config.downloadPath);
	}

	async setTorrent(torrentPath: string): Promise<void> {
		// Stop existing torrent if any
		await this.stopAll();

		const raw = new Uint8Array(readFileSync(torrentPath));
		const decoded = decode(raw);

		if (
			typeof decoded !== "object" ||
			decoded === null ||
			Array.isArray(decoded) ||
			decoded instanceof Uint8Array
		) {
			throw new Error("Invalid torrent file");
		}

		const metadata = new TorrentMetadata(
			decoded as { [key: string]: import("./parser").BencodeValue },
			raw,
		);

		const session = new TorrentSession(metadata, this.downloadPath);
		this.session = session;

		const id = Buffer.from(metadata.infoHash).toString("hex");
		this.currentState = {
			id,
			name: metadata.name,
			totalSize: metadata.totalSize,
			downloadedPieces: 0,
			totalPieces: metadata.pieceCount,
			status: "verifying",
			downloadBps: 0,
			uploadBps: 0,
			peers: 0,
			etaSeconds: null,
		};
		this.flush();

		// Verify + start
		await session.start();
		this.updateState({ downloadedPieces: session.storage.downloadedCount, status: "downloading" });

		// Announce
		const trackerResult = await announce(metadata).catch(() => null);
		const peers = trackerResult?.peers ?? [];

		const manager = new PeerManager(metadata, this.config.maxConnections);
		this.manager = manager;

		await manager.start();
		await manager.connect(peers);

		if (manager.connections.size === 0) {
			this.updateState({ status: "error" });
			return;
		}

		this.updateState({ peers: manager.connections.size });

		manager.on("peerAdded", () => {
			this.updateState({ peers: manager.connections.size });
		});

		// Attach listeners BEFORE session.download() — for already-complete torrents
		// downloader.start() fires "complete" synchronously, so listeners must exist first.
		session.on("progress", (dl: number, _total: number, speed: number) => {
			const uploadBps = [...manager.connections.values()].reduce(
				(sum, c) => sum + c.uploadBytesPerSec,
				0,
			);
			const remaining = metadata.pieceCount - dl;
			const etaSeconds = speed > 0 ? Math.round((remaining * metadata.pieceLength) / speed) : null;
			this.updateState({
				downloadedPieces: dl,
				downloadBps: Math.round(speed),
				uploadBps,
				etaSeconds,
				peers: manager.connections.size,
			});
		});

		session.on("status", (next: string) => {
			this.updateState({ status: next as TorrentState["status"] });
		});

		session.on("complete", () => {
			this.updateState({ status: "seeding", downloadBps: 0, etaSeconds: null });
		});

		manager.startChoking();
		session.download(manager); // fires synchronously if already complete
	}

	async stopAll(): Promise<void> {
		if (!this.session) return;
		// TorrentSession has no explicit stop, but we can clear references
		// The manager close disconnects all peers
		this.manager?.close();
		this.session = null;
		this.manager = null;
		this.currentState = null;
		this.store.setState({ torrent: null, totalDownloadBps: 0, totalUploadBps: 0 });
	}

	private updateState(partial: Partial<TorrentState>): void {
		if (!this.currentState) return;
		this.currentState = { ...this.currentState, ...partial };
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.pendingFlush) return;
		this.pendingFlush = true;
		setTimeout(() => {
			this.pendingFlush = false;
			this.flush();
		}, 100);
	}

	private flush(): void {
		if (!this.currentState) return;
		const uploadBps = this.currentState.uploadBps;
		const downloadBps = this.currentState.downloadBps;
		this.store.setState({
			torrent: { ...this.currentState },
			totalDownloadBps: downloadBps,
			totalUploadBps: uploadBps,
		});
	}
}
