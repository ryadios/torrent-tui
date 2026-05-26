import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings } from "../config/settings";
import type { Store, TorrentState } from "../store";
import { getDataDir, resolvePath } from "../utils/paths";
import { TorrentMetadata } from "./metadata";
import { decode } from "./parser";
import type { BencodeValue } from "./parser";
import { TorrentSession } from "./session";
import { announce } from "./tracker/announce";
import { PeerManager } from "./peer/manager";
import type { Downloader } from "./downloader";

interface TorrentEntry {
	torrentPath: string;
	session: TorrentSession | null;
	manager: PeerManager | null;
	downloader: Downloader | null;
	state: TorrentState;
}

interface SessionRegistry {
	torrents: Array<{ infoHash: string; torrentPath: string }>;
}

export class TorrentBridge {
	private store: Store;
	private config: AppSettings;
	private torrents: Map<string, TorrentEntry> = new Map();
	private pendingFlush = false;
	private downloadPath: string;

	constructor(store: Store, config: AppSettings) {
		this.store = store;
		this.config = config;
		this.downloadPath = resolvePath(config.downloadPath);
	}

	async restoreSession(): Promise<void> {
		const registryPath = this.registryPath();
		if (!existsSync(registryPath)) return;

		let registry: SessionRegistry;
		try {
			registry = JSON.parse(readFileSync(registryPath, "utf-8")) as SessionRegistry;
		} catch {
			return;
		}

		for (const { infoHash, torrentPath } of registry.torrents) {
			if (!existsSync(torrentPath)) continue;
			try {
				const metadata = this.parseTorrent(torrentPath);
				const actualId = Buffer.from(metadata.infoHash).toString("hex");
				if (actualId !== infoHash) continue;

				const downloadedPieces = this.loadResumeCount(infoHash);
				const entry: TorrentEntry = {
					torrentPath,
					session: null,
					manager: null,
					downloader: null,
					state: {
						id: infoHash,
						name: metadata.name,
						totalSize: metadata.totalSize,
						downloadedPieces,
						totalPieces: metadata.pieceCount,
						status: "stopped",
						downloadBps: 0,
						uploadBps: 0,
						peers: 0,
						etaSeconds: null,
					},
				};
				this.torrents.set(infoHash, entry);
			} catch {
				// skip invalid/unreadable torrent files
			}
		}

		this.flushAll();
	}

	async addTorrent(torrentPath: string): Promise<void> {
		const metadata = this.parseTorrent(torrentPath);
		const id = Buffer.from(metadata.infoHash).toString("hex");

		if (this.torrents.has(id)) return;

		const entry: TorrentEntry = {
			torrentPath,
			session: null,
			manager: null,
			downloader: null,
			state: {
				id,
				name: metadata.name,
				totalSize: metadata.totalSize,
				downloadedPieces: 0,
				totalPieces: metadata.pieceCount,
				status: "stopped",
				downloadBps: 0,
				uploadBps: 0,
				peers: 0,
				etaSeconds: null,
			},
		};
		this.torrents.set(id, entry);
		this.saveRegistry();
		this.flushAll();

		await this.runDownload(id, metadata);
	}

