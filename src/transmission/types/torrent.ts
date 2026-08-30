export type TorrentSummary = {
	id: number;
	hash_string: string;
	name: string;
	status: number;
	percent_done: number;
	rate_download: number;
	rate_upload: number;
	eta: number;
	total_size: number;
	is_finished: boolean;
	error: number;
	error_string: string;
};

export type TorrentList = {
	torrents: TorrentSummary[];
};

export type TorrentReference = {
	id: number;
	hash_string: string;
	name: string;
};

export type TorrentAddResult =
	| { torrent_added: TorrentReference }
	| { torrent_duplicate: TorrentReference };
