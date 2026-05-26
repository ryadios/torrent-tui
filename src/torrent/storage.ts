import {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	ftruncateSync,
	readSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SHA1 } from "bun";
import { log } from "./metadata.ts";
import type { TorrentMetadata } from "./metadata.ts";

function formatSize(bytes: number): string {
	const gb = bytes / (1024 * 1024 * 1024);
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	const mb = bytes / (1024 * 1024);
	if (mb >= 1) return `${mb.toFixed(1)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

export class StorageManager {
	private readonly downloadPath: string;
	private readonly downloadedPieces = new Set<number>();

	constructor(
		private readonly metadata: TorrentMetadata,
		basePath: string,
	) {
		this.downloadPath = basePath;
	}

	async setup(): Promise<void> {
		for (const file of this.metadata.files) {
			const fullPath = join(this.downloadPath, file.path);
			const dir = dirname(fullPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

			if (!existsSync(fullPath)) {
				// Sparse file: tells the OS the file size with no RAM allocation.
				// Unwritten regions read as zeros.
				const fd = openSync(fullPath, "w");
				ftruncateSync(fd, file.length);
				closeSync(fd);
				log("storage", `created   ${fullPath}  (${formatSize(file.length)})`);
			} else {
				log("storage", `exists    ${fullPath}  (${formatSize(file.length)})`);
			}
		}
	}

	readPieceSync(pieceIndex: number): Buffer {
		const ranges = this.metadata.pieceToFileRanges(pieceIndex);
		const isLastPiece = pieceIndex === this.metadata.pieceCount - 1;
		const pieceLen = isLastPiece
			? this.metadata.totalSize - pieceIndex * this.metadata.pieceLength
			: this.metadata.pieceLength;

		const result = Buffer.allocUnsafe(pieceLen);
		let written = 0;

		for (const { file, fileOffset, length } of ranges) {
			const fullPath = join(this.downloadPath, file.path);
			const fd = openSync(fullPath, "r");
			readSync(fd, result, written, length, fileOffset);
			closeSync(fd);
			written += length;
		}

		return result;
	}

	async readPiece(pieceIndex: number): Promise<Uint8Array> {
		return this.readPieceSync(pieceIndex);
	}

	writePieceSync(pieceIndex: number, data: Uint8Array): void {
		const ranges = this.metadata.pieceToFileRanges(pieceIndex);
		let offset = 0;

		for (const { file, fileOffset, length } of ranges) {
			const fullPath = join(this.downloadPath, file.path);
			const fd = openSync(fullPath, "r+");
			writeSync(fd, data, offset, length, fileOffset);
			closeSync(fd);
			offset += length;
		}

		this.downloadedPieces.add(pieceIndex);
	}

	async writePiece(pieceIndex: number, data: Uint8Array): Promise<void> {
		this.writePieceSync(pieceIndex, data);
	}

	async verifyPiece(pieceIndex: number): Promise<boolean> {
		const expected = this.metadata.pieceHashes[pieceIndex];
		if (!expected) return false;

		const data = this.readPieceSync(pieceIndex);
		if (isAllZero(data)) return false;

		const actual = new SHA1().update(data).digest() as unknown as Uint8Array;
		return bufEqual(actual, expected);
	}

	// Opens each file once and reads through it sequentially — no per-piece open/close.
	async verifyAll(): Promise<{ valid: number; missing: number; corrupt: number }> {
		let valid = 0;
		let missing = 0;
		let corrupt = 0;

		const pieceBuf = Buffer.allocUnsafe(this.metadata.pieceLength);

		for (let i = 0; i < this.metadata.pieceCount; i++) {
			const isLastPiece = i === this.metadata.pieceCount - 1;
			const pieceLen = isLastPiece
				? this.metadata.totalSize - i * this.metadata.pieceLength
				: this.metadata.pieceLength;

			const data = pieceBuf.subarray(0, pieceLen);
			let written = 0;

			for (const { file, fileOffset, length } of this.metadata.pieceToFileRanges(i)) {
				const fullPath = join(this.downloadPath, file.path);
				const fd = openSync(fullPath, "r");
				readSync(fd, data, written, length, fileOffset);
				closeSync(fd);
				written += length;
			}

			if (isAllZero(data)) {
				missing++;
				continue;
			}

			const expected = this.metadata.pieceHashes[i];
			if (!expected) { corrupt++; continue; }

			const actual = new SHA1().update(data).digest() as unknown as Uint8Array;
			if (bufEqual(actual, expected)) {
				valid++;
				this.downloadedPieces.add(i);
			} else {
				corrupt++;
			}
		}

		log("verify", `${this.metadata.pieceCount} pieces checked   ${valid} valid   ${missing} missing   ${corrupt} corrupt`);
		return { valid, missing, corrupt };
	}

	markPiece(index: number): void {
		this.downloadedPieces.add(index);
	}

	hasPiece(pieceIndex: number): boolean {
		return this.downloadedPieces.has(pieceIndex);
	}

	getBitfield(): Uint8Array {
		const byteCount = Math.ceil(this.metadata.pieceCount / 8);
		const bitfield = new Uint8Array(byteCount);
		for (const i of this.downloadedPieces) {
			const byte = Math.floor(i / 8);
			const bit = 7 - (i % 8);
			if (byte < byteCount) {
				bitfield[byte] = (bitfield[byte] ?? 0) | (1 << bit);
			}
		}
		return bitfield;
	}
}

function isAllZero(buf: Uint8Array): boolean {
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
}

function bufEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
