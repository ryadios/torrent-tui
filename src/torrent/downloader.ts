import { EventEmitter } from "node:events";
import { SHA1 } from "bun";
import type { TorrentMetadata } from "./metadata.ts";
import { log } from "./metadata.ts";
import type { PeerConnection } from "./peer/connection.ts";
import type { PeerManager } from "./peer/manager.ts";
import { PiecePicker } from "./piece-picker.ts";
import {
	infoHashHex,
	loadTrustedResumeData,
	writeResumeData,
} from "./resume.ts";
import type { StorageManager } from "./storage.ts";

const BLOCK_SIZE = 16_384;
const PIPELINE_DEPTH = 15;
const CORRUPT_STRIKE_LIMIT = 2;
const DEFAULT_MAX_UPLOAD_QUEUE_PER_PEER = 32;
const DEFAULT_MAX_UPLOAD_QUEUE_GLOBAL = 512;

export interface DownloaderOptions {
	downloadRateLimitBps?: number;
	uploadRateLimitBps?: number;
	skippedFileIndices?: Set<number>;
	maxUploadQueuePerPeer?: number;
	maxUploadQueueGlobal?: number;
}

interface UploadRequest {
	conn: PeerConnection;
	index: number;
	begin: number;
	length: number;
}

interface InProgressPiece {
	blocks: (Buffer | null)[];
	received: number;
	total: number;
}

interface RequestedBlock {
	pieceIndex: number;
	begin: number;
	length: number;
}

export class Downloader extends EventEmitter {
	private stopped = false;
	private paused = false;
	private inProgress = new Map<number, InProgressPiece>();
	private pendingRequests = new Map<string, Set<string>>(); // peerKey → "idx:begin"
	private blockAssignments = new Map<string, Set<string>>(); // "idx:begin" → peerKeys
	private corruptStrikes = new Map<string, number>();
	private bannedPeers = new Set<string>();
	private nextPieceIndex = 0;
	private bytesThisSecond = 0;
	private speedBytesPerSec = 0;
	private endgame = false;
	private picker!: PiecePicker;

	// Rate limiting
	private downloadLimitBps: number;
	private downloadTokens: number;
	private uploadLimitBps: number;
	private uploadTokens: number;
	private uploadQueue: UploadRequest[] = [];
	private uploadQueueCounts = new Map<string, number>();
	private maxUploadQueuePerPeer: number;
	private maxUploadQueueGlobal: number;
	private intervalHandle: ReturnType<typeof setInterval> | null = null;

	// File selection
	private skippedFileIndices: Set<number>;
	private wantedPieces: Set<number>;
	private downloadedWanted = 0;

	constructor(
		private metadata: TorrentMetadata,
		private storage: StorageManager,
		private manager: PeerManager,
		private downloadPath: string,
		options: DownloaderOptions = {},
	) {
		super();
		this.downloadLimitBps = options.downloadRateLimitBps ?? 0;
		this.downloadTokens =
			this.downloadLimitBps > 0 ? this.downloadLimitBps : Infinity;
		this.uploadLimitBps = options.uploadRateLimitBps ?? 0;
		this.uploadTokens =
			this.uploadLimitBps > 0 ? this.uploadLimitBps : Infinity;
		this.maxUploadQueuePerPeer =
			options.maxUploadQueuePerPeer ?? DEFAULT_MAX_UPLOAD_QUEUE_PER_PEER;
		this.maxUploadQueueGlobal =
			options.maxUploadQueueGlobal ?? DEFAULT_MAX_UPLOAD_QUEUE_GLOBAL;
		this.skippedFileIndices = options.skippedFileIndices ?? new Set();
		this.wantedPieces = this.computeWantedPieces();
	}

