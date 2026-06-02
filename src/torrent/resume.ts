import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../utils/json.ts";
import { getDataDir } from "../utils/paths.ts";
import type { TorrentMetadata } from "./metadata.ts";

export const RESUME_SCHEMA_VERSION = 2;

export interface ResumeFileFingerprint {
	path: string;
	length: number;
	mtimeMs: number;
}

export interface TorrentResumeData {
	schemaVersion: number;
	infoHash: string;
	downloadPath: string;
	verifiedPieces: number[];
	downloadedPieces?: number[];
	files: ResumeFileFingerprint[];
	savedAt: number;
	selectedFileIndices?: number[] | null;
}

export interface TrustedResumeData {
	data: TorrentResumeData;
	verifiedPieces: number[];
	selectedFileIndices: number[] | null;
}

export function resumePathForInfoHash(infoHash: string): string {
	return join(getDataDir(), "resume", `${infoHash}.json`);
}

export function infoHashHex(metadata: TorrentMetadata): string {
	return Buffer.from(metadata.infoHash).toString("hex");
}

export function readResumeData(infoHash: string): TorrentResumeData | null {
	const path = resumePathForInfoHash(infoHash);
	if (!existsSync(path)) return null;

	try {
		return JSON.parse(readFileSync(path, "utf-8")) as TorrentResumeData;
	} catch {
		return null;
	}
}

export function loadTrustedResumeData(
	metadata: TorrentMetadata,
	downloadPath: string,
): TrustedResumeData | null {
	const infoHash = infoHashHex(metadata);
	const data = readResumeData(infoHash);
	if (!data || !isTrustedResumeData(data, metadata, downloadPath)) return null;

	return {
		data,
		verifiedPieces: normalizeVerifiedPieces(
			data.verifiedPieces ?? data.downloadedPieces ?? [],
			metadata.pieceCount,
		),
		selectedFileIndices: normalizeSelectedFileIndices(
			data.selectedFileIndices,
			metadata.files.length,
		),
	};
}

export function writeResumeData(
	metadata: TorrentMetadata,
	downloadPath: string,
	verifiedPieces: Iterable<number>,
	selectedFileIndices?: number[] | null,
): void {
	const infoHash = infoHashHex(metadata);
	const files = buildFileFingerprints(metadata, downloadPath);
	if (!files) return;

	const pieces = normalizeVerifiedPieces(
		[...verifiedPieces],
		metadata.pieceCount,
	);
	writeJsonAtomic(resumePathForInfoHash(infoHash), {
		schemaVersion: RESUME_SCHEMA_VERSION,
		infoHash,
		downloadPath,
		verifiedPieces: pieces,
		downloadedPieces: pieces,
		files,
		savedAt: Math.floor(Date.now() / 1000),
		selectedFileIndices: selectedFileIndices ?? null,
	});
}

export function buildFileFingerprints(
	metadata: TorrentMetadata,
	downloadPath: string,
): ResumeFileFingerprint[] | null {
	const files: ResumeFileFingerprint[] = [];

	for (const file of metadata.files) {
		const fullPath = join(downloadPath, file.path);
		if (!existsSync(fullPath)) return null;
		const stat = statSync(fullPath);
		files.push({
			path: file.path,
			length: stat.size,
			mtimeMs: Math.trunc(stat.mtimeMs),
		});
	}

	return files;
}

function isTrustedResumeData(
	data: TorrentResumeData,
	metadata: TorrentMetadata,
	downloadPath: string,
): boolean {
	if (data.schemaVersion !== RESUME_SCHEMA_VERSION) return false;
	if (data.infoHash !== infoHashHex(metadata)) return false;
	if (data.downloadPath !== downloadPath) return false;
	if (!Array.isArray(data.files)) return false;
	if (data.files.length !== metadata.files.length) return false;

	const current = buildFileFingerprints(metadata, downloadPath);
	if (!current) return false;

	for (let i = 0; i < current.length; i++) {
		const expected = data.files[i];
		const actual = current[i];
		if (!expected || !actual) return false;
		if (expected.path !== actual.path) return false;
		if (expected.length !== actual.length) return false;
		if (expected.mtimeMs !== actual.mtimeMs) return false;
	}

	return true;
}

function normalizeVerifiedPieces(
	pieces: number[],
	pieceCount: number,
): number[] {
	const unique = new Set<number>();
	for (const piece of pieces) {
		if (Number.isInteger(piece) && piece >= 0 && piece < pieceCount) {
			unique.add(piece);
		}
	}
	return [...unique].sort((a, b) => a - b);
}

export function normalizeSelectedFileIndices(
	stored: number[] | null | undefined,
	fileCount: number,
): number[] | null {
	if (!stored || !Array.isArray(stored)) return null;
	const valid = stored.filter(
		(i) => Number.isInteger(i) && i >= 0 && i < fileCount,
	);
	if (valid.length === fileCount) return null; // all selected = null
	return [...new Set(valid)].sort((a, b) => a - b);
}
