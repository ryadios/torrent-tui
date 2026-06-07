import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type AppSettings, DEFAULT_SETTINGS } from "../config/settings";
import type { Store, TorrentPeerState, TorrentState } from "../store";
import { writeJsonAtomic } from "../utils/json";
import { getDataDir, resolvePath } from "../utils/paths";
import { type Blocklist, loadBlocklist } from "./blocklist";
import { DiscoveryCoordinator } from "./discovery/coordinator";
import type { Downloader } from "./downloader";
import { parseMagnetUri } from "./magnet";
import {
	type MagnetResolveProgress,
	resolveMagnetToTorrent,
} from "./magnet-resolver";
import { log, TorrentMetadata } from "./metadata";
import type { BencodeValue } from "./parser";
import { decode } from "./parser";
import type { PeerConnection } from "./peer/connection";
import { PeerManager } from "./peer/manager";
import {
	loadTrustedResumeData,
	normalizeSelectedFileIndices,
	readResumeData,
	writeResumeData,
} from "./resume";
import { TorrentSession } from "./session";
import { StorageManager, VerificationCancelledError } from "./storage";
import type { TorrentStatus } from "./types";
import {
	createUploadedAccumulator,
	recordRemovedPeerUpload,
	type UploadedAccumulator,
	uploadedSnapshot,
} from "./upload-accounting";

interface TorrentEntry {
	torrentPath: string;
	magnetUri?: string;
	savePath: string;
	categoryId: string | null;
	categoryName: string | null;
	session: TorrentSession | null;
	manager: PeerManager | null;
	trackerCoordinator: DiscoveryCoordinator | null;
	downloader: Downloader | null;
	hasTransferActivity: boolean;
	uploadedAccumulator: UploadedAccumulator;
	checkingAbort: AbortController | null;
	checkingPromise: Promise<void> | null;
	selectedFileIndices: number[] | null;
	fileDownloadedBytes: number[];
	state: TorrentState;
}

interface SessionRegistry {
	schemaVersion: number;
	torrents: Array<{
		infoHash: string;
		torrentPath: string;
		magnetUri?: string;
		savePath?: string;
		categoryId?: string | null;
		categoryName?: string | null;
	}>;
}

interface RestoreCheckJob {
	current: number;
	id: string;
	metadata: TorrentMetadata;
	onProgress?: (progress: RestoreProgress) => void;
	savePath: string;
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

export interface PreparedTorrentAdd extends AddTorrentResult {
	files: TorrentState["files"];
	isMultiFile: boolean;
	magnetUri?: string;
	pieceLength: number;
	torrentPath: string;
	totalPieces: number;
	totalSize: number;
}

export interface ConfirmTorrentAddOptions {
	categoryId: string | null;
	categoryName: string | null;
	savePath: string;
}

export class TorrentBridge {
	private store: Store;
	private config: AppSettings;
	private torrents: Map<string, TorrentEntry> = new Map();
	private restoreCheckQueue: RestoreCheckJob[] = [];
	private restoreCheckRunning = false;
	private pendingFlush = false;
	private downloadPath: string;

