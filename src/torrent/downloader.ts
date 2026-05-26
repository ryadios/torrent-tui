import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHA1 } from "bun";
import { log } from "./metadata.ts";
import { getDataDir } from "../utils/paths.ts";
import type { TorrentMetadata } from "./metadata.ts";
import type { StorageManager } from "./storage.ts";
import type { PeerManager } from "./peer/manager.ts";
import type { PeerConnection } from "./peer/connection.ts";

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
	private inProgress = new Map<number, InProgressPiece>();
	private pendingRequests = new Map<string, Set<string>>(); // peerKey → "idx:begin"
	private corruptStrikes = new Map<string, number>();
	private bannedPeers = new Set<string>();
	private nextPieceIndex = 0;
	private bytesThisSecond = 0;
	private lastSpeedReset = Date.now();
	private speedBytesPerSec = 0;
	private progressInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		private metadata: TorrentMetadata,
		private storage: StorageManager,
		private manager: PeerManager,
		private downloadPath: string,
	) {
		super();
	}

	start(): void {
		this.loadResume();
		this.advanceNextPiece();

		if (this.nextPieceIndex >= this.metadata.pieceCount) {
			this.emit("complete");
			return;
		}

		// Wire up existing unchoked peers
		for (const conn of this.manager.connections.values()) {
			this.wirePeer(conn);
			if (!conn.amChoked) this.fillPipeline(conn);
		}

		// Wire up peers that connect after start()
		this.manager.on("peerAdded", (conn: PeerConnection) => {
			this.wirePeer(conn);
			if (!conn.amChoked) this.fillPipeline(conn);
		});

		this.progressInterval = setInterval(() => this.logProgress(), 2_000);
	}

	stop(): void {
		this.stopped = true;
		if (this.progressInterval) clearInterval(this.progressInterval);
	}

	private wirePeer(conn: PeerConnection): void {
		const key = `${conn.address}:${conn.port}`;
		if (this.bannedPeers.has(key)) return;
		if (!this.pendingRequests.has(key)) this.pendingRequests.set(key, new Set());

		conn.on("unchoke", () => {
			if (!this.stopped && !this.bannedPeers.has(key)) this.fillPipeline(conn);
		});

		conn.on("choke", () => {
			this.clearPending(key);
		});

		conn.on("piece", (index: number, begin: number, block: Uint8Array) => {
			this.onBlock(conn, index, begin, block);
		});

		conn.on("disconnect", () => {
			this.clearPending(key);
		});
	}

	private fillPipeline(conn: PeerConnection): void {
		if (this.stopped) return;
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

	private nextBlock(conn: PeerConnection): { pieceIndex: number; begin: number; length: number } | null {
		// First: try to finish an in-progress piece the peer has
		for (const [pieceIndex, piece] of this.inProgress) {
			if (!conn.hasPiece(pieceIndex)) continue;
			for (let b = 0; b < piece.total; b++) {
				if (piece.blocks[b] !== null) continue;
				const begin = b * BLOCK_SIZE;
				const reqKey = `${pieceIndex}:${begin}`;
				// Skip if already requested from any peer
				if (this.isRequested(reqKey)) continue;
				const length = this.blockLength(pieceIndex, b);
				return { pieceIndex, begin, length };
			}
		}

		// Then: find the next sequential piece
		for (let i = this.nextPieceIndex; i < this.metadata.pieceCount; i++) {
			if (this.storage.hasPiece(i)) continue;
			if (this.inProgress.has(i)) continue;
			if (!conn.hasPiece(i)) continue;

			// Start this piece
			const total = this.pieceBlockCount(i);
			this.inProgress.set(i, { blocks: new Array(total).fill(null), received: 0, total });
			log("piece", `${i}  requesting ${total} blocks`);
			const length = this.blockLength(i, 0);
			return { pieceIndex: i, begin: 0, length };
		}

		return null;
	}

	private isRequested(reqKey: string): boolean {
		for (const pending of this.pendingRequests.values()) {
			if (pending.has(reqKey)) return true;
		}
		return false;
	}

	private onBlock(conn: PeerConnection, index: number, begin: number, block: Uint8Array): void {
		const key = `${conn.address}:${conn.port}`;
		const reqKey = `${index}:${begin}`;
		this.pendingRequests.get(key)?.delete(reqKey);

		const piece = this.inProgress.get(index);
		if (!piece) { this.fillPipeline(conn); return; }

		const blockIdx = begin / BLOCK_SIZE;
		if (piece.blocks[blockIdx] !== null) { this.fillPipeline(conn); return; }

		piece.blocks[blockIdx] = Buffer.from(block);
		piece.received++;
		this.bytesThisSecond += block.length;

		if (piece.received === piece.total) {
			this.finishPiece(index, piece, conn);
		}

		if (!this.stopped) this.fillPipeline(conn);
	}

	private finishPiece(index: number, piece: InProgressPiece, conn: PeerConnection): void {
		const key = `${conn.address}:${conn.port}`;
		this.inProgress.delete(index);

		// Assemble blocks
		const assembled = Buffer.concat(piece.blocks.filter((b): b is Buffer => b !== null));

		// SHA-1 verify in memory
		const actual = new SHA1().update(assembled).digest() as unknown as Uint8Array;
		const expected = this.metadata.pieceHashes[index];

		if (!expected || !bufEqual(actual, expected)) {
			const strikes = (this.corruptStrikes.get(key) ?? 0) + 1;
			this.corruptStrikes.set(key, strikes);
			log("piece", `${index}  FAIL  (peer ${conn.peerId.slice(0, 8)}, strike ${strikes})`);

			if (strikes >= CORRUPT_STRIKE_LIMIT) {
				this.bannedPeers.add(key);
				conn.suppressDisconnect = true;
				conn.destroy();
				log("banned", `${conn.peerId.slice(0, 8)}  (${strikes} corrupt pieces)`);
			}

			this.emit("piece:failed", index, key);
			this.advanceNextPiece();
			return;
		}

		// Write to disk
		this.storage.writePieceSync(index, assembled);
		this.saveResume();
		log("piece", `${index}  ok`);

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
			this.storage["downloadedPieces"].size,
			this.metadata.pieceCount,
			this.speedBytesPerSec,
		);

		if (this.storage["downloadedPieces"].size === this.metadata.pieceCount) {
			this.stop();
			log("complete", `${this.metadata.pieceCount} / ${this.metadata.pieceCount} pieces   ${this.metadata.name}`);
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

	private logProgress(): void {
		const downloaded = this.storage["downloadedPieces"].size;
		const total = this.metadata.pieceCount;
		const mbps = (this.speedBytesPerSec / (1024 * 1024)).toFixed(1);
		const remaining = total - downloaded;
		const eta = this.speedBytesPerSec > 0
			? Math.ceil((remaining * this.metadata.pieceLength) / this.speedBytesPerSec)
			: 0;
		const etaStr = eta > 0 ? `ETA ${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, "0")}` : "";
		log("progress", `${downloaded} / ${total} pieces   ${mbps} MB/s   ${etaStr}`);
	}

	// Resume

	private resumePath(): string {
		const hex = Buffer.from(this.metadata.infoHash).toString("hex");
		return join(getDataDir(), "resume", `${hex}.json`);
	}

	private loadResume(): void {
		const path = this.resumePath();
		if (!existsSync(path)) {
			log("resume", "no saved state — starting fresh");
			return;
		}
		try {
			const data = JSON.parse(readFileSync(path, "utf-8")) as {
				infoHash: string;
				downloadPath: string;
				downloadedPieces: number[];
			};
			if (data.downloadPath !== this.downloadPath) {
				log("resume", "download path changed — starting fresh");
				return;
			}
			for (const i of data.downloadedPieces) this.storage.markPiece(i);
			log("resume", `${data.downloadedPieces.length} / ${this.metadata.pieceCount} pieces restored`);
		} catch {
			log("resume", "could not read save file — starting fresh");
		}
	}

	private saveResume(): void {
		const path = this.resumePath();
		const dir = join(getDataDir(), "resume");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const data = {
			infoHash: Buffer.from(this.metadata.infoHash).toString("hex"),
			downloadPath: this.downloadPath,
			downloadedPieces: [...this.storage["downloadedPieces"]],
			savedAt: Math.floor(Date.now() / 1000),
		};
		writeFileSync(path, JSON.stringify(data), "utf-8");
	}
}

function bufEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
