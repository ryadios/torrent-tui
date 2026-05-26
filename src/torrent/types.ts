export interface PeerInfo {
	ip: string;
	port: number;
}

export interface TrackerResponse {
	complete: number;
	incomplete: number;
	interval: number;
	peers: PeerInfo[];
}

export interface FileInfo {
	path: string;
	length: number;
	offset: number; // byte offset in the flat concatenated stream
}

export type TorrentStatus =
	| "created"
	| "verifying"
	| "ready"
	| "downloading"
	| "seeding"
	| "stopped";
