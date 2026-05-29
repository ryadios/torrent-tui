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
import {
	loadTrustedResumeData,
	readResumeData,
	writeResumeData,
} from "./resume";
import { TorrentSession } from "./session";
import { StorageManager, VerificationCancelledError } from "./storage";
import { announce } from "./tracker/announce";
import { TrackerCoordinator } from "./tracker/coordinator";

interface TorrentEntry {
	torrentPath: string;
	session: TorrentSession | null;
	manager: PeerManager | null;
	trackerCoordinator: TrackerCoordinator | null;
	downloader: Downloader | null;
	checkingAbort: AbortController | null;
	checkingPromise: Promise<void> | null;
	state: TorrentState;
}

interface SessionRegistry {
	schemaVersion: number;
	torrents: Array<{ infoHash: string; torrentPath: string }>;
}

interface RestoreCheckJob {
	current: number;
	id: string;
	metadata: TorrentMetadata;
	onProgress?: (progress: RestoreProgress) => void;
	total: number;
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
	private restoreCheckQueue: RestoreCheckJob[] = [];
	private restoreCheckRunning = false;
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
		this.restoreCheckQueue = [];

		for (const { infoHash, torrentPath } of registry.torrents) {
			current++;
			if (!existsSync(torrentPath)) continue;
			try {
				const metadata = this.parseTorrent(torrentPath);
				const actualId = Buffer.from(metadata.infoHash).toString("hex");
				if (actualId !== infoHash) continue;

				const trustedResume = loadTrustedResumeData(
					metadata,
					this.downloadPath,
				);
				const downloadedPieces = trustedResume?.verifiedPieces.length ?? 0;
				const resumeComplete = downloadedPieces >= metadata.pieceCount;

				if (!trustedResume) {
					const resumeData = readResumeData(infoHash);
					const resumeCount =
						resumeData?.verifiedPieces?.length ??
						resumeData?.downloadedPieces?.length ??
						0;
					if (resumeCount >= metadata.pieceCount) {
						log("restore", `${metadata.name}   resume data stale; rechecking`);
					}
				}

				const finalStatus: TorrentState["status"] = resumeComplete
					? "seeding"
					: trustedResume
						? "stopped"
						: "checking";

				const entry: TorrentEntry = {
					torrentPath,
					session: null,
					manager: null,
					trackerCoordinator: null,
					downloader: null,
					checkingAbort: null,
					checkingPromise: null,
					state: {
						id: infoHash,
						name: metadata.name,
						targetPath: this.targetPathFor(metadata),
						totalSize: metadata.totalSize,
						pieceLength: metadata.pieceLength,
						downloadedPieces,
						totalPieces: metadata.pieceCount,
						status: finalStatus,
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

				if (!trustedResume) {
					this.restoreCheckQueue.push({
						current,
						id: infoHash,
						metadata,
						onProgress,
						total,
					});
				} else {
					onProgress?.({
						current,
						total,
						name: metadata.name,
						checkedPieces: metadata.pieceCount,
						totalPieces: metadata.pieceCount,
						trustedComplete: true,
					});
				}

				log(
					"restore",
					`${metadata.name}   ${downloadedPieces}/${metadata.pieceCount} pieces   ${finalStatus}`,
				);
			} catch {
				// skip invalid/unreadable torrent files
			}
		}

		this.flushAll();
		this.startRestoreCheckQueue();
	}

	async verifyTrustedRestores(): Promise<void> {
		// Deprecated — verification now runs via restore check queue
	}

	private startRestoreCheckQueue(): void {
		if (this.restoreCheckRunning) return;
		this.restoreCheckRunning = true;
		void this.runRestoreCheckQueue();
	}

	private async runRestoreCheckQueue(): Promise<void> {
		try {
			while (this.restoreCheckQueue.length > 0) {
				const job = this.restoreCheckQueue.shift();
				if (!job || !this.torrents.has(job.id)) continue;
				await this.runRestoreCheck(job);
			}
		} finally {
			this.restoreCheckRunning = false;
			if (this.restoreCheckQueue.length > 0) this.startRestoreCheckQueue();
		}
	}

	private async runRestoreCheck(job: RestoreCheckJob): Promise<void> {
		const entry = this.torrents.get(job.id);
		if (!entry) return;

		const controller = new AbortController();
		entry.checkingAbort = controller;

		const checkPromise = this.verifyRestoreJob(job, controller);
		entry.checkingPromise = checkPromise;
		try {
			await checkPromise;
		} finally {
			const current = this.torrents.get(job.id);
			if (current?.checkingPromise === checkPromise) {
				current.checkingAbort = null;
				current.checkingPromise = null;
			}
		}
	}

	private async verifyRestoreJob(
		job: RestoreCheckJob,
		controller: AbortController,
	): Promise<void> {
		const storage = new StorageManager(job.metadata, this.downloadPath);
		try {
			const resumeData = readResumeData(job.id);
			const resumeCount =
				resumeData?.verifiedPieces?.length ??
				resumeData?.downloadedPieces?.length ??
				0;
			const summary = await storage.verifyAll({
				tolerateMissing: true,
				signal: controller.signal,
				onProgress: (checked, valid) => {
					this.updateEntry(job.id, {
						downloadedPieces: valid,
						status: "checking",
					});
					job.onProgress?.({
						current: job.current,
						total: job.total,
						name: job.metadata.name,
						checkedPieces: checked,
						totalPieces: job.metadata.pieceCount,
						trustedComplete: false,
					});
				},
			});

			if (summary.corrupt === 0) {
				writeResumeData(
					job.metadata,
					this.downloadPath,
					storage.getDownloadedPieces(),
				);
			}

			const downloadedPieces = storage.downloadedCount;
			const status =
				downloadedPieces === job.metadata.pieceCount
					? "seeding"
					: summary.missing > 0
						? "missing"
						: downloadedPieces < resumeCount || summary.corrupt > 0
							? "error"
							: "stopped";
			this.updateEntry(job.id, {
				downloadedPieces,
				status,
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			log(
				"restore",
				`${job.metadata.name}   ${downloadedPieces}/${job.metadata.pieceCount} pieces   ${status}`,
			);
		} catch (err) {
			if (
				err instanceof VerificationCancelledError ||
				controller.signal.aborted
			) {
				this.updateEntry(job.id, {
					status: "stopped",
					downloadBps: 0,
					uploadBps: 0,
					etaSeconds: null,
				});
				return;
			}
			this.updateEntry(job.id, {
				status: "error",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
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
			trackerCoordinator: null,
			downloader: null,
			checkingAbort: null,
			checkingPromise: null,
			state: {
				id,
				name: metadata.name,
				targetPath: this.targetPathFor(metadata),
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
		if (entry.state.status === "checking" && !entry.checkingPromise) return;
		if (entry.checkingPromise) {
			await entry.checkingPromise.catch(() => {});
			if (!this.torrents.has(id)) return;
		}
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

		this.restoreCheckQueue = this.restoreCheckQueue.filter(
			(job) => job.id !== id,
		);
		entry.checkingAbort?.abort();
		if (entry.checkingPromise) {
			await entry.checkingPromise.catch(() => {});
		}
		entry.downloader?.stop();
		await entry.trackerCoordinator?.stop();
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
		const checking: Promise<void>[] = [];
		this.restoreCheckQueue = [];
		for (const entry of this.torrents.values()) {
			entry.checkingAbort?.abort();
			if (entry.checkingPromise) checking.push(entry.checkingPromise);
			entry.downloader?.stop();
			await entry.trackerCoordinator?.stop();
			entry.manager?.close();
		}
		await Promise.allSettled(checking);
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
		const checkingAbort = new AbortController();
		entry.checkingAbort = checkingAbort;

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
			const checkingPromise = session.startWithOptions({
				verifyYieldEveryPieces: 8,
				verifyYieldEveryMs: 16,
				signal: checkingAbort.signal,
			});
			entry.checkingPromise = checkingPromise;
			await checkingPromise;
		} catch (err) {
			entry.checkingAbort = null;
			entry.checkingPromise = null;
			if (!this.torrents.has(id)) return;
			if (
				err instanceof VerificationCancelledError ||
				session.status === "stopped" ||
				checkingAbort.signal.aborted
			) {
				entry.session = null;
				this.updateEntry(id, {
					status: "stopped",
					downloadBps: 0,
					uploadBps: 0,
					etaSeconds: null,
				});
				return;
			}
			entry.session = null;
			this.updateEntry(id, {
				status: "error",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			return;
		}
		entry.checkingAbort = null;
		entry.checkingPromise = null;

		if (!this.torrents.has(id)) return;

		const complete = session.storage.downloadedCount === metadata.pieceCount;
		this.updateEntry(id, {
			downloadedPieces: session.storage.downloadedCount,
			status: complete ? "seeding" : "connecting",
			downloadBps: 0,
			uploadBps: 0,
			etaSeconds: null,
		});

		const manager = new PeerManager(metadata, this.config.maxConnections);
		entry.manager = manager;
		const trackerCoordinator = new TrackerCoordinator(metadata, {
			getSnapshot: () => {
				const current = this.torrents.get(id);
				const storage = current?.session?.storage ?? session.storage;
				const uploaded =
					current?.manager
						? [...current.manager.connections.values()].reduce(
								(sum, conn) => sum + conn.uploadedTotal,
								0,
							)
						: 0;
				const downloaded = storage.downloadedBytes;
				return {
					downloaded,
					uploaded,
					left: Math.max(0, metadata.totalSize - downloaded),
				};
			},
			onPeers: (peers) => {
				const current = this.torrents.get(id);
				const currentManager = current?.manager;
				if (!current || !currentManager) return;
				void currentManager.connect(peers).then(() => {
					if (!this.torrents.has(id)) return;
					this.updateEntry(id, {
						status:
							currentManager.connections.size > 0
								? current.state.status === "paused"
									? "paused"
									: current.session?.status === "seeding"
										? "seeding"
										: "downloading"
								: "stalled",
						peers: currentManager.connections.size,
						peerDetails: this.getPeerDetails(currentManager),
					});
				});
			},
		});
		entry.trackerCoordinator = trackerCoordinator;

		try {
			await manager.start();
			trackerCoordinator.start();
			if (!this.torrents.has(id)) {
				await trackerCoordinator.stop();
				manager.close();
				return;
			}
		} catch {
			manager.close();
			await trackerCoordinator.stop();
			entry.manager = null;
			entry.trackerCoordinator = null;
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
			status:
				manager.connections.size > 0
					? complete
						? "seeding"
						: "downloading"
					: complete
						? "seeding"
						: "stalled",
		});

		manager.on("peerAdded", () => {
			this.updateEntry(id, {
				status:
					entry.state.status === "paused"
						? "paused"
						: session.status === "seeding"
							? "seeding"
							: "downloading",
				peers: manager.connections.size,
				peerDetails: this.getPeerDetails(manager),
			});
		});
		manager.on("peerRemoved", () => {
			this.updateEntry(id, {
				status:
					entry.state.status === "paused"
						? "paused"
						: manager.connections.size > 0
							? session.status === "seeding"
								? "seeding"
								: "downloading"
							: session.status === "seeding"
								? "seeding"
								: "stalled",
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
		session.on("complete", () => {
			trackerCoordinator.markCompleted();
		});
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

	private registryPath(): string {
		return join(getDataDir(), "session.json");
	}

	private targetPathFor(metadata: TorrentMetadata): string {
		if (metadata.files.length === 1 && metadata.files[0]) {
			return join(this.downloadPath, metadata.files[0].path);
		}
		return join(this.downloadPath, metadata.name);
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
