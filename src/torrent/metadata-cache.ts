import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHA1 } from "bun";
import { getDataDir } from "../utils/paths.ts";
import type { BencodeValue } from "./parser.ts";
import { decode, encode } from "./parser.ts";

export function metadataCacheDir(): string {
	return join(getDataDir(), "metadata");
}

export function metadataCachePath(infoHashHex: string): string {
	return join(metadataCacheDir(), `${infoHashHex}.torrent`);
}

export function readCachedMetadata(infoHashHex: string): Uint8Array | null {
	const path = metadataCachePath(infoHashHex);
	if (!existsSync(path)) return null;
	return new Uint8Array(readFileSync(path));
}

export function writeCachedMetadata(
	infoHashHex: string,
	rawTorrent: Uint8Array,
): string {
	const dir = metadataCacheDir();
	mkdirSync(dir, { recursive: true });
	const path = metadataCachePath(infoHashHex);
	writeFileSync(path, rawTorrent);
	return path;
}

export function buildTorrentFileFromInfo(options: {
	infoBytes: Uint8Array;
	announceList: string[];
}): Uint8Array {
	const parts: Uint8Array[] = [new TextEncoder().encode("d")];
	if (options.announceList[0]) {
		parts.push(encode("announce"));
		parts.push(encode(options.announceList[0]));
	}
	if (options.announceList.length > 0) {
		parts.push(encode("announce-list"));
		parts.push(encode(options.announceList.map((url) => [url])));
	}
	parts.push(encode("info"));
	parts.push(options.infoBytes);
	parts.push(new TextEncoder().encode("e"));
	return concat(parts);
}

export function verifyInfoBytes(
	infoBytes: Uint8Array,
	expectedInfoHash: Uint8Array,
): void {
	const decoded = decode(infoBytes);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Fetched metadata is not an info dictionary");
	}
	const actual = SHA1.hash(infoBytes) as unknown as Uint8Array;
	for (let i = 0; i < expectedInfoHash.length; i++) {
		if (actual[i] !== expectedInfoHash[i]) {
			throw new Error("Fetched metadata info_hash mismatch");
		}
	}
}

export class MetadataPieceAssembler {
	private readonly pieces: Array<Uint8Array | undefined>;
	private readonly pieceCount: number;

	constructor(
		readonly totalSize: number,
		private readonly blockSize: number,
	) {
		if (!Number.isInteger(totalSize) || totalSize <= 0) {
			throw new Error("metadata_size must be positive");
		}
		this.pieceCount = Math.ceil(totalSize / blockSize);
		this.pieces = new Array(this.pieceCount);
	}

	get count(): number {
		return this.pieceCount;
	}

	get complete(): boolean {
		for (let i = 0; i < this.pieceCount; i++) {
			if (!this.pieces[i]) return false;
		}
		return true;
	}

	missingPieces(): number[] {
		const missing: number[] = [];
		for (let i = 0; i < this.pieceCount; i++) {
			if (!this.pieces[i]) missing.push(i);
		}
		return missing;
	}

	addPiece(index: number, data: Uint8Array, totalSize: number): void {
		if (totalSize !== this.totalSize) throw new Error("metadata_size changed");
		if (!Number.isInteger(index) || index < 0 || index >= this.pieceCount) {
			throw new Error("metadata piece index out of range");
		}
		const expectedLength =
			index === this.pieceCount - 1
				? this.totalSize - this.blockSize * index
				: this.blockSize;
		if (data.length !== expectedLength) {
			throw new Error("metadata piece length mismatch");
		}
		this.pieces[index] = data;
	}

	assemble(): Uint8Array {
		if (!this.complete) throw new Error("metadata is incomplete");
		const arrays = this.pieces.filter(
			(piece): piece is Uint8Array => piece !== undefined,
		);
		return concat(arrays);
	}
}

export function torrentDictionaryWithInfo(
	info: { [key: string]: BencodeValue },
	announceList: string[],
): { [key: string]: BencodeValue } {
	const torrent: { [key: string]: BencodeValue } = { info };
	if (announceList[0]) torrent.announce = announceList[0];
	if (announceList.length > 0) {
		torrent["announce-list"] = announceList.map((url) => [url]);
	}
	return torrent;
}

function concat(arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, array) => sum + array.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.length;
	}
	return result;
}
