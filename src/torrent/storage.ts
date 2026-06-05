import {
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open as openAsync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SHA1 } from "bun";
import type { TorrentMetadata } from "./metadata.ts";
import { log } from "./metadata.ts";

interface StorageSetupSummary {
	createdFiles: number;
	existingFiles: number;
	allFilesCreated: boolean;
}

export interface VerifyAllOptions {
	tolerateMissing?: boolean;
	yieldEveryPieces?: number;
	yieldEveryMs?: number;
	chunkSizeBytes?: number;
	signal?: AbortSignal;
	onProgress?: (
		checked: number,
		valid: number,
		missing: number,
		corrupt: number,
	) => void;
}

export interface VerifyAllSummary {
	valid: number;
	missing: number;
	corrupt: number;
}

type ReadHandleMap = Map<string, number>;
type AsyncReadHandleMap = Map<string, FileHandle>;

const DEFAULT_VERIFY_CHUNK_SIZE = 1024 * 1024;

export class VerificationCancelledError extends Error {
	constructor() {
		super("Verification cancelled");
		this.name = "VerificationCancelledError";
	}
}

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

	async setup(): Promise<StorageSetupSummary> {
		let createdFiles = 0;
		let existingFiles = 0;

		for (const file of this.metadata.storageFiles) {
			if (file.padding) continue;
			const fullPath = join(this.downloadPath, file.path);
			const dir = dirname(fullPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

			if (!existsSync(fullPath)) {
				// Sparse file: tells the OS the file size with no RAM allocation.
				// Unwritten regions read as zeros.
				const fd = openSync(fullPath, "w");
				ftruncateSync(fd, file.length);
				closeSync(fd);
				createdFiles++;
				log("storage", `created   ${fullPath}  (${formatSize(file.length)})`);
			} else {
				existingFiles++;
				log("storage", `exists    ${fullPath}  (${formatSize(file.length)})`);
			}
		}

		return {
			createdFiles,
			existingFiles,
			allFilesCreated:
				this.metadata.storageFiles.some((file) => !file.padding) &&
				existingFiles === 0,
		};
	}

	readPieceSync(pieceIndex: number): Buffer {
		const data = this.readPieceMaybeSync(pieceIndex, false);
		if (!data) {
			throw new Error(`Unable to read piece ${pieceIndex}`);
		}
		return data;
	}

	private readPieceMaybeSync(
		pieceIndex: number,
		tolerateMissing: boolean,
		readHandles?: ReadHandleMap,
	): Buffer | null {
		const ranges = this.metadata.pieceToFileRanges(pieceIndex);
		const isLastPiece = pieceIndex === this.metadata.pieceCount - 1;
		const pieceLen = isLastPiece
			? this.metadata.totalSize - pieceIndex * this.metadata.pieceLength
			: this.metadata.pieceLength;

		const result = Buffer.alloc(pieceLen);
		let written = 0;

		for (const { file, fileOffset, length } of ranges) {
			if (file.padding) {
				result.fill(0, written, written + length);
				written += length;
				continue;
			}
			const fullPath = join(this.downloadPath, file.path);
			if (!existsSync(fullPath)) {
				if (tolerateMissing) return null;
				throw new Error(`Missing file: ${fullPath}`);
			}
			const { fd, owned } = this.getReadHandle(fullPath, readHandles);
			try {
				const bytesRead = readSync(fd, result, written, length, fileOffset);
				if (bytesRead !== length) {
					if (tolerateMissing) return null;
					throw new Error(`Short read: ${fullPath}`);
				}
			} finally {
				if (owned) {
					closeSync(fd);
				}
			}
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
			if (file.padding) {
				offset += length;
				continue;
			}
			const fullPath = join(this.downloadPath, file.path);
			const fd = openSync(fullPath, "r+");
			try {
				const bytesWritten = writeSync(fd, data, offset, length, fileOffset);
				if (bytesWritten !== length) {
					throw new Error(`Short write: ${fullPath}`);
				}
			} finally {
				closeSync(fd);
			}
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

		const data = this.readPieceMaybeSync(pieceIndex, true);
		if (!data) return false;
		if (isAllZero(data) && !this.isPaddingOnlyPiece(pieceIndex)) return false;

		const actual = new SHA1().update(data).digest() as unknown as Uint8Array;
		return bufEqual(actual, expected);
	}

	// Opens each file once and reads through it sequentially, yielding between
	// chunks so large pieces do not monopolize the TUI event loop.
	async verifyAll(options: VerifyAllOptions = {}): Promise<VerifyAllSummary> {
		const tolerateMissing = options.tolerateMissing ?? false;
		const yieldEveryPieces = options.yieldEveryPieces ?? 8;
		const yieldEveryMs = options.yieldEveryMs ?? 16;
		const chunkSizeBytes =
			options.chunkSizeBytes && options.chunkSizeBytes > 0
				? options.chunkSizeBytes
				: DEFAULT_VERIFY_CHUNK_SIZE;
		let valid = 0;
		let missing = 0;
		let corrupt = 0;
		let lastYield = Date.now();
		const syncReadHandles: ReadHandleMap = new Map();
		const asyncReadHandles: AsyncReadHandleMap = new Map();
		this.downloadedPieces.clear();

		const maybeYield = async (force = false): Promise<void> => {
			if (!force && Date.now() - lastYield < yieldEveryMs) return;
			await yieldToEventLoop();
			lastYield = Date.now();
			throwIfAborted(options.signal);
		};

		try {
			for (let i = 0; i < this.metadata.pieceCount; i++) {
				throwIfAborted(options.signal);

				const pieceState =
					this.pieceLengthForIndex(i) <= chunkSizeBytes
						? this.verifyPieceByBuffer(i, tolerateMissing, syncReadHandles)
						: await this.verifyPieceByChunks(
								i,
								tolerateMissing,
								chunkSizeBytes,
								asyncReadHandles,
								options.signal,
								maybeYield,
							);

				if (pieceState === "missing") {
					missing++;
					options.onProgress?.(i + 1, valid, missing, corrupt);
					await maybeYield((i + 1) % yieldEveryPieces === 0);
					continue;
				}

				if (pieceState === "corrupt") {
					corrupt++;
				} else {
					valid++;
					this.downloadedPieces.add(i);
				}

				options.onProgress?.(i + 1, valid, missing, corrupt);
				await maybeYield((i + 1) % yieldEveryPieces === 0);
			}
		} finally {
			this.closeReadHandles(syncReadHandles);
			await this.closeAsyncReadHandles(asyncReadHandles);
		}

		log(
			"verify",
			`${this.metadata.pieceCount} pieces checked   ${valid} valid   ${missing} missing   ${corrupt} corrupt`,
		);
		return { valid, missing, corrupt };
	}

	markPiece(index: number): void {
		this.downloadedPieces.add(index);
	}

	hasPiece(pieceIndex: number): boolean {
		return this.downloadedPieces.has(pieceIndex);
	}

	get downloadedCount(): number {
		return this.downloadedPieces.size;
	}

	get downloadedBytes(): number {
		let total = 0;
		for (const pieceIndex of this.downloadedPieces) {
			total += this.pieceLengthForIndex(pieceIndex);
		}
		return total;
	}

	getDownloadedPieces(): ReadonlySet<number> {
		return this.downloadedPieces;
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

	private getReadHandle(
		fullPath: string,
		readHandles?: ReadHandleMap,
	): { fd: number; owned: boolean } {
		if (!readHandles) {
			return { fd: openSync(fullPath, "r"), owned: true };
		}

		const cached = readHandles.get(fullPath);
		if (cached !== undefined) {
			return { fd: cached, owned: false };
		}

		const fd = openSync(fullPath, "r");
		readHandles.set(fullPath, fd);
		return { fd, owned: false };
	}

	private closeReadHandles(readHandles: ReadHandleMap): void {
		for (const fd of readHandles.values()) {
			closeSync(fd);
		}
		readHandles.clear();
	}

	private verifyPieceByBuffer(
		pieceIndex: number,
		tolerateMissing: boolean,
		readHandles: ReadHandleMap,
	): "valid" | "missing" | "corrupt" {
		const expected = this.metadata.pieceHashes[pieceIndex];
		if (!expected) return "corrupt";

		const data = this.readPieceMaybeSync(
			pieceIndex,
			tolerateMissing,
			readHandles,
		);
		if (!data) return "missing";
		if (isAllZero(data) && !this.isPaddingOnlyPiece(pieceIndex))
			return "missing";

		const actual = new SHA1().update(data).digest() as unknown as Uint8Array;
		return bufEqual(actual, expected) ? "valid" : "corrupt";
	}

	private async verifyPieceByChunks(
		pieceIndex: number,
		tolerateMissing: boolean,
		chunkSizeBytes: number,
		readHandles: AsyncReadHandleMap,
		signal: AbortSignal | undefined,
		maybeYield: () => Promise<void>,
	): Promise<"valid" | "missing" | "corrupt"> {
		const expected = this.metadata.pieceHashes[pieceIndex];
		if (!expected) return "corrupt";

		const hash = new SHA1();
		let sawNonZero = false;

		for (const { file, fileOffset, length } of this.metadata.pieceToFileRanges(
			pieceIndex,
		)) {
			if (file.padding) {
				let remaining = length;
				while (remaining > 0) {
					throwIfAborted(signal);
					const chunkLength = Math.min(remaining, chunkSizeBytes);
					hash.update(Buffer.alloc(chunkLength));
					remaining -= chunkLength;
					await maybeYield();
				}
				continue;
			}
			const fullPath = join(this.downloadPath, file.path);
			const handle = await this.getAsyncReadHandle(
				fullPath,
				tolerateMissing,
				readHandles,
			);
			if (!handle) return "missing";

			let remaining = length;
			let offset = fileOffset;
			while (remaining > 0) {
				throwIfAborted(signal);

				const chunkLength = Math.min(remaining, chunkSizeBytes);
				const chunk = Buffer.allocUnsafe(chunkLength);
				const { bytesRead } = await handle.read(chunk, 0, chunkLength, offset);
				if (bytesRead !== chunkLength) {
					if (tolerateMissing) return "missing";
					throw new Error(`Short read: ${fullPath}`);
				}

				if (!sawNonZero && !isAllZero(chunk)) sawNonZero = true;
				hash.update(chunk);
				remaining -= bytesRead;
				offset += bytesRead;
				await maybeYield();
			}
		}

		if (!sawNonZero && !this.isPaddingOnlyPiece(pieceIndex)) return "missing";

		const actual = hash.digest() as unknown as Uint8Array;
		return bufEqual(actual, expected) ? "valid" : "corrupt";
	}

	private async getAsyncReadHandle(
		fullPath: string,
		tolerateMissing: boolean,
		readHandles: AsyncReadHandleMap,
	): Promise<FileHandle | null> {
		const cached = readHandles.get(fullPath);
		if (cached) return cached;

		try {
			const handle = await openAsync(fullPath, "r");
			readHandles.set(fullPath, handle);
			return handle;
		} catch (err) {
			if (
				tolerateMissing &&
				err instanceof Error &&
				"code" in err &&
				err.code === "ENOENT"
			) {
				return null;
			}
			throw err;
		}
	}

	private async closeAsyncReadHandles(
		readHandles: AsyncReadHandleMap,
	): Promise<void> {
		const handles = [...readHandles.values()];
		readHandles.clear();
		await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
	}

	private pieceLengthForIndex(pieceIndex: number): number {
		const isLastPiece = pieceIndex === this.metadata.pieceCount - 1;
		return isLastPiece
			? this.metadata.totalSize - pieceIndex * this.metadata.pieceLength
			: this.metadata.pieceLength;
	}

	private isPaddingOnlyPiece(pieceIndex: number): boolean {
		const ranges = this.metadata.pieceToFileRanges(pieceIndex);
		return ranges.length > 0 && ranges.every(({ file }) => file.padding);
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

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new VerificationCancelledError();
	}
}
