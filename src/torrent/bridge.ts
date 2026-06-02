import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings } from "../config/settings";
import type { Store, TorrentPeerState, TorrentState } from "../store";
import { writeJsonAtomic } from "../utils/json";
import { getDataDir, resolvePath } from "../utils/paths";
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
	}>;
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

		for (const { infoHash, torrentPath, magnetUri } of registry.torrents) {
			current++;
			if (!torrentPath || !existsSync(torrentPath)) {
				if (!magnetUri) continue;
				try {
					const magnet = parseMagnetUri(magnetUri);
					const entry: TorrentEntry = {
						torrentPath: "",
						magnetUri,
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
							targetPath: this.downloadPath,
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

				const restoredSelection = normalizeSelectedFileIndices(
					trustedResume?.data.selectedFileIndices ??
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
			hasTransferActivity: false,
			uploadedAccumulator: createUploadedAccumulator(),
			checkingAbort: null,
			checkingPromise: null,
			selectedFileIndices: null,
			fileDownloadedBytes: metadata.files.map(() => 0),
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
				seeds: 0,
				leechers: 0,
				peerDetails: [],
				files: buildFileStates(metadata.files, null),
				etaSeconds: null,
			},
		};
		this.torrents.set(id, entry);
		this.saveRegistry();
		this.flushAll();

		return { id, name: metadata.name, added: true };
	}

	async addMagnet(uri: string): Promise<AddTorrentResult> {
		const magnet = parseMagnetUri(uri);
		const id = magnet.infoHashHex;
		const name = magnet.displayName ?? `magnet:${id.slice(0, 12)}`;

		if (this.torrents.has(id)) return { id, name, added: false };

		const entry: TorrentEntry = {
			torrentPath: "",
			magnetUri: uri,
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
				id,
				name,
				targetPath: this.downloadPath,
				totalSize: 0,
				pieceLength: 0,
				downloadedPieces: 0,
				totalPieces: 0,
				status: "metadata",
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
		this.torrents.set(id, entry);
		this.flushAll();

		try {
			const result = await resolveMagnetToTorrent(uri, {
				onProgress: (progress: MagnetResolveProgress) => {
					this.updateEntry(id, {
						status: progress.status,
						peers: progress.peers,
					});
				},
			});
			const metadata = this.parseTorrent(result.torrentPath);
			entry.torrentPath = result.torrentPath;
			entry.selectedFileIndices = null;
			entry.fileDownloadedBytes = metadata.files.map(() => 0);
			entry.state = {
				...entry.state,
				name: metadata.name,
				targetPath: this.targetPathFor(metadata),
				totalSize: metadata.totalSize,
				pieceLength: metadata.pieceLength,
				downloadedPieces: 0,
				totalPieces: metadata.pieceCount,
				status: "queued",
				peers: 0,
				files: buildFileStates(metadata.files, null),
			};
			this.saveRegistry();
			this.flushAll();
			return { id, name: metadata.name, added: true };
		} catch (err) {
			this.updateEntry(id, {
				status: "stalled",
				downloadBps: 0,
				uploadBps: 0,
				etaSeconds: null,
			});
			throw err;
		}
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
			writeResumeData(
				metadata,
				this.downloadPath,
				entry.session?.storage.getDownloadedPieces() ?? [],
				selectedIndices,
			);
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
				const targetPath = this.targetPathFor(metadata);
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

		const session = new TorrentSession(metadata, this.downloadPath);
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

		const manager = new PeerManager(metadata, this.config.maxConnections);
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

	private targetPathFor(metadata: TorrentMetadata): string {
		if (metadata.files.length === 1 && metadata.files[0]) {
			return join(this.downloadPath, metadata.files[0].path);
		}
		return join(this.downloadPath, metadata.name);
	}

	private saveRegistry(): void {
		const entries = [...this.torrents.entries()]
			.filter(([, entry]) => entry.torrentPath.length > 0 || entry.magnetUri)
			.map(([infoHash, entry]) => ({
				infoHash,
				torrentPath: entry.torrentPath,
				magnetUri: entry.magnetUri,
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

export function deriveRuntimeStatus(
	sessionStatus: TorrentStatus,
	peerCount: number,
	paused: boolean,
	hasTransferActivity: boolean,
): TorrentState["status"] {
	if (paused) return "paused";
	if (sessionStatus === "seeding") return "seeding";
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