	start(): void {
		this.picker = new PiecePicker(
			this.metadata.pieceCount,
			(i) => this.storage.hasPiece(i),
			(i) => this.inProgress.has(i),
			(i) => this.wantedPieces.has(i),
		);

		this.loadResume();

		// Count already-verified wanted pieces (resume may have populated storage)
		this.downloadedWanted = 0;
		for (const i of this.wantedPieces) {
			if (this.storage.hasPiece(i)) this.downloadedWanted++;
		}

		this.advanceNextPiece();

		if (this.downloadedWanted >= this.wantedPieces.size) {
			this.emitWantedComplete();
			return;
		}

		// 1s interval: refresh rate-limit tokens + report speed
		this.intervalHandle = setInterval(() => {
			this.downloadTokens = refillTokens(
				this.downloadTokens,
				this.downloadLimitBps,
			);
			this.uploadTokens = refillTokens(this.uploadTokens, this.uploadLimitBps);
			this.drainUploadQueue();
			this.speedBytesPerSec = this.bytesThisSecond;
			this.bytesThisSecond = 0;
			if (!this.stopped && !this.paused) {
				this.emit(
					"progress",
					this.downloadedWanted,
					this.wantedPieces.size,
					this.speedBytesPerSec,
				);
				if (this.downloadLimitBps > 0) {
					for (const conn of this.manager.connections.values()) {
						if (!conn.amChoked) this.fillPipeline(conn);
					}
				}
			}
		}, 1_000);

		// Wire up existing peers and seed their availability into the picker
		for (const conn of this.manager.connections.values()) {
			this.picker.addPeer(conn);
			this.wirePeer(conn);
			if (!conn.amChoked) this.fillPipeline(conn);
		}

		// Wire up peers that connect after start()
		this.manager.on("peerAdded", (conn: PeerConnection) => {
			this.picker.addPeer(conn);
			this.wirePeer(conn);
			if (!conn.amChoked) this.fillPipeline(conn);
		});
	}

	stop(): void {
		this.stopped = true;
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
		this.uploadQueue = [];
		this.uploadQueueCounts.clear();
	}

	pause(): void {
		if (this.stopped) return;
		this.paused = true;
	}

	resume(): void {
		if (this.stopped || !this.paused) return;
		this.paused = false;
		for (const conn of this.manager.connections.values()) {
			if (!conn.amChoked) this.fillPipeline(conn);
		}
	}

	private wirePeer(conn: PeerConnection): void {
		const key = `${conn.address}:${conn.port}`;
		if (this.bannedPeers.has(key)) return;
		if (!this.pendingRequests.has(key))
			this.pendingRequests.set(key, new Set());

		// Tell the peer what pieces we already have
		if (this.storage.downloadedCount > 0) {
			conn.sendBitfield(this.storage.getBitfield());
		}

		conn.on("unchoke", () => {
			if (!this.stopped && !this.bannedPeers.has(key)) this.fillPipeline(conn);
		});

		conn.on("choke", () => {
			this.clearPending(key);
		});

		conn.on("have", (index: number) => {
			this.picker.onHave(index);
		});

		conn.on("piece", (index: number, begin: number, block: Uint8Array) => {
			this.onBlock(conn, index, begin, block);
		});

		// Seeding: serve blocks to unchoked peers that request pieces we have
		conn.on("request", (index: number, begin: number, length: number) => {
			if (conn.peerChoked) return; // we choked this peer — don't serve
			if (!this.storage.hasPiece(index)) return;
			if (this.uploadLimitBps > 0) {
				if (!this.enqueueUpload(conn, index, begin, length)) return;
				this.drainUploadQueue();
			} else {
				this.serveUpload(conn, index, begin, length);
			}
		});

		conn.on("disconnect", () => {
			this.picker.removePeer(conn);
			this.clearPending(key);
			this.removeQueuedUploadsForPeer(conn);
		});
	}

	private fillPipeline(conn: PeerConnection): void {
		if (this.stopped || this.paused) return;
		const key = `${conn.address}:${conn.port}`;
		if (this.bannedPeers.has(key)) return;

		const pending = this.pendingRequests.get(key) ?? new Set<string>();
		this.pendingRequests.set(key, pending);

		while (pending.size < PIPELINE_DEPTH) {
			if (this.downloadLimitBps > 0 && this.downloadTokens < BLOCK_SIZE) break;
			const next = this.nextBlock(conn);
			if (!next) break;
			const { pieceIndex, begin, length } = next;
			const reqKey = `${pieceIndex}:${begin}`;
			pending.add(reqKey);
			this.assignRequest(key, reqKey);
			conn.sendRequest(pieceIndex, begin, length);
			if (this.downloadLimitBps > 0) this.downloadTokens -= length;
		}
	}

