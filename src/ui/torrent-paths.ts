import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { expandTorrentPath, isRemoteTorrentSource } from "../torrent/source";

export type TorrentPathEntry = {
	name: string;
	path: string;
	kind: "directory" | "file";
};

export type TorrentPathSuggestion = TorrentPathEntry & {
	value: string;
};

export function compactTorrentPath(path: string): string {
	const relativePath = relative(homedir(), path);

	if (relativePath === "") return "~";
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return path;
	}

	return `~/${relativePath.split(sep).join("/")}`;
}

export async function readTorrentDirectory(
	directory: string,
): Promise<TorrentPathEntry[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<TorrentPathEntry | undefined> => {
			const path = join(directory, entry.name);
			let kind: TorrentPathEntry["kind"] | undefined;

			if (entry.isDirectory()) kind = "directory";
			else if (entry.isFile()) kind = "file";
			else if (entry.isSymbolicLink()) {
				try {
					const target = await stat(path);
					if (target.isDirectory()) kind = "directory";
					else if (target.isFile()) kind = "file";
				} catch {
					return undefined;
				}
			}

			if (
				!kind ||
				(kind === "file" &&
					!entry.name.toLowerCase().endsWith(".torrent"))
			) {
				return undefined;
			}

			return { name: entry.name, path, kind };
		}),
	);

	return resolved
		.filter((entry): entry is TorrentPathEntry => entry !== undefined)
		.sort((left, right) => {
			if (left.kind !== right.kind) {
				return left.kind === "directory" ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});
}

export async function listTorrentPathSuggestions(
	source: string,
): Promise<TorrentPathSuggestion[]> {
	if (!source || isRemoteTorrentSource(source)) return [];

	const value = source === "~" ? "~/" : source;
	const slash = value.lastIndexOf("/");
	const valueBase = slash === -1 ? "" : value.slice(0, slash + 1);
	const query = slash === -1 ? value : value.slice(slash + 1);
	const directory = expandTorrentPath(valueBase || ".");
	const entries = await readTorrentDirectory(directory);
	const needle = query.toLocaleLowerCase();

	return entries
		.filter((entry) => entry.name.toLocaleLowerCase().includes(needle))
		.sort((left, right) => {
			const leftPrefix = left.name.toLocaleLowerCase().startsWith(needle);
			const rightPrefix = right.name
				.toLocaleLowerCase()
				.startsWith(needle);
			if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
			if (left.kind !== right.kind) {
				return left.kind === "directory" ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		})
		.map((entry) => ({
			...entry,
			value:
				valueBase +
				entry.name +
				(entry.kind === "directory" ? "/" : ""),
		}));
}

export async function resolveBrowseDirectory(source: string): Promise<string> {
	if (!source.trim() || isRemoteTorrentSource(source)) return process.cwd();

	const path = expandTorrentPath(source);
	let candidate = dirname(path);

	try {
		if ((await stat(path)).isDirectory()) candidate = path;
	} catch {
		// A partial filename still uses its parent directory.
	}

	try {
		await readdir(candidate);
		return candidate;
	} catch {
		return process.cwd();
	}
}
