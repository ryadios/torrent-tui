import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings } from "../config/settings";
import type { Store, TorrentPeerState, TorrentState } from "../store";
import { writeJsonAtomic } from "../utils/json";
import { getDataDir, resolvePath } from "../utils/paths";
import type { Downloader } from "./downloader";
import { log, TorrentMetadata } from "./metadata";
import type { BencodeValue } from "./parser";
import { decode } from "./parser";
import { PeerManager } from "./peer/manager";
import { TorrentSession } from "./session";
import { StorageManager } from "./storage";
import { announce } from "./tracker/announce";

interface TorrentEntry {
	torrentPath: string;
	session: TorrentSession | null;
	manager: PeerManager | null;
	downloader: Downloader | null;
	state: TorrentState;
}

interface SessionRegistry {
	schemaVersion: number;
	torrents: Array<{ infoHash: string; torrentPath: string }>;
}

export interface RestoreProgress {
	current: number;
	total: number;
	name: string;
	checkedPieces: number;
	totalPieces: number;
	trustedComplete: boolean;
}

export interface AddTorrentResult {
	id: string;
	name: string;
	added: boolean;
}

export class TorrentBridge {
	private store: Store;
	private config: AppSettings;
	private torrents: Map<string, TorrentEntry> = new Map();
	private trustedRestores: string[] = [];
	private pendingFlush = false;
	private downloadPath: string;

	constructor(store: Store, config: AppSettings) {
		this.store = store;
		this.config = config;
		this.downloadPath = resolvePath(config.downloadPath);
	}

	async restoreSession(
		onProgress?: (progress: RestoreProgress) => void,
	): Promise<void> {
		const registryPath = this.registryPath();
		if (!existsSync(registryPath)) return;

		let registry: Partial<SessionRegistry>;
		try {
			registry = JSON.parse(
				readFileSync(registryPath, "utf-8"),
			) as Partial<SessionRegistry>;
		} catch {
			return;
		}

		if (!Array.isArray(registry.torrents)) return;

		const total = registry.torrents.length;
		let current = 0;
		this.trustedRestores = [];

		for (const { infoHash, torrentPath } of registry.torrents) {
			current++;
			if (!existsSync(torrentPath)) continue;
			try {
				const metadata = this.parseTorrent(torrentPath);
				const actualId = Buffer.from(metadata.infoHash).toString("hex");
				if (actualId !== infoHash) continue;

				const resumeCount = this.loadResumeCount(infoHash);
				const resumeComplete = resumeCount >= metadata.pieceCount;
				let downloadedPieces = resumeComplete ? metadata.pieceCount : 0;
				let status: TorrentState["status"] = resumeComplete
					? "seeding"
					: "stopped";

				if (!resumeComplete) {
					const storage = new StorageManager(metadata, this.downloadPath);
					const summary = await storage.verifyAll({
						tolerateMissing: true,
						onProgress: (checked, valid) => {
							onProgress?.({
								current,
								total,
								name: metadata.name,
								checkedPieces: checked,
								totalPieces: metadata.pieceCount,
								trustedComplete: false,
							});
							downloadedPieces = valid;
						},
					});
					downloadedPieces = storage.downloadedCount;
					status =
						downloadedPieces === metadata.pieceCount
							? "seeding"
							: downloadedPieces < resumeCount || summary.corrupt > 0
								? "error"
								: "stopped";
				} else {
					this.trustedRestores.push(infoHash);
					onProgress?.({
						current,
						total,
						name: metadata.name,
						checkedPieces: metadata.pieceCount,
						totalPieces: metadata.pieceCount,
						trustedComplete: true,
					});
				}

				const entry: TorrentEntry = {
					torrentPath,
					session: null,
					manager: null,
					downloader: null,
					state: {
						id: infoHash,
						name: metadata.name,
						totalSize: metadata.totalSize,
						pieceLength: metadata.pieceLength,
						downloadedPieces,
						totalPieces: metadata.pieceCount,
						status,
						downloadBps: 0,
						uploadBps: 0,
						peers: 0,
						peerDetails: [],
						files: metadata.files.map((file) => ({
							path: file.path,
							length: file.length,
						})),
						etaSeconds: null,
					},
				};
				this.torrents.set(infoHash, entry);
				log(
					"restore",
					`${metadata.name}   ${downloadedPieces}/${metadata.pieceCount} pieces   ${status}`,
				);
			} catch {
				// skip invalid/unreadable torrent files
			}
		}

		this.flushAll();
	}

	async verifyTrustedRestores(): Promise<void> {
		const trustedIds = [...this.trustedRestores];
		this.trustedRestores = [];

		for (const id of trustedIds) {
			const entry = this.torrents.get(id);
			if (!entry) continue;

			try {
				const metadata = this.parseTorrent(entry.torrentPath);
				const storage = new StorageManager(metadata, this.downloadPath);
				const summary = await storage.verifyAll({
					tolerateMissing: true,
					yieldEveryPieces: 8,
					yieldEveryMs: 16,
				});
				if (
					summary.valid === metadata.pieceCount &&
					summary.missing === 0 &&
					summary.corrupt === 0
				) {
					this.updateEntry(id, {
						downloadedPieces: metadata.pieceCount,
						status: "seeding",
					});
					continue;
				}

				this.updateEntry(id, {
					downloadedPieces: summary.valid,
					status: "error",
					downloadBps: 0,
					uploadBps: 0,
					etaSeconds: null,
				});
			} catch {
				this.updateEntry(id, {
					status: "error",
					downloadBps: 0,
					uploadBps: 0,
					etaSeconds: null,
				});
			}
		}
	}

