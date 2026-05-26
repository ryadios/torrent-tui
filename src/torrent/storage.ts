import { existsSync, mkdirSync } from "node:fs";
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
				await Bun.write(fullPath, new Uint8Array(file.length));
				log("storage", `created   ${fullPath}  (${formatSize(file.length)})`);
			} else {
				log("storage", `exists    ${fullPath}  (${formatSize(file.length)})`);
			}
		}
	}

	async readPiece(pieceIndex: number): Promise<Uint8Array> {
		const ranges = this.metadata.pieceToFileRanges(pieceIndex);
		const isLastPiece = pieceIndex === this.metadata.pieceCount - 1;
		const pieceLen = isLastPiece
			? this.metadata.totalSize - pieceIndex * this.metadata.pieceLength
			: this.metadata.pieceLength;

		const result = new Uint8Array(pieceLen);
		let written = 0;

		for (const { file, fileOffset, length } of ranges) {
			const fullPath = join(this.downloadPath, file.path);
			const buf = await Bun.file(fullPath).arrayBuffer();
			const slice = new Uint8Array(buf, fileOffset, length);
			result.set(slice, written);
			written += length;
		}

		return result;
	}

	async writePiece(pieceIndex: number, data: Uint8Array): Promise<void> {
		const ranges = this.metadata.pieceToFileRanges(pieceIndex);
		let read = 0;

		for (const { file, fileOffset, length } of ranges) {
			const fullPath = join(this.downloadPath, file.path);
			const existing = new Uint8Array(await Bun.file(fullPath).arrayBuffer());
			existing.set(data.subarray(read, read + length), fileOffset);
			await Bun.write(fullPath, existing);
			read += length;
		}

		this.downloadedPieces.add(pieceIndex);
	}

	async verifyPiece(pieceIndex: number): Promise<boolean> {
		const expected = this.metadata.pieceHashes[pieceIndex];
		if (!expected) return false;

		const data = await this.readPiece(pieceIndex);

		// Check if the piece is all zeros (pre-allocated but never written)
		const isZero = data.every((b) => b === 0);
		if (isZero) return false;

		const actual = new SHA1().update(data).digest() as unknown as Uint8Array;
		if (actual.length !== expected.length) return false;
		for (let i = 0; i < actual.length; i++) {
			if (actual[i] !== expected[i]) return false;
		}
		return true;
	}

	async verifyAll(): Promise<{ valid: number; missing: number; corrupt: number }> {
		let valid = 0;
		let missing = 0;
		let corrupt = 0;

		for (let i = 0; i < this.metadata.pieceCount; i++) {
			const data = await this.readPiece(i);
			const isZero = data.every((b) => b === 0);

			if (isZero) {
				missing++;
				continue;
			}

			const expected = this.metadata.pieceHashes[i];
			if (!expected) { corrupt++; continue; }

			const actual = new SHA1().update(data).digest() as unknown as Uint8Array;
			let match = true;
			for (let j = 0; j < 20; j++) {
				if (actual[j] !== expected[j]) { match = false; break; }
			}

			if (match) {
				valid++;
				this.downloadedPieces.add(i);
			} else {
				corrupt++;
			}
		}

		log("verify", `${this.metadata.pieceCount} pieces checked   ${valid} valid   ${missing} missing   ${corrupt} corrupt`);
		return { valid, missing, corrupt };
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
