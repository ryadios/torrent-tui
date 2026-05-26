import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHA1 } from "bun";
import { log } from "./metadata.ts";
import { PiecePicker } from "./piece-picker.ts";
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
	private uploadBytesPerSec = 0;
	private progressInterval: ReturnType<typeof setInterval> | null = null;
	private logFilePath: string;
	private progressActive = false;
	private picker!: PiecePicker;

	constructor(
		private metadata: TorrentMetadata,
		private storage: StorageManager,
		private manager: PeerManager,
		private downloadPath: string,
	) {
		super();
		const logDir = join(getDataDir(), "logs");
		if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
		const hex = Buffer.from(metadata.infoHash).toString("hex");
		this.logFilePath = join(logDir, `${hex}.log`);
	}

	getLogFilePath(): string { return this.logFilePath; }

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

		this.progressInterval = setInterval(() => this.logProgress(), 2_000);
	}

	stop(): void {
		this.stopped = true;
		if (this.progressInterval) clearInterval(this.progressInterval);
		if (this.progressActive) {
			process.stdout.write("\n");
			this.progressActive = false;
		}
	}

	private wirePeer(conn: PeerConnection): void {
		const key = `${conn.address}:${conn.port}`;
		if (this.bannedPeers.has(key)) return;
		if (!this.pendingRequests.has(key)) this.pendingRequests.set(key, new Set());

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
			this.uploadBytesPerSec = (this.uploadBytesPerSec + block.length) / 2;
			log("upload", `piece=${index} block=${begin / 16384}  ${conn.address}:${conn.port}`);
		});

		conn.on("disconnect", () => {
			this.picker.removePeer(conn);
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
		this.inProgress.set(pieceIndex, { blocks: new Array(total).fill(null), received: 0, total });
		this.fileLog(`piece ${pieceIndex}  started  ${total} blocks  (avail ${this.picker.availabilityOf(pieceIndex)})`);
		return { pieceIndex, begin: 0, length: this.blockLength(pieceIndex, 0) };
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
			this.fileLog(`piece ${index}  FAIL  peer ${conn.peerId.slice(0, 8)}  strike ${strikes}`);
			this.consolePrint(`  piece       ${index}  FAIL  (${conn.peerId.slice(0, 8)}, strike ${strikes})`);

			if (strikes >= CORRUPT_STRIKE_LIMIT) {
				this.bannedPeers.add(key);
				conn.suppressDisconnect = true;
				conn.destroy();
				this.consolePrint(`  banned      ${conn.peerId.slice(0, 8)}  (${strikes} corrupt pieces)`);
			}

			this.emit("piece:failed", index, key);
			this.advanceNextPiece();
			return;
		}

		// Write to disk
		this.storage.writePieceSync(index, assembled);
		this.saveResume();
		this.fileLog(`piece ${index}  ok`);

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
			this.consolePrint(`  complete     ${this.metadata.pieceCount} / ${this.metadata.pieceCount} pieces   ${this.metadata.name}`);
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
		const downloaded = this.storage.downloadedCount;
		const total = this.metadata.pieceCount;
		const pct = total > 0 ? downloaded / total : 0;
		const dlMbps = (this.speedBytesPerSec / (1024 * 1024)).toFixed(1);
		const ulKbps = (this.uploadBytesPerSec / 1024).toFixed(0);
		const remaining = total - downloaded;
		const etaSecs = this.speedBytesPerSec > 0
			? Math.ceil((remaining * this.metadata.pieceLength) / this.speedBytesPerSec)
			: 0;
		const eta = etaSecs > 0
			? `${Math.floor(etaSecs / 60)}:${String(etaSecs % 60).padStart(2, "0")}`
			: "--:--";

		const cols = process.stdout.columns ?? 80;
		const statsStr = `  ${downloaded}/${total} (${(pct * 100).toFixed(1)}%)  ↓${dlMbps}MB/s  ↑${ulKbps}KB/s  ETA ${eta}`;
		const barWidth = Math.max(8, cols - statsStr.length - 4);
		const filled = Math.floor(pct * barWidth);
		const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
		const line = `  [${bar}]${statsStr}`;

		if (process.stdout.isTTY) {
			process.stdout.write(`\r${line.padEnd(cols - 1)}`);
			this.progressActive = true;
		} else {
			log("progress", `${downloaded} / ${total}  ↓${dlMbps}MB/s  ↑${ulKbps}KB/s  ETA ${eta}`);
		}
	}

	private consolePrint(line: string): void {
		if (this.progressActive) {
			const cols = process.stdout.columns ?? 80;
			process.stdout.write(`\r${" ".repeat(cols - 1)}\r`); // clear progress line
		}
		console.log(line);
		if (this.progressActive) this.logProgress(); // redraw bar
	}

	private fileLog(message: string): void {
		const time = new Date().toISOString().slice(11, 19);
		appendFileSync(this.logFilePath, `[${time}] ${message}\n`);
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
			const n = data.downloadedPieces.length;
			log("resume", `${n} / ${this.metadata.pieceCount} pieces restored`);
			this.fileLog(`resume loaded: ${n} pieces`);
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
			downloadedPieces: [...this.storage.getDownloadedPieces()],
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