	async addTorrent(torrentPath: string): Promise<AddTorrentResult> {
		const metadata = this.parseTorrent(torrentPath);
		const id = Buffer.from(metadata.infoHash).toString("hex");

		if (this.torrents.has(id)) return { id, name: metadata.name, added: false };

		const entry: TorrentEntry = {
			torrentPath,
			session: null,
			manager: null,
			downloader: null,
			state: {
				id,
				name: metadata.name,
				totalSize: metadata.totalSize,
				pieceLength: metadata.pieceLength,
				downloadedPieces: 0,
				totalPieces: metadata.pieceCount,
				status: "queued",
				downloadBps: 0,
				uploadBps: 0,
				peers: 0,
				peerDetails: [],
				files: metadata.files.map((file) => ({
					path: file.path,
					length: file.length,
				})),
				etaSeconds: null,
			},
		};
		this.torrents.set(id, entry);
		this.saveRegistry();
		this.flushAll();

		return { id, name: metadata.name, added: true };
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
		this.updateEntry(id, {
			status: "paused",
			downloadBps: 0,
			etaSeconds: null,
		});
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
					rmSync(join(this.downloadPath, metadata.files[0].path), {
						force: true,
					});
				} else {
					rmSync(join(this.downloadPath, metadata.name), {
						recursive: true,
						force: true,
					});
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
		this.store.setState({
			torrents: [],
			totalDownloadBps: 0,
			totalUploadBps: 0,
		});
	}

	private async runDownload(
		id: string,
		metadata: TorrentMetadata,
	): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry) return;

		const session = new TorrentSession(metadata, this.downloadPath);
		entry.session = session;

		session.on("status", (next: string) => {
			if (!this.torrents.has(id)) return;
			if (next === "ready") return;
			this.updateEntry(id, { status: next as TorrentState["status"] });
		});

		session.on(
			"checking",
			(_checked: number, _total: number, valid: number) => {
				if (!this.torrents.has(id)) return;
				this.updateEntry(id, { downloadedPieces: valid, status: "checking" });
			},
		);

		session.on("complete", () => {
			if (!this.torrents.has(id)) return;
			this.updateEntry(id, {
				status: "seeding",
				downloadBps: 0,
				etaSeconds: null,
			});
		});

		this.updateEntry(id, {
			status: "checking",
			downloadBps: 0,
			uploadBps: 0,
			etaSeconds: null,
		});

		try {
			await session.startWithOptions({
				verifyYieldEveryPieces: 8,
				verifyYieldEveryMs: 16,
			});
		} catch {
			entry.session = null;
			this.updateEntry(id, {
				status: "error",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			return;
		}

		const complete = session.storage.downloadedCount === metadata.pieceCount;
		this.updateEntry(id, {
			downloadedPieces: session.storage.downloadedCount,
			status: complete ? "seeding" : "connecting",
			downloadBps: 0,
			uploadBps: 0,
			etaSeconds: null,
		});

		const trackerResult = await announce(metadata).catch(() => null);
		const peers = trackerResult?.peers ?? [];

		const manager = new PeerManager(metadata, this.config.maxConnections);
		entry.manager = manager;

		try {
			await manager.start();
			await manager.connect(peers);
		} catch {
			manager.close();
			entry.manager = null;
			entry.session = null;
			this.updateEntry(id, {
				status: complete ? "seeding" : "stalled",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			return;
		}

		if (manager.connections.size === 0) {
			manager.close();
			entry.manager = null;
			entry.session = null;
			this.updateEntry(id, {
				status: complete ? "seeding" : "stalled",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			return;
		}

		this.updateEntry(id, {
			peers: manager.connections.size,
			peerDetails: this.getPeerDetails(manager),
		});

		manager.on("peerAdded", () => {
			this.updateEntry(id, {
				peers: manager.connections.size,
				peerDetails: this.getPeerDetails(manager),
			});
		});

		session.on("progress", (dl: number, _total: number, speed: number) => {
			if (!this.torrents.has(id)) return;
			const uploadBps = [...manager.connections.values()].reduce(
				(sum, c) => sum + c.uploadBytesPerSec,
				0,
			);
			const remaining = metadata.pieceCount - dl;
			const etaSeconds =
				speed > 0
					? Math.round((remaining * metadata.pieceLength) / speed)
					: null;
			this.updateEntry(id, {
				downloadedPieces: dl,
				downloadBps: Math.round(speed),
				uploadBps,
				etaSeconds,
				peers: manager.connections.size,
				peerDetails: this.getPeerDetails(manager),
			});
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
			const data = JSON.parse(readFileSync(path, "utf-8")) as {
				downloadedPieces?: number[];
			};
			return data.downloadedPieces?.length ?? 0;
		} catch {
			return 0;
		}
	}

	private registryPath(): string {
		return join(getDataDir(), "session.json");
	}

	private saveRegistry(): void {
		const entries = [...this.torrents.entries()].map(([infoHash, entry]) => ({
			infoHash,
			torrentPath: entry.torrentPath,
		}));
		writeJsonAtomic(this.registryPath(), {
			schemaVersion: 1,
			torrents: entries,
		});
	}

	private updateEntry(id: string, partial: Partial<TorrentState>): void {
		const entry = this.torrents.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, ...partial };
		this.scheduleFlush();
	}

	private getPeerDetails(manager: PeerManager): TorrentPeerState[] {
		return [...manager.connections.values()].map((peer) => ({
			address: `${peer.address}:${peer.port}`,
			client: peer.peerId.slice(0, 8),
			pieces: peer.countPiecesPublic(),
			choked: peer.amChoked,
			downloadBps: peer.downloadBytesPerSec,
			uploadBps: peer.uploadBytesPerSec,
		}));
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
