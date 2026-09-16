import type { TransmissionClient } from "../transmission/client";
import type {
	TorrentAddResult,
	TorrentList,
} from "../transmission/types/torrent";
import { resolveTorrentSource } from "./source";

export type TorrentOperations = Pick<
	TransmissionClient,
	| "listTorrents"
	| "addTorrent"
	| "startTorrent"
	| "stopTorrent"
	| "removeTorrent"
>;

export type RefreshOutcome =
	| { status: "refreshed"; torrents: TorrentList }
	| { status: "refresh-failed"; error: Error };

export type AddTorrentOutcome = RefreshOutcome & {
	addResult: TorrentAddResult;
};

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

async function refreshTorrents(
	client: TorrentOperations,
): Promise<RefreshOutcome> {
	try {
		return { status: "refreshed", torrents: await client.listTorrents() };
	} catch (error) {
		return { status: "refresh-failed", error: toError(error) };
	}
}

export async function startTorrent(
	client: TorrentOperations,
	torrentHash: string,
): Promise<RefreshOutcome> {
	await client.startTorrent(torrentHash);
	return refreshTorrents(client);
}

export async function stopTorrent(
	client: TorrentOperations,
	torrentHash: string,
): Promise<RefreshOutcome> {
	await client.stopTorrent(torrentHash);
	return refreshTorrents(client);
}

export async function addTorrent(
	client: TorrentOperations,
	source: string,
): Promise<AddTorrentOutcome> {
	if (!source.trim()) throw new Error("Torrent source is required");

	const addResult = await client.addTorrent(
		await resolveTorrentSource(source),
	);
	return { ...(await refreshTorrents(client)), addResult };
}

export async function removeTorrent(
	client: TorrentOperations,
	torrentHash: string,
): Promise<RefreshOutcome> {
	await client.removeTorrent(torrentHash);
	return refreshTorrents(client);
}