	private nextBlock(
		conn: PeerConnection,
	): { pieceIndex: number; begin: number; length: number } | null {
		this.refreshEndgameMode();
		if (this.endgame) {
			return this.nextEndgameBlock(conn);
		}

		// Tier 1: finish any in-progress piece this peer has (avoids partial waste)
		for (const [pieceIndex, piece] of this.inProgress) {
			if (!conn.hasPiece(pieceIndex)) continue;
			for (let b = 0; b < piece.total; b++) {
				if (piece.blocks[b] !== null) continue;
				const begin = b * BLOCK_SIZE;
				const reqKey = `${pieceIndex}:${begin}`;
				if (this.isRequestedAnywhere(reqKey)) continue;
				return { pieceIndex, begin, length: this.blockLength(pieceIndex, b) };
			}
		}

		// Tier 2: rarest-first via PiecePicker
		const pieceIndex = this.picker.pick(conn);
		if (pieceIndex === null) return null;

		const total = this.pieceBlockCount(pieceIndex);
		this.inProgress.set(pieceIndex, {
			blocks: new Array(total).fill(null),
			received: 0,
			total,
		});
		this.refreshEndgameMode();
		return { pieceIndex, begin: 0, length: this.blockLength(pieceIndex, 0) };
	}

	private nextEndgameBlock(
		conn: PeerConnection,
	): { pieceIndex: number; begin: number; length: number } | null {
		const peerKey = `${conn.address}:${conn.port}`;
		let best: RequestedBlock | null = null;
		let lowestAssignments = Infinity;

		for (const [pieceIndex, piece] of this.inProgress) {
			if (!conn.hasPiece(pieceIndex)) continue;
			for (let blockIdx = 0; blockIdx < piece.total; blockIdx++) {
				if (piece.blocks[blockIdx] !== null) continue;
				const begin = blockIdx * BLOCK_SIZE;
				const reqKey = `${pieceIndex}:${begin}`;
				const assignees = this.blockAssignments.get(reqKey);
				if (assignees?.has(peerKey)) continue;
				const assignmentCount = assignees?.size ?? 0;
				if (assignmentCount < lowestAssignments) {
					lowestAssignments = assignmentCount;
					best = {
						pieceIndex,
						begin,
						length: this.blockLength(pieceIndex, blockIdx),
					};
				}
			}
		}

		return best;
	}

	private isRequestedAnywhere(reqKey: string): boolean {
		for (const pending of this.pendingRequests.values()) {
			if (pending.has(reqKey)) return true;
		}
		return false;
	}

	private onBlock(
		conn: PeerConnection,
		index: number,
		begin: number,
		block: Uint8Array,
	): void {
		const key = `${conn.address}:${conn.port}`;
		const reqKey = `${index}:${begin}`;
		this.removeRequestForPeer(key, reqKey);

		const piece = this.inProgress.get(index);
		if (!piece) {
			this.fillPipeline(conn);
			return;
		}

		const blockIdx = begin / BLOCK_SIZE;
		if (piece.blocks[blockIdx] !== null) {
			this.fillPipeline(conn);
			return;
		}

		piece.blocks[blockIdx] = Buffer.from(block);
		piece.received++;
		this.bytesThisSecond += block.length;
		this.emit("activity", index, begin, block.length);

		if (piece.received === piece.total) {
			this.finishPiece(index, piece, conn);
		}

		if (!this.stopped) this.fillPipeline(conn);
	}

	private finishPiece(
		index: number,
		piece: InProgressPiece,
		conn: PeerConnection,
	): void {
		const key = `${conn.address}:${conn.port}`;
		const shouldCancelRedundant = this.endgame;
		this.inProgress.delete(index);
		this.refreshEndgameMode();

		// Assemble blocks
		const assembled = Buffer.concat(
			piece.blocks.filter((b): b is Buffer => b !== null),
		);

		// SHA-1 verify in memory
		const actual = new SHA1()
			.update(assembled)
			.digest() as unknown as Uint8Array;
		const expected = this.metadata.pieceHashes[index];

		if (!expected || !bufEqual(actual, expected)) {
			const strikes = (this.corruptStrikes.get(key) ?? 0) + 1;
			this.corruptStrikes.set(key, strikes);

			if (strikes >= CORRUPT_STRIKE_LIMIT) {
				this.bannedPeers.add(key);
				this.manager.ban({ ip: conn.address, port: conn.port });
				conn.suppressDisconnect = true;
				conn.destroy();
			}

			this.cancelOutstandingRequestsForPiece(index, shouldCancelRedundant);
			this.emit("piece:failed", index, key);
			this.advanceNextPiece();
			this.refreshEndgameMode();
			return;
		}

		this.cancelOutstandingRequestsForPiece(index, shouldCancelRedundant);

		// Write to disk
		this.storage.writePieceSync(index, assembled);
		this.saveResume();

		// Track wanted piece completion
		if (this.wantedPieces.has(index)) this.downloadedWanted++;

		// Broadcast HAVE to all connected peers
		for (const peer of this.manager.connections.values()) {
			if (`${peer.address}:${peer.port}` !== key) peer.sendHave(index);
		}

		this.advanceNextPiece();
		this.emit("piece:verified", index);

		this.emit(
			"progress",
			this.downloadedWanted,
			this.wantedPieces.size,
			this.speedBytesPerSec,
		);

		if (this.downloadedWanted >= this.wantedPieces.size) {
			this.stop();
			this.emitWantedComplete();
		}
	}

