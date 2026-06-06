import { readFileSync } from "node:fs";
import { decode, type BencodeValue } from "../torrent/parser";
import { TorrentMetadata } from "../torrent/metadata";

export interface TorrentInfoFile {
	path: string;
	length: number;
	offset: number;
	padding?: boolean;
}

export interface TorrentInfo {
	name: string;
	infoHash: string;
	totalSize: number;
	pieceLength: number;
	pieceCount: number;
	private: boolean;
	isMultiFile: boolean;
	trackers: string[][];
	webSeeds: string[];
	nodes: Array<{ ip: string; port: number }>;
	files: TorrentInfoFile[];
}

export function readTorrentInfo(torrentPath: string): TorrentInfo {
	const raw = new Uint8Array(readFileSync(torrentPath));
	return torrentInfoFromBytes(raw);
}

export function torrentInfoFromBytes(raw: Uint8Array): TorrentInfo {
	const decoded = decode(raw);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Invalid torrent file");
	}
	return torrentInfoFromMetadata(
		new TorrentMetadata(decoded as { [key: string]: BencodeValue }, raw),
	);
}

export function torrentInfoFromMetadata(metadata: TorrentMetadata): TorrentInfo {
	return {
		name: metadata.name,
		infoHash: Buffer.from(metadata.infoHash).toString("hex"),
		totalSize: metadata.totalSize,
		pieceLength: metadata.pieceLength,
		pieceCount: metadata.pieceCount,
		private: metadata.private,
		isMultiFile: metadata.isMultiFile,
		trackers: metadata.announceList.map((tier) => [...tier]),
		webSeeds: [...metadata.webSeeds],
		nodes: metadata.nodes.map((node) => ({ ...node })),
		files: metadata.files.map((file) => ({ ...file })),
	};
}

export function formatTorrentInfo(info: TorrentInfo): string {
	const lines = [
		line(),
		"  Torrent Info",
		line(),
		row("name", info.name),
		row("info-hash", info.infoHash),
		row("size", `${formatBytes(info.totalSize)} (${info.totalSize} bytes)`),
		row("pieces", `${info.pieceCount} x ${formatBytes(info.pieceLength)}`),
		row("private", info.private ? "yes" : "no"),
		row("mode", info.isMultiFile ? "multi-file" : "single-file"),
		"",
		"  trackers",
	];

	if (info.trackers.length === 0) {
		lines.push("    none");
	} else {
		for (let i = 0; i < info.trackers.length; i++) {
			const tier = info.trackers[i] ?? [];
			lines.push(`    tier ${i + 1}`);
			for (const tracker of tier) lines.push(`      ${tracker}`);
		}
	}

	lines.push("", "  web-seeds");
	if (info.webSeeds.length === 0) {
		lines.push("    none");
	} else {
		for (const seed of info.webSeeds) lines.push(`    ${seed}`);
	}

	lines.push("", "  dht-nodes");
	if (info.nodes.length === 0) {
		lines.push("    none");
	} else {
		for (const node of info.nodes) lines.push(`    ${node.ip}:${node.port}`);
	}

	lines.push("", "  files");
	for (const file of info.files) {
		lines.push(`    ${formatBytes(file.length).padStart(9)}  ${file.path}`);
	}

	lines.push(line());
	return `${lines.join("\n")}\n`;
}

export function formatTorrentInfoJson(info: TorrentInfo): string {
	return `${JSON.stringify(info, null, "\t")}\n`;
}

function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const label = units[unit] ?? "B";
	if (unit === 0) return `${bytes} ${label}`;
	return `${value.toFixed(value >= 10 ? 1 : 2)} ${label}`;
}

function line(): string {
	return "-".repeat(80);
}

function row(label: string, value: string): string {
	return `  ${label.padEnd(10)}  ${value}`;
}
