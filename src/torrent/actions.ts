import type { TransmissionClient } from "../transmission/client";
import type { TorrentList } from "../transmission/types/torrent";

async function startTorrent(
	client: TransmissionClient,
	torrentHash: string,
): Promise<TorrentList> {
	await client.startTorrent(torrentHash);
	return client.listTorrents();
}

async function stopTorrent(
	client: TransmissionClient,
	torrentHash: string,
): Promise<TorrentList> {
	await client.stopTorrent(torrentHash);
	return client.listTorrents();
}

async function addTorrent(
	client: TransmissionClient,
	source: string,
): Promise<TorrentList> {
	await client.addTorrent(source);
	return client.listTorrents();
}

async function removeTorrent(
	client: TransmissionClient,
	torrentHash: string,
): Promise<TorrentList> {
	await client.removeTorrent(torrentHash);
	return client.listTorrents();
}

export { addTorrent, removeTorrent, startTorrent, stopTorrent };
