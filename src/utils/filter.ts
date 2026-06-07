import type { TorrentState } from "../store";

const ACTIVE_STATUSES = new Set<TorrentState["status"]>([
	"queued",
	"metadata",
	"checking",
	"connecting",
	"downloading",
	"stalled",
]);

export interface TorrentFilterOptions {
	searchQuery?: string;
	view?: string;
}

export function filterTorrents(
	torrents: TorrentState[],
	viewOrOptions: string | TorrentFilterOptions,
): TorrentState[] {
	const options =
		typeof viewOrOptions === "string" ? { view: viewOrOptions } : viewOrOptions;
	const view = options.view ?? "All";
	const query = (options.searchQuery ?? "").trim().toLowerCase();
	let result: TorrentState[];
	switch (view) {
		case "Downloading":
			result = torrents.filter((t) => ACTIVE_STATUSES.has(t.status));
			break;
		case "Seeding":
		case "Completed":
			result = torrents.filter((t) => t.status === "seeding");
			break;
		case "Paused":
			result = torrents.filter((t) => t.status === "paused");
			break;
		case "Stopped":
			result = torrents.filter(
				(t) =>
					t.status === "stopped" ||
					t.status === "error" ||
					t.status === "missing",
			);
			break;
		default:
			result = torrents;
	}

	if (query.length > 0) {
		result = result.filter((t) => t.name.toLowerCase().includes(query));
	}

	return result;
}
