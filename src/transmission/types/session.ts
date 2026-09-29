export type SessionInfo = {
	version: string;
	rpc_version_semver: string;
	download_dir: string;
	peer_port: number;
};

export type SessionStats = {
	download_speed: number;
	upload_speed: number;
};