	constructor(store: Store, config: Partial<AppSettings>) {
		this.store = store;
		this.config = { ...DEFAULT_SETTINGS, ...config };
		this.downloadPath = resolvePath(this.config.downloadPath);
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

		for (const restored of registry.torrents) {
			const { infoHash, torrentPath, magnetUri } = restored;
			const savePath = resolvePath(restored.savePath ?? this.downloadPath);
			const categoryId = restored.categoryId ?? null;
			const categoryName = restored.categoryName ?? null;
			current++;
			if (!torrentPath || !existsSync(torrentPath)) {
				if (!magnetUri) continue;
				try {
					const magnet = parseMagnetUri(magnetUri);
					const entry: TorrentEntry = {
						torrentPath: "",
						magnetUri,
						savePath,
						categoryId,
						categoryName,
						session: null,
						manager: null,
						trackerCoordinator: null,
						downloader: null,
						hasTransferActivity: false,
						uploadedAccumulator: createUploadedAccumulator(),
						checkingAbort: null,
						checkingPromise: null,
						selectedFileIndices: null,
						fileDownloadedBytes: [],
						state: {
							id: infoHash,
							name: magnet.displayName ?? `magnet:${infoHash.slice(0, 12)}`,
							categoryId,
							categoryName,
							savePath,
							targetPath: savePath,
							totalSize: 0,
							pieceLength: 0,
							downloadedPieces: 0,
							totalPieces: 0,
							status: "stalled",
							downloadBps: 0,
							uploadBps: 0,
							peers: magnet.peers.length,
							seeds: 0,
							leechers: 0,
							peerDetails: [],
							files: [],
							etaSeconds: null,
						},
					};
					this.torrents.set(infoHash, entry);
				} catch {
					// skip invalid magnet registry entries
				}
				continue;
			}
			try {
				const metadata = this.parseTorrent(torrentPath);
				const actualId = Buffer.from(metadata.infoHash).toString("hex");
				if (actualId !== infoHash) continue;

				const trustedResume = loadTrustedResumeData(metadata, savePath);
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

				const restoredSelection =
					trustedResume?.selectedFileIndices ??
					normalizeSelectedFileIndices(
						readResumeData(infoHash)?.selectedFileIndices,
						metadata.files.length,
					);

				const entry: TorrentEntry = {
					torrentPath,
					magnetUri,
					session: null,
					manager: null,
					trackerCoordinator: null,
					downloader: null,
					hasTransferActivity: false,
					uploadedAccumulator: createUploadedAccumulator(),
					checkingAbort: null,
					checkingPromise: null,
					selectedFileIndices: restoredSelection,
					fileDownloadedBytes: metadata.files.map(() => 0),
					savePath,
					categoryId,
					categoryName,
					state: {
						id: infoHash,
						name: metadata.name,
						categoryId,
						categoryName,
						savePath,
						targetPath: this.targetPathFor(metadata, savePath),
						totalSize: metadata.totalSize,
						pieceLength: metadata.pieceLength,
						downloadedPieces,
						totalPieces: metadata.pieceCount,
						status: finalStatus,
						downloadBps: 0,
						uploadBps: 0,
						peers: 0,
						seeds: 0,
						leechers: 0,
						peerDetails: [],
						files: buildFileStates(metadata.files, restoredSelection),
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
						savePath,
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
		const storage = new StorageManager(job.metadata, job.savePath);
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
					job.savePath,
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

	async prepareAdd(input: string): Promise<PreparedTorrentAdd> {
		return parseMagnetUriSafe(input)
			? this.prepareMagnet(input)
			: this.prepareTorrent(input);
	}

	async confirmAdd(
		prepared: PreparedTorrentAdd,
		options: ConfirmTorrentAddOptions,
	): Promise<AddTorrentResult> {
		if (this.torrents.has(prepared.id)) {
			return { id: prepared.id, name: prepared.name, added: false };
		}
		const savePath = resolvePath(options.savePath);
		const metadata = this.parseTorrent(prepared.torrentPath);
		const entry = this.createQueuedEntry({
			categoryId: options.categoryId,
			categoryName: options.categoryName,
			id: prepared.id,
			magnetUri: prepared.magnetUri,
			metadata,
			savePath,
			torrentPath: prepared.torrentPath,
		});
		this.torrents.set(prepared.id, entry);
		this.saveRegistry();
		this.flushAll();
		return { id: prepared.id, name: prepared.name, added: true };
	}

	async addTorrent(torrentPath: string): Promise<AddTorrentResult> {
		const prepared = await this.prepareTorrent(torrentPath);
		if (!prepared.added)
			return { id: prepared.id, name: prepared.name, added: false };
		return this.confirmAdd(prepared, {
			categoryId: null,
			categoryName: null,
			savePath: this.downloadPath,
		});
	}

	private async prepareTorrent(
		torrentPath: string,
	): Promise<PreparedTorrentAdd> {
		const metadata = this.parseTorrent(torrentPath);
		const id = Buffer.from(metadata.infoHash).toString("hex");

		return {
			id,
			name: metadata.name,
			added: !this.torrents.has(id),
			files: buildFileStates(metadata.files, null),
			isMultiFile: metadata.files.length > 1,
			pieceLength: metadata.pieceLength,
			torrentPath,
			totalPieces: metadata.pieceCount,
			totalSize: metadata.totalSize,
		};
	}

	async addMagnet(uri: string): Promise<AddTorrentResult> {
		const prepared = await this.prepareMagnet(uri);
		if (!prepared.added)
			return { id: prepared.id, name: prepared.name, added: false };
		return this.confirmAdd(prepared, {
			categoryId: null,
			categoryName: null,
			savePath: this.downloadPath,
		});
	}

	private async prepareMagnet(uri: string): Promise<PreparedTorrentAdd> {
		const magnet = parseMagnetUri(uri);
		const id = magnet.infoHashHex;
		const name = magnet.displayName ?? `magnet:${id.slice(0, 12)}`;

		if (this.torrents.has(id)) {
			return {
				id,
				name,
				added: false,
				files: [],
				isMultiFile: false,
				magnetUri: uri,
				pieceLength: 0,
				torrentPath: "",
				totalPieces: 0,
				totalSize: 0,
			};
		}

		const result = await resolveMagnetToTorrent(uri);
		const metadata = this.parseTorrent(result.torrentPath);
		return {
			id,
			name: metadata.name,
			added: true,
			files: buildFileStates(metadata.files, null),
			isMultiFile: metadata.files.length > 1,
			magnetUri: uri,
			pieceLength: metadata.pieceLength,
			torrentPath: result.torrentPath,
			totalPieces: metadata.pieceCount,
			totalSize: metadata.totalSize,
		};
	}

	async startTorrent(id: string): Promise<void> {
		const entry = this.torrents.get(id);
		if (!entry || entry.session !== null) return;
		if (entry.state.status === "checking" && !entry.checkingPromise) return;
		if (entry.checkingPromise) {
			await entry.checkingPromise.catch(() => {});
			if (!this.torrents.has(id)) return;
		}
		let torrentPath = entry.torrentPath;
		if (!torrentPath && entry.magnetUri) {
			this.updateEntry(id, { status: "metadata" });
			const result = await resolveMagnetToTorrent(entry.magnetUri, {
				onProgress: (progress: MagnetResolveProgress) => {
					this.updateEntry(id, {
						status: progress.status,
						peers: progress.peers,
					});
				},
			});
			torrentPath = result.torrentPath;
			entry.torrentPath = torrentPath;
			this.saveRegistry();
		}
		if (!torrentPath) throw new Error("Missing torrent metadata");
		const metadata = this.parseTorrent(torrentPath);
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

	setTorrentCategory(
		id: string,
		category: { id: string; name: string } | null,
	): void {
		const entry = this.torrents.get(id);
		if (!entry) return;
		entry.categoryId = category?.id ?? null;
		entry.categoryName = category?.name ?? null;
		entry.state = {
			...entry.state,
			categoryId: entry.categoryId,
			categoryName: entry.categoryName,
		};
		this.saveRegistry();
		this.flushAll();
	}

	renameCategory(categoryId: string, name: string): void {
		let changed = false;
		for (const entry of this.torrents.values()) {
			if (entry.categoryId !== categoryId) continue;
			entry.categoryName = name;
			entry.state = {
				...entry.state,
				categoryName: name,
			};
			changed = true;
		}
		if (!changed) return;
		this.saveRegistry();
		this.flushAll();
	}

	clearCategory(categoryId: string): void {
		let changed = false;
		for (const entry of this.torrents.values()) {
			if (entry.categoryId !== categoryId) continue;
			entry.categoryId = null;
			entry.categoryName = null;
			entry.state = {
				...entry.state,
				categoryId: null,
				categoryName: null,
			};
			changed = true;
		}
		if (!changed) return;
		this.saveRegistry();
		this.flushAll();
	}

	setFileSelection(id: string, selectedIndices: number[] | null): void {
		const entry = this.torrents.get(id);
		if (!entry) return;
		entry.selectedFileIndices = selectedIndices;
		const selectedSet = selectedIndices ? new Set(selectedIndices) : null;
		entry.state.files = entry.state.files.map((f, fi) => ({
			...f,
			selected: selectedSet ? selectedSet.has(fi) : true,
		}));
		const metadata = entry.torrentPath
			? this.parseTorrent(entry.torrentPath)
			: null;
		if (metadata) {
			const downloadedPieces = [
				...(entry.session?.storage.getDownloadedPieces() ?? []),
			];
			const resumePieces =
				downloadedPieces.length > 0
					? downloadedPieces
					: (loadTrustedResumeData(metadata, entry.savePath)?.verifiedPieces ??
						[]);
			writeResumeData(metadata, entry.savePath, resumePieces, selectedIndices);
		}
		this.scheduleFlush();
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
		const trackerStop = entry.trackerCoordinator?.stop();

		if (deleteFiles) {
			try {
				const metadata = this.parseTorrent(entry.torrentPath);
				const targetPath = this.targetPathFor(metadata, entry.savePath);
				rmSync(targetPath, { recursive: true, force: true });
			} catch {
				// ignore deletion errors
			}
		}

		if (trackerStop) await trackerStop;
		entry.manager?.close();
		this.torrents.delete(id);
		this.saveRegistry();
		this.flushAll();
	}

	async stopAll(): Promise<void> {
		const checking: Promise<void>[] = [];
		const trackerStops: Promise<void>[] = [];
		const managers: PeerManager[] = [];
		this.restoreCheckQueue = [];
		for (const entry of this.torrents.values()) {
			entry.checkingAbort?.abort();
			if (entry.checkingPromise) checking.push(entry.checkingPromise);
			entry.downloader?.stop();
			if (entry.trackerCoordinator)
				trackerStops.push(entry.trackerCoordinator.stop());
			if (entry.manager) managers.push(entry.manager);
		}
		await Promise.allSettled([...checking, ...trackerStops]);
		for (const manager of managers) manager.close();
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

		let blocklist: Blocklist;
		try {
			blocklist = await loadBlocklist(this.config);
		} catch {
			this.updateEntry(id, {
				status: "error",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			return;
		}

		const session = new TorrentSession(metadata, entry.savePath);
		entry.session = session;
		entry.hasTransferActivity = false;
		entry.uploadedAccumulator = createUploadedAccumulator();
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

		const manager = new PeerManager(metadata, this.config.maxConnections, {
			blocklist,
			encryptionPolicy: this.config.encryption,
		});
		entry.manager = manager;
		const trackerCoordinator = new DiscoveryCoordinator(metadata, manager, {
			getSnapshot: () => {
				const current = this.torrents.get(id);
				const storage = current?.session?.storage ?? session.storage;
				const uploaded = current?.manager
					? uploadedSnapshot(
							current.uploadedAccumulator,
							current.manager.connections.values(),
						)
					: 0;
				const downloaded = storage.downloadedBytes;
				return {
					downloaded,
					uploaded,
					left: Math.max(0, metadata.totalSize - downloaded),
				};
			},
			enableLsd: this.config.enableLsd,
			onPeers: (peers) => {
				const current = this.torrents.get(id);
				const currentManager = current?.manager;
				if (!current || !currentManager) return;
				void currentManager.connect(peers).then(() => {
					if (!this.torrents.has(id)) return;
					this.updateRuntimeEntry(id, session, currentManager, current);
				});
			},
		});
		entry.trackerCoordinator = trackerCoordinator;

		try {
			await manager.start();
			await trackerCoordinator.start();
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

		this.updateRuntimeEntry(id, session, manager, entry, {
			forceStatus: complete ? "seeding" : undefined,
		});

		manager.on("peerAdded", () => {
			this.updateRuntimeEntry(id, session, manager, entry);
		});
		manager.on("peerRemoved", (conn: PeerConnection) => {
			recordRemovedPeerUpload(entry.uploadedAccumulator, conn);
			if (manager.connections.size === 0) {
				entry.hasTransferActivity = false;
			}
			this.updateRuntimeEntry(id, session, manager, entry);
			if (manager.connections.size === 0 && session.status === "downloading") {
				trackerCoordinator.refreshNow();
			}
		});

		manager.startChoking();
		const skippedFileIndices = computeSkippedFromSelection(
			entry.selectedFileIndices,
			metadata.files.length,
		);
		const downloader = session.download(manager, {
			downloadRateLimitBps: this.config.downloadRateLimitBps,
			uploadRateLimitBps: this.config.uploadRateLimitBps,
			skippedFileIndices,
			webSeeds: this.config.enableWebSeeds ? metadata.webSeeds : [],
			maxWebSeedConnections: this.config.maxWebSeedConnections,
			webSeedMaxRequestBytes: this.config.webSeedMaxRequestBytes,
		});
		entry.downloader = downloader;

		// Seed initial file progress from pieces already verified before download started
		this.computeFullFileProgress(entry, metadata, session.storage);
		this.flushFileStates(id, entry, metadata);

		downloader.on("piece:verified", (pieceIndex: number) => {
			if (!this.torrents.has(id)) return;
			this.accumulatePieceToFiles(entry, metadata, pieceIndex);
			this.flushFileStates(id, entry, metadata);
		});

		downloader.on("activity", () => {
			entry.hasTransferActivity = true;
			if (!this.torrents.has(id)) return;
			this.updateRuntimeEntry(id, session, manager, entry);
		});

		session.on("progress", (dl: number, _total: number, speed: number) => {
			if (!this.torrents.has(id)) return;
			entry.hasTransferActivity = true;
			const uploadBps = [...manager.connections.values()].reduce(
				(sum, c) => sum + c.uploadBytesPerSec,
				0,
			);
			const remaining = metadata.pieceCount - dl;
			const etaSeconds =
				speed > 0
					? Math.round((remaining * metadata.pieceLength) / speed)
					: null;
			this.updateRuntimeEntry(id, session, manager, entry, {
				downloadedPieces: dl,
				downloadBps: Math.round(speed),
				uploadBps,
				etaSeconds,
			});
		});

		session.on("complete", () => {
			trackerCoordinator.markCompleted();
		});
	}

	private computeFullFileProgress(
		entry: TorrentEntry,
		metadata: TorrentMetadata,
		storage: StorageManager,
	): void {
		const bytes = metadata.files.map(() => 0);
		for (let pi = 0; pi < metadata.pieceCount; pi++) {
			if (!storage.hasPiece(pi)) continue;
			this.addPieceContribution(bytes, metadata, pi);
		}
		entry.fileDownloadedBytes = bytes;
	}

	private accumulatePieceToFiles(
		entry: TorrentEntry,
		metadata: TorrentMetadata,
		pieceIndex: number,
	): void {
		if (entry.fileDownloadedBytes.length !== metadata.files.length) {
			entry.fileDownloadedBytes = metadata.files.map(() => 0);
		}
		this.addPieceContribution(entry.fileDownloadedBytes, metadata, pieceIndex);
	}

	private addPieceContribution(
		bytes: number[],
		metadata: TorrentMetadata,
		pieceIndex: number,
	): void {
		const pieceStart = pieceIndex * metadata.pieceLength;
		const isLast = pieceIndex === metadata.pieceCount - 1;
		const pieceLen = isLast
			? metadata.totalSize - pieceStart
			: metadata.pieceLength;
		const pieceEnd = pieceStart + pieceLen;
		for (let fi = 0; fi < metadata.files.length; fi++) {
			const file = metadata.files[fi];
			if (!file) continue;
			const overlapStart = Math.max(pieceStart, file.offset);
			const overlapEnd = Math.min(pieceEnd, file.offset + file.length);
			if (overlapEnd > overlapStart)
				bytes[fi] = (bytes[fi] ?? 0) + (overlapEnd - overlapStart);
		}
	}

	private flushFileStates(
		id: string,
		entry: TorrentEntry,
		_metadata: TorrentMetadata,
	): void {
		this.updateEntry(id, {
			files: entry.state.files.map((f, fi) => ({
				...f,
				downloadedBytes: entry.fileDownloadedBytes[fi] ?? 0,
			})),
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

	private targetPathFor(metadata: TorrentMetadata, savePath: string): string {
		if (
			!metadata.isMultiFile &&
			metadata.files.length === 1 &&
			metadata.files[0]
		) {
			return join(savePath, metadata.files[0].path);
		}
		return join(savePath, metadata.name);
	}

	private saveRegistry(): void {
		const entries = [...this.torrents.entries()]
			.filter(([, entry]) => entry.torrentPath.length > 0 || entry.magnetUri)
			.map(([infoHash, entry]) => ({
				infoHash,
				torrentPath: entry.torrentPath,
				magnetUri: entry.magnetUri,
				savePath: entry.savePath,
				categoryId: entry.categoryId,
				categoryName: entry.categoryName,
			}));
		writeJsonAtomic(this.registryPath(), {
			schemaVersion: 2,
			torrents: entries,
		});
	}

	private createQueuedEntry(options: {
		categoryId: string | null;
		categoryName: string | null;
		id: string;
		magnetUri?: string;
		metadata: TorrentMetadata;
		savePath: string;
		torrentPath: string;
	}): TorrentEntry {
		return {
			torrentPath: options.torrentPath,
			magnetUri: options.magnetUri,
			savePath: options.savePath,
			categoryId: options.categoryId,
			categoryName: options.categoryName,
			session: null,
			manager: null,
			trackerCoordinator: null,
			downloader: null,
			hasTransferActivity: false,
			uploadedAccumulator: createUploadedAccumulator(),
			checkingAbort: null,
			checkingPromise: null,
			selectedFileIndices: null,
			fileDownloadedBytes: options.metadata.files.map(() => 0),
			state: {
				id: options.id,
				name: options.metadata.name,
				categoryId: options.categoryId,
				categoryName: options.categoryName,
				savePath: options.savePath,
				targetPath: this.targetPathFor(options.metadata, options.savePath),
				totalSize: options.metadata.totalSize,
				pieceLength: options.metadata.pieceLength,
				downloadedPieces: 0,
				totalPieces: options.metadata.pieceCount,
				status: "queued",
				downloadBps: 0,
				uploadBps: 0,
				peers: 0,
				seeds: 0,
				leechers: 0,
				peerDetails: [],
				files: buildFileStates(options.metadata.files, null),
				etaSeconds: null,
			},
		};
	}

	private updateEntry(id: string, partial: Partial<TorrentState>): void {
		const entry = this.torrents.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, ...partial };
		this.scheduleFlush();
	}

	private updateRuntimeEntry(
		id: string,
		session: TorrentSession,
		manager: PeerManager,
		entry: TorrentEntry,
		partial: Partial<TorrentState> & { forceStatus?: TorrentStatus } = {},
	): void {
		const { forceStatus, ...statePartial } = partial;
		const status = deriveRuntimeStatus(
			forceStatus ?? session.status,
			manager.connections.size,
			entry.state.status === "paused",
			entry.hasTransferActivity,
		);
		this.updateEntry(id, {
			...statePartial,
			status,
			...normalizeRuntimeMetrics(
				status,
				statePartial.downloadBps ?? entry.state.downloadBps,
				statePartial.uploadBps ?? entry.state.uploadBps,
				statePartial.etaSeconds ?? entry.state.etaSeconds,
			),
			peers: manager.connections.size,
			...(entry.trackerCoordinator?.getSwarmStats() ?? {
				seeds: 0,
				leechers: 0,
			}),
			peerDetails: this.getPeerDetails(manager),
		});
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

function buildFileStates(
	files: Array<{ path: string; length: number }>,
	selectedIndices: number[] | null,
) {
	const selectedSet = selectedIndices ? new Set(selectedIndices) : null;
	return files.map((file, fi) => ({
		path: file.path,
		length: file.length,
		downloadedBytes: 0,
		selected: selectedSet ? selectedSet.has(fi) : true,
	}));
}

function computeSkippedFromSelection(
	selectedIndices: number[] | null,
	fileCount: number,
): Set<number> {
	if (!selectedIndices || selectedIndices.length === fileCount)
		return new Set();
	const selectedSet = new Set(selectedIndices);
	const skipped = new Set<number>();
	for (let i = 0; i < fileCount; i++) {
		if (!selectedSet.has(i)) skipped.add(i);
	}
	return skipped;
}

function parseMagnetUriSafe(input: string): boolean {
	try {
		parseMagnetUri(input);
		return true;
	} catch {
		return false;
	}
}

export function deriveRuntimeStatus(
	sessionStatus: TorrentStatus,
	peerCount: number,
	paused: boolean,
	hasTransferActivity: boolean,
): TorrentState["status"] {
	if (paused) return "paused";
	if (sessionStatus === "seeding") return "seeding";
	if (sessionStatus === "stopped") return "stopped";
	if (peerCount <= 0) return "stalled";
	return hasTransferActivity ? "downloading" : "connecting";
}

export function normalizeRuntimeMetrics(
	status: TorrentState["status"],
	downloadBps: number,
	uploadBps: number,
	etaSeconds: number | null,
): Pick<TorrentState, "downloadBps" | "uploadBps" | "etaSeconds"> {
	if (status === "downloading") {
		return { downloadBps, uploadBps, etaSeconds };
	}
	if (status === "seeding") {
		return { downloadBps: 0, uploadBps, etaSeconds: null };
	}
	return { downloadBps: 0, uploadBps: 0, etaSeconds: null };
}