	private clearPending(key: string): void {
		const pending = this.pendingRequests.get(key);
		if (!pending) return;
		for (const reqKey of pending) {
			this.unassignRequest(key, reqKey);
		}
		pending.clear();
		this.refreshEndgameMode();
	}

	private advanceNextPiece(): void {
		while (
			this.nextPieceIndex < this.metadata.pieceCount &&
			this.storage.hasPiece(this.nextPieceIndex)
		) {
			this.nextPieceIndex++;
		}
	}

	private pieceBlockCount(pieceIndex: number): number {
		const isLast = pieceIndex === this.metadata.pieceCount - 1;
		const len = isLast
			? this.metadata.totalSize - pieceIndex * this.metadata.pieceLength
			: this.metadata.pieceLength;
		return Math.ceil(len / BLOCK_SIZE);
	}

	private blockLength(pieceIndex: number, blockIdx: number): number {
		const isLastPiece = pieceIndex === this.metadata.pieceCount - 1;
		const pieceLen = isLastPiece
			? this.metadata.totalSize - pieceIndex * this.metadata.pieceLength
			: this.metadata.pieceLength;
		const isLastBlock = blockIdx === Math.ceil(pieceLen / BLOCK_SIZE) - 1;
		return isLastBlock ? pieceLen - blockIdx * BLOCK_SIZE : BLOCK_SIZE;
	}

	private assignRequest(peerKey: string, reqKey: string): void {
		const assignees = this.blockAssignments.get(reqKey) ?? new Set<string>();
		assignees.add(peerKey);
		this.blockAssignments.set(reqKey, assignees);
	}

	private unassignRequest(peerKey: string, reqKey: string): void {
		const assignees = this.blockAssignments.get(reqKey);
		if (!assignees) return;
		assignees.delete(peerKey);
		if (assignees.size === 0) this.blockAssignments.delete(reqKey);
	}

	private removeRequestForPeer(peerKey: string, reqKey: string): void {
		this.pendingRequests.get(peerKey)?.delete(reqKey);
		this.unassignRequest(peerKey, reqKey);
		this.refreshEndgameMode();
	}

	private cancelOutstandingRequestsForPiece(
		pieceIndex: number,
		sendCancel: boolean,
	): void {
		const prefix = `${pieceIndex}:`;
		for (const [peerKey, pending] of this.pendingRequests) {
			const peer = this.manager.connections.get(peerKey);
			for (const reqKey of [...pending]) {
				if (!reqKey.startsWith(prefix)) continue;
				pending.delete(reqKey);
				this.unassignRequest(peerKey, reqKey);
				const begin = Number(reqKey.slice(prefix.length));
				const blockIdx = Math.floor(begin / BLOCK_SIZE);
				if (sendCancel && peer) {
					peer.sendCancel(
						pieceIndex,
						begin,
						this.blockLength(pieceIndex, blockIdx),
					);
				}
			}
		}
		this.refreshEndgameMode();
	}

	private refreshEndgameMode(): void {
		let remainingBlocks = 0;
		for (const piece of this.inProgress.values()) {
			remainingBlocks += piece.total - piece.received;
		}

		let hasUnstartedMissingPiece = false;
		for (const i of this.wantedPieces) {
			if (!this.storage.hasPiece(i) && !this.inProgress.has(i)) {
				hasUnstartedMissingPiece = true;
				break;
			}
		}

		this.endgame =
			!hasUnstartedMissingPiece &&
			remainingBlocks > 0 &&
			remainingBlocks <= PIPELINE_DEPTH * 2;
	}

	// Resume

