import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { AppSettings } from "../config/settings";
import { getConfigDir, getDataDir, resolvePath } from "../utils/paths";
import type { PeerInfo } from "./types";

interface IpRange {
	start: number;
	end: number;
}

export class Blocklist {
	private readonly ranges: IpRange[];

	constructor(ranges: IpRange[] = []) {
		this.ranges = mergeRanges(ranges);
	}

	isBlocked(peer: PeerInfo): boolean {
		const ip = ipv4ToNumber(peer.ip);
		if (ip === null) return false;
		let lo = 0;
		let hi = this.ranges.length - 1;
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			const range = this.ranges[mid];
			if (!range) break;
			if (ip < range.start) hi = mid - 1;
			else if (ip > range.end) lo = mid + 1;
			else return true;
		}
		return false;
	}

	get size(): number {
		return this.ranges.length;
	}
}

export async function loadBlocklist(settings: AppSettings): Promise<Blocklist> {
	if (!settings.blocklistEnabled) return new Blocklist();
	const ranges: IpRange[] = [];
	for (const path of blocklistPaths(settings)) {
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf-8");
		ranges.push(...parseBlocklist(content));
	}
	const urlContent = await loadUrlBlocklist(settings).catch(() => "");
	if (urlContent) ranges.push(...parseBlocklist(urlContent));
	return new Blocklist(ranges);
}

export function parseBlocklist(content: string): IpRange[] {
	const ranges: IpRange[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("//")) continue;
		const range = parseBlocklistLine(line);
		if (range) ranges.push(range);
	}
	return ranges;
}

function blocklistPaths(settings: AppSettings): string[] {
	const configured = settings.blocklistPaths.map(resolvePath);
	const dir = join(getConfigDir(), "blocklists");
	if (!existsSync(dir)) return configured;
	const discovered = readdirSync(dir)
		.map((file) => join(dir, file))
		.filter((path) => statSync(path).isFile());
	return [...configured, ...discovered];
}

async function loadUrlBlocklist(settings: AppSettings): Promise<string> {
	if (!settings.blocklistUrl) return "";
	const cacheDir = join(getDataDir(), "blocklists");
	mkdirSync(cacheDir, { recursive: true });
	const cachePath = join(cacheDir, safeCacheName(settings.blocklistUrl));
	const refreshMs = settings.blocklistRefreshHours * 60 * 60 * 1000;
	if (existsSync(cachePath)) {
		const ageMs = Date.now() - statSync(cachePath).mtimeMs;
		if (ageMs < refreshMs) return readFileSync(cachePath, "utf-8");
	}
	const response = await fetch(settings.blocklistUrl);
	if (!response.ok) {
		if (existsSync(cachePath)) return readFileSync(cachePath, "utf-8");
		return "";
	}
	const content = await response.text();
	writeFileSync(cachePath, content);
	return content;
}

function safeCacheName(url: string): string {
	return basename(url).replace(/[^a-zA-Z0-9._-]/g, "_") || "blocklist.txt";
}

function parseBlocklistLine(line: string): IpRange | null {
	const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(line);
	if (cidr) return parseCidr(cidr[1] ?? "", Number(cidr[2]));

	const ips = line.match(/\d{1,3}(?:\.\d{1,3}){3}/g);
	if (!ips || ips.length === 0) return null;
	const first = ipv4ToNumber(ips[0] ?? "");
	if (first === null) return null;
	const second = ips[1] ? ipv4ToNumber(ips[1]) : first;
	if (second === null) return null;
	return {
		start: Math.min(first, second),
		end: Math.max(first, second),
	};
}

function parseCidr(ipText: string, bits: number): IpRange | null {
	const ip = ipv4ToNumber(ipText);
	if (ip === null || bits < 0 || bits > 32) return null;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	const start = (ip & mask) >>> 0;
	const size = 2 ** (32 - bits);
	return { start, end: start + size - 1 };
}

function ipv4ToNumber(ip: string): number | null {
	const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
	const parts = normalized.split(".");
	if (parts.length !== 4) return null;
	let out = 0;
	for (const part of parts) {
		const n = Number(part);
		if (!Number.isInteger(n) || n < 0 || n > 255) return null;
		out = (out << 8) + n;
	}
	return out >>> 0;
}

function mergeRanges(ranges: IpRange[]): IpRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: IpRange[] = [];
	for (const range of sorted) {
		const last = merged.at(-1);
		if (!last || range.start > last.end + 1) {
			merged.push({ ...range });
			continue;
		}
		last.end = Math.max(last.end, range.end);
	}
	return merged;
}
