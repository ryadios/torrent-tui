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
	upload_ratio: number;
	peers_connected: number;
	is_finished: boolean;
	error: number;
	error_string: string;
};

export type TorrentList = {
	torrents: TorrentSummary[];
};

export type TorrentFile = {
	name: string;
	length: number;
	bytes_completed: number;
};

export type TorrentDetails = Pick<
	TorrentSummary,
	"hash_string" | "name" | "upload_ratio" | "peers_connected"
> & {
	download_dir: string;
	downloaded_ever: number;
	uploaded_ever: number;
	is_private: boolean;
	metadata_percent_complete: number;
	files?: TorrentFile[];
};

export type TorrentReference = {
	id: number;
	hash_string: string;
	name: string;
};

export type TorrentAddResult =
	| { torrent_added: TorrentReference }
	| { torrent_duplicate: TorrentReference };

export type TorrentAddSource = { filename: string } | { metainfo: string };