	private loadResume(): void {
		const resume = loadTrustedResumeData(this.metadata, this.downloadPath);
		if (!resume) {
			log("resume", "no saved state — starting fresh");
			return;
		}

		for (const piece of resume.verifiedPieces) {
			this.storage.markPiece(piece);
		}
		log(
			"resume",
			`${resume.verifiedPieces.length} / ${this.metadata.pieceCount} trusted resume pieces for ${infoHashHex(this.metadata).slice(0, 8)}`,
		);
	}

	private saveResume(): void {
		writeResumeData(
			this.metadata,
			this.downloadPath,
			this.storage.getDownloadedPieces(),
		);
	}

	private computeWantedPieces(): Set<number> {
		if (this.skippedFileIndices.size === 0) {
			const all = new Set<number>();
			for (let i = 0; i < this.metadata.pieceCount; i++) all.add(i);
			return all;
		}
		const wanted = new Set<number>();
		for (let i = 0; i < this.metadata.pieceCount; i++) {
			if (this.isPieceWanted(i)) wanted.add(i);
		}
		return wanted;
	}

	private isPieceWanted(pieceIndex: number): boolean {
		if (this.skippedFileIndices.size === 0) return true;

		const pieceStart = pieceIndex * this.metadata.pieceLength;
		const isLast = pieceIndex === this.metadata.pieceCount - 1;
		const pieceLen = isLast
			? this.metadata.totalSize - pieceStart
			: this.metadata.pieceLength;
		const pieceEnd = pieceStart + pieceLen;

		for (let fi = 0; fi < this.metadata.files.length; fi++) {
			if (this.skippedFileIndices.has(fi)) continue;
			const file = this.metadata.files[fi];
			if (!file) continue;
			if (pieceStart < file.offset + file.length && pieceEnd > file.offset) {
				return true;
			}
		}
		return false;
	}

	private serveUpload(
		conn: PeerConnection,
		index: number,
		begin: number,
		length: number,
	): void {
		const piece = this.storage.readPieceSync(index);
		const block = Buffer.from(piece).subarray(begin, begin + length);
		conn.sendPiece(index, begin, block);
	}

	private uploadPeerKey(conn: PeerConnection): string {
		return `${conn.address}:${conn.port}`;
	}

	private enqueueUpload(
		conn: PeerConnection,
		index: number,
		begin: number,
		length: number,
	): boolean {
		const key = this.uploadPeerKey(conn);
		const perPeerCount = this.uploadQueueCounts.get(key) ?? 0;
		if (
			this.uploadQueue.length >= this.maxUploadQueueGlobal ||
			perPeerCount >= this.maxUploadQueuePerPeer
		) {
			return false;
		}
		this.uploadQueue.push({ conn, index, begin, length });
		this.uploadQueueCounts.set(key, perPeerCount + 1);
		return true;
	}

	private decrementUploadQueueCount(conn: PeerConnection): void {
		const key = this.uploadPeerKey(conn);
		const next = (this.uploadQueueCounts.get(key) ?? 1) - 1;
		if (next <= 0) {
			this.uploadQueueCounts.delete(key);
			return;
		}
		this.uploadQueueCounts.set(key, next);
	}

	private removeQueuedUploadsForPeer(conn: PeerConnection): void {
		const key = this.uploadPeerKey(conn);
		this.uploadQueue = this.uploadQueue.filter(
			(req) => this.uploadPeerKey(req.conn) !== key,
		);
		this.uploadQueueCounts.delete(key);
	}

	private drainUploadQueue(): void {
		while (this.uploadQueue.length > 0 && this.uploadTokens >= BLOCK_SIZE) {
			const req = this.uploadQueue.shift();
			if (!req) break;
			this.decrementUploadQueueCount(req.conn);
			if (req.conn.peerChoked || !this.storage.hasPiece(req.index)) continue;
			this.uploadTokens -= req.length;
			this.serveUpload(req.conn, req.index, req.begin, req.length);
		}
	}

	private emitWantedComplete(): void {
		this.emit("wantedComplete");
		if (this.storage.downloadedCount >= this.metadata.pieceCount) {
			this.emit("complete");
		}
	}
}

function bufEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function refillTokens(current: number, limitBps: number): number {
	if (limitBps <= 0) return Infinity;
	const capacity = Math.max(BLOCK_SIZE, limitBps);
	return Math.min(capacity, current + limitBps);
}
