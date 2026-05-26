import type { TorrentState } from "../store";

export function filterTorrents(torrents: TorrentState[], view: string): TorrentState[] {
	switch (view) {
		case "Downloading": return torrents.filter((t) => t.status === "downloading");
		case "Seeding":
		case "Completed":   return torrents.filter((t) => t.status === "seeding");
		case "Paused":      return torrents.filter((t) => t.status === "paused");
		case "Stopped":     return torrents.filter((t) => t.status === "stopped" || t.status === "error");
		default:            return torrents;
	}
}