	async startTorrent(id: string): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry || entry.session !== null) return;
		const metadata = this.parseTorrent(entry.torrentPath);
		await this.runDownload(id, metadata);
	}

	async pauseTorrent(id: string): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry?.downloader || entry.state.status !== "downloading") return;
		entry.downloader.pause();
		this.updateEntry(id, { status: "paused", downloadBps: 0, etaSeconds: null });
	}

	async resumeTorrent(id: string): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry?.downloader || entry.state.status !== "paused") return;
		entry.downloader.resume();
		this.updateEntry(id, { status: "downloading" });
	}

	async removeTorrent(id: string, deleteFiles: boolean): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry) return;

		entry.downloader?.stop();
		entry.manager?.close();

		if (deleteFiles) {
			try {
				const metadata = this.parseTorrent(entry.torrentPath);
				if (metadata.files.length === 1 && metadata.files[0]) {
					rmSync(join(this.downloadPath, metadata.files[0].path), { force: true });
				} else {
					rmSync(join(this.downloadPath, metadata.name), { recursive: true, force: true });
				}
			} catch {
				// ignore deletion errors
			}
		}

		this.torrents.delete(id);
		this.saveRegistry();
		this.flushAll();
	}

	async stopAll(): Promise<void> {
		for (const entry of this.torrents.values()) {
			entry.downloader?.stop();
			entry.manager?.close();
		}
		this.torrents.clear();
		this.store.setState({ torrents: [], totalDownloadBps: 0, totalUploadBps: 0 });
	}

	private async runDownload(id: string, metadata: TorrentMetadata): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry) return;

		const session = new TorrentSession(metadata, this.downloadPath);
		entry.session = session;

		this.updateEntry(id, { status: "verifying" });

		await session.start();
		this.updateEntry(id, { downloadedPieces: session.storage.downloadedCount, status: "downloading" });

		const trackerResult = await announce(metadata).catch(() => null);
		const peers = trackerResult?.peers ?? [];

		const manager = new PeerManager(metadata, this.config.maxConnections);
		entry.manager = manager;

		await manager.start();
		await manager.connect(peers);

		if (manager.connections.size === 0) {
			this.updateEntry(id, { status: "error" });
			return;
		}

		this.updateEntry(id, { peers: manager.connections.size });

		manager.on("peerAdded", () => {
			this.updateEntry(id, { peers: manager.connections.size });
		});

		// Attach listeners BEFORE session.download() — for already-complete torrents
		session.on("progress", (dl: number, _total: number, speed: number) => {
			if (!this.torrents.has(id)) return;
			const uploadBps = [...manager.connections.values()].reduce(
				(sum, c) => sum + c.uploadBytesPerSec,
				0,
			);
			const remaining = metadata.pieceCount - dl;
			const etaSeconds = speed > 0 ? Math.round((remaining * metadata.pieceLength) / speed) : null;
			this.updateEntry(id, {
				downloadedPieces: dl,
				downloadBps: Math.round(speed),
				uploadBps,
				etaSeconds,
				peers: manager.connections.size,
			});
		});

		session.on("status", (next: string) => {
			if (!this.torrents.has(id)) return;
			this.updateEntry(id, { status: next as TorrentState["status"] });
		});

		session.on("complete", () => {
			if (!this.torrents.has(id)) return;
			this.updateEntry(id, { status: "seeding", downloadBps: 0, etaSeconds: null });
		});

		manager.startChoking();
		const downloader = session.download(manager);
		entry.downloader = downloader;
	}

	private parseTorrent(torrentPath: string): TorrentMetadata {
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
		return new TorrentMetadata(decoded as { [key: string]: BencodeValue }, raw);
	}

	private loadResumeCount(infoHash: string): number {
		const path = join(getDataDir(), "resume", `${infoHash}.json`);
		if (!existsSync(path)) return 0;
		try {
			const data = JSON.parse(readFileSync(path, "utf-8")) as { downloadedPieces?: number[] };
			return data.downloadedPieces?.length ?? 0;
		} catch {
			return 0;
		}
	}

	private registryPath(): string {
		return join(getDataDir(), "session.json");
	}

	private saveRegistry(): void {
		const dir = getDataDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const entries = [...this.torrents.entries()].map(([infoHash, entry]) => ({
			infoHash,
			torrentPath: entry.torrentPath,
		}));
		try {
			writeFileSync(this.registryPath(), JSON.stringify({ torrents: entries }, null, 2), "utf-8");
		} catch {
			// non-fatal
		}
	}

	private updateEntry(id: string, partial: Partial<TorrentState>): void {
		const entry = this.torrents.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, ...partial };
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.pendingFlush) return;
		this.pendingFlush = true;
		setTimeout(() => {
			this.pendingFlush = false;
			this.flushAll();
		}, 100);
	}

	private flushAll(): void {
		const states = [...this.torrents.values()].map((e) => e.state);
		const totalDownloadBps = states.reduce((s, t) => s + t.downloadBps, 0);
		const totalUploadBps = states.reduce((s, t) => s + t.uploadBps, 0);
		this.store.setState({ torrents: states, totalDownloadBps, totalUploadBps });
	}
}
