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

interface InProgressPiece {
	blocks: (Buffer | null)[];
	received: number;
	total: number;
}

export class Downloader extends EventEmitter {
	private stopped = false;
	private paused = false;
	private inProgress = new Map<number, InProgressPiece>();
	private pendingRequests = new Map<string, Set<string>>(); // peerKey → "idx:begin"
	private corruptStrikes = new Map<string, number>();
	private bannedPeers = new Set<string>();
	private nextPieceIndex = 0;
	private bytesThisSecond = 0;
	private lastSpeedReset = Date.now();
	private speedBytesPerSec = 0;
	private picker!: PiecePicker;

	constructor(
		private metadata: TorrentMetadata,
		private storage: StorageManager,
		private manager: PeerManager,
		private downloadPath: string,
	) {
		super();
	}

	start(): void {
		this.picker = new PiecePicker(
			this.metadata.pieceCount,
			(i) => this.storage.hasPiece(i),
			(i) => this.inProgress.has(i),
		);

		this.loadResume();
		this.advanceNextPiece();

		if (this.nextPieceIndex >= this.metadata.pieceCount) {
			this.emit("complete");
			return;
		}

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
			const piece = this.storage.readPieceSync(index);
			const block = Buffer.from(piece).subarray(begin, begin + length);
			conn.sendPiece(index, begin, block);
		});

		conn.on("disconnect", () => {
			this.picker.removePeer(conn);
			this.clearPending(key);
		});
	}

	private fillPipeline(conn: PeerConnection): void {
		if (this.stopped || this.paused) return;
		const key = `${conn.address}:${conn.port}`;
		if (this.bannedPeers.has(key)) return;

		const pending = this.pendingRequests.get(key) ?? new Set<string>();
		this.pendingRequests.set(key, pending);

		while (pending.size < PIPELINE_DEPTH) {
			const next = this.nextBlock(conn);
			if (!next) break;
			const { pieceIndex, begin, length } = next;
			const reqKey = `${pieceIndex}:${begin}`;
			pending.add(reqKey);
			conn.sendRequest(pieceIndex, begin, length);
		}
	}

	private nextBlock(
		conn: PeerConnection,
	): { pieceIndex: number; begin: number; length: number } | null {
		// Tier 1: finish any in-progress piece this peer has (avoids partial waste)
		for (const [pieceIndex, piece] of this.inProgress) {
			if (!conn.hasPiece(pieceIndex)) continue;
			for (let b = 0; b < piece.total; b++) {
				if (piece.blocks[b] !== null) continue;
				const begin = b * BLOCK_SIZE;
				const reqKey = `${pieceIndex}:${begin}`;
				if (this.isRequested(reqKey)) continue;
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
		return { pieceIndex, begin: 0, length: this.blockLength(pieceIndex, 0) };
	}

	private isRequested(reqKey: string): boolean {
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
		this.pendingRequests.get(key)?.delete(reqKey);

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
		this.inProgress.delete(index);

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
				conn.suppressDisconnect = true;
				conn.destroy();
			}

			this.emit("piece:failed", index, key);
			this.advanceNextPiece();
			return;
		}

		// Write to disk
		this.storage.writePieceSync(index, assembled);
		this.saveResume();

		// Broadcast HAVE to all connected peers
		for (const peer of this.manager.connections.values()) {
			if (`${peer.address}:${peer.port}` !== key) peer.sendHave(index);
		}

		this.advanceNextPiece();
		this.emit("piece:verified", index);

		// Speed tracking
		const now = Date.now();
		if (now - this.lastSpeedReset >= 1_000) {
			this.speedBytesPerSec = this.bytesThisSecond;
			this.bytesThisSecond = 0;
			this.lastSpeedReset = now;
		}

		this.emit(
			"progress",
			this.storage.downloadedCount,
			this.metadata.pieceCount,
			this.speedBytesPerSec,
		);

		if (this.storage.downloadedCount === this.metadata.pieceCount) {
			this.stop();
			this.emit("complete");
		}
	}

	private clearPending(key: string): void {
		this.pendingRequests.get(key)?.clear();
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
}

function bufEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
