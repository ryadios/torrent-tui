import type { TorrentState } from "../store";

const ACTIVE_STATUSES = new Set<TorrentState["status"]>([
	"queued",
	"checking",
	"connecting",
	"downloading",
	"stalled",
]);

export function filterTorrents(
	torrents: TorrentState[],
	view: string,
): TorrentState[] {
	switch (view) {
		case "Downloading":
			return torrents.filter((t) => ACTIVE_STATUSES.has(t.status));
		case "Seeding":
		case "Completed":
			return torrents.filter((t) => t.status === "seeding");
		case "Paused":
			return torrents.filter((t) => t.status === "paused");
		case "Stopped":
			return torrents.filter(
				(t) =>
					t.status === "stopped" ||
					t.status === "error" ||
					t.status === "missing",
			);
		default:
			return torrents;
	}
}
