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

export type TrackerEvent = "started" | "completed" | "stopped";

export interface TrackerAnnounceRequest {
	port: number;
	numwant: number;
	uploaded: number;
	downloaded: number;
	left: number;
	event?: TrackerEvent;
	peerId?: Uint8Array;
}

export interface TrackerAnnounceTarget {
	infoHash: Uint8Array;
	totalSize: number;
	announceList: string[][];
}

export interface FileInfo {
	path: string;
	length: number;
	offset: number; // byte offset in the flat concatenated stream
	padding?: boolean;
}

export type TorrentStatus =
	| "created"
	| "checking"
	| "ready"
	| "connecting"
	| "downloading"
	| "seeding"
	| "stalled"
	| "paused"
	| "error"
	| "stopped"
	| "missing";
