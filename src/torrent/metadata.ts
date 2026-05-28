import { SHA1 } from "bun";
import type { BencodeValue } from "./parser.ts";
import { extractInfoBytes } from "./parser.ts";
import type { FileInfo } from "./types.ts";

const TEXT_DECODER = new TextDecoder();

export function log(prefix: string, message: string): void {
	const pad = 10;
	console.log(`  ${prefix.padEnd(pad)}  ${message}`);
}

export class TorrentMetadata {
	readonly name: string;
	readonly totalSize: number;
	readonly pieceLength: number;
	readonly pieceCount: number;
	readonly pieceHashes: Uint8Array[];
	readonly files: FileInfo[];
	readonly infoHash: Uint8Array;
	readonly announceList: string[][];

	constructor(
		decoded: { [key: string]: BencodeValue },
		rawTorrentBytes: Uint8Array,
	) {
		const info = decoded.info;
		if (
			typeof info !== "object" ||
			info === null ||
			Array.isArray(info) ||
			info instanceof Uint8Array
		) {
			throw new Error("Missing or invalid info dict");
		}
		const infoDict = info as { [key: string]: BencodeValue };

		// name
		const nameRaw = infoDict.name;
		if (!(nameRaw instanceof Uint8Array) && typeof nameRaw !== "string") {
			throw new Error("Missing name in info dict");
		}
		this.name =
			nameRaw instanceof Uint8Array ? TEXT_DECODER.decode(nameRaw) : nameRaw;

		// piece length
		const pl = infoDict["piece length"];
		if (typeof pl !== "number") throw new Error("Missing piece length");
		this.pieceLength = pl;

		// piece hashes
		const piecesRaw = infoDict.pieces;
		if (!(piecesRaw instanceof Uint8Array)) {
			throw new Error("Missing or invalid pieces");
		}
		if (piecesRaw.length % 20 !== 0) {
			throw new Error("pieces length is not a multiple of 20");
		}
		this.pieceHashes = [];
		for (let i = 0; i < piecesRaw.length; i += 20) {
			this.pieceHashes.push(piecesRaw.slice(i, i + 20));
		}
		this.pieceCount = this.pieceHashes.length;

		// file list
		this.files = [];
		let offset = 0;
		const lengthField = infoDict.length;
		const filesField = infoDict.files;

		if (typeof lengthField === "number") {
			// single-file torrent
			this.files.push({ path: this.name, length: lengthField, offset: 0 });
			this.totalSize = lengthField;
		} else if (Array.isArray(filesField)) {
			// multi-file torrent
			for (const entry of filesField) {
				if (
					typeof entry !== "object" ||
					entry === null ||
					Array.isArray(entry) ||
					entry instanceof Uint8Array
				) {
					throw new Error("Invalid file entry");
				}
				const fileDict = entry as { [key: string]: BencodeValue };
				const fileLen = fileDict.length;
				const filePath = fileDict.path;
				if (typeof fileLen !== "number") throw new Error("Invalid file length");
				if (!Array.isArray(filePath)) throw new Error("Invalid file path");

				const parts = filePath.map((p) => {
					if (p instanceof Uint8Array) return TEXT_DECODER.decode(p);
					if (typeof p === "string") return p;
					throw new Error("Invalid path component");
				});

				const joinedPath = [this.name, ...parts].join("/");
				this.files.push({ path: joinedPath, length: fileLen, offset });
				offset += fileLen;
			}
			this.totalSize = offset;
		} else {
			throw new Error("info dict must have length or files");
		}

		// Hash the raw bytes from the original file — not a re-encoded version.
		// BEP 3: must extract the substring directly, not decode-encode roundtrip.
		this.infoHash = SHA1.hash(
			extractInfoBytes(rawTorrentBytes),
		) as unknown as Uint8Array;

		// announce list (BEP 12)
		const announceListRaw = decoded["announce-list"];
		if (Array.isArray(announceListRaw)) {
			this.announceList = announceListRaw
				.filter(Array.isArray)
				.map((tier) =>
					(tier as BencodeValue[])
						.map((url) => {
							if (url instanceof Uint8Array) return TEXT_DECODER.decode(url);
							if (typeof url === "string") return url;
							return null;
						})
						.filter((u): u is string => u !== null),
				)
				.filter((tier) => tier.length > 0);
		} else {
			const announce = decoded.announce;
			const announceStr =
				announce instanceof Uint8Array
					? TEXT_DECODER.decode(announce)
					: typeof announce === "string"
						? announce
						: null;
			this.announceList = announceStr ? [[announceStr]] : [];
		}
	}

	formatSize(): string {
		const gb = this.totalSize / (1024 * 1024 * 1024);
		if (gb >= 1) return `${gb.toFixed(1)} GB`;
		const mb = this.totalSize / (1024 * 1024);
		if (mb >= 1) return `${mb.toFixed(1)} MB`;
		return `${(this.totalSize / 1024).toFixed(1)} KB`;
	}

	formatPieceLength(): string {
		const kb = this.pieceLength / 1024;
		if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
		return `${kb.toFixed(0)} KB`;
	}

	// Returns which files a piece touches and the byte ranges within each file
	pieceToFileRanges(
		pieceIndex: number,
	): Array<{ file: FileInfo; fileOffset: number; length: number }> {
		const pieceStart = pieceIndex * this.pieceLength;
		const isLastPiece = pieceIndex === this.pieceCount - 1;
		const pieceLen = isLastPiece
			? this.totalSize - pieceStart
			: this.pieceLength;
		const pieceEnd = pieceStart + pieceLen;

		const ranges: Array<{
			file: FileInfo;
			fileOffset: number;
			length: number;
		}> = [];

		for (const file of this.files) {
			const fileEnd = file.offset + file.length;
			const overlapStart = Math.max(pieceStart, file.offset);
			const overlapEnd = Math.min(pieceEnd, fileEnd);
			if (overlapStart >= overlapEnd) continue;
			ranges.push({
				file,
				fileOffset: overlapStart - file.offset,
				length: overlapEnd - overlapStart,
			});
		}

		return ranges;
	}

	logSummary(): void {
		const httpTrackers = this.announceList
			.flat()
			.filter((u) => u.startsWith("http")).length;
		const udpTrackers = this.announceList
			.flat()
			.filter((u) => u.startsWith("udp")).length;
		const trackerParts = [
			httpTrackers > 0 ? `${httpTrackers} HTTP` : "",
			udpTrackers > 0 ? `${udpTrackers} UDP` : "",
		]
			.filter(Boolean)
			.join("  ");

		log(
			"torrent",
			`${this.name}   ${this.formatSize()}   ${this.pieceCount} × ${this.formatPieceLength()}   ${trackerParts || "no trackers"}`,
		);
	}
}
