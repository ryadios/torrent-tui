import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { TorrentAddSource } from "../transmission/types/torrent";

const remoteSource = /^(?:magnet:|https?:|ftp:|sftp:)/i;

export function expandTorrentPath(source: string): string {
	if (source === "~") return homedir();

	if (source.startsWith("~/")) {
		return resolve(homedir(), source.slice(2));
	}

	return isAbsolute(source) ? source : resolve(process.cwd(), source);
}

export async function resolveTorrentSource(
	source: string,
): Promise<TorrentAddSource> {
	const value = source.trim();

	if (remoteSource.test(value)) {
		return { filename: value };
	}

	const path = expandTorrentPath(value);

	try {
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());

		return {
			metainfo: bytes.toBase64(),
		};
	} catch {
		return {
			filename: path,
		};
	}
}
