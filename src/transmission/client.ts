import type { SessionInfo } from "./types/session";
import type { TorrentAddResult, TorrentList } from "./types/torrent";

type TransmissionMethod =
	| "session_get"
	| "torrent_get"
	| "torrent_add"
	| "torrent_start"
	| "torrent_stop"
	| "torrent_remove";

type RpcResponse<Result> = {
	result?: Result;
	error?: {
		code?: number;
		message?: string;
		data?: {
			error_string?: string;
		};
	};
};

const DEFAULT_RPC_URL = "http://127.0.0.1:9091/transmission/rpc";

export class TransmissionClient {
	private readonly rpcUrl: string;
	private sessionId: string | undefined;

	constructor(rpcUrl = DEFAULT_RPC_URL) {
		this.rpcUrl = rpcUrl;
	}

	private async rpcCall<Result>(
		method: TransmissionMethod,
		params: Record<string, unknown> = {},
	): Promise<Result> {
		const payload = {
			jsonrpc: "2.0",
			method,
			params,
			id: 1,
		};

		const sendRequest = () =>
			fetch(this.rpcUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.sessionId
						? { "X-Transmission-Session-Id": this.sessionId }
						: {}),
				},
				body: JSON.stringify(payload),
			});

		let response = await sendRequest();

		if (response.status === 409) {
			const sessionId = response.headers.get("X-Transmission-Session-Id");

			if (!sessionId) {
				throw new Error(
					`Transmission ${method} failed: missing session ID`,
				);
			}

			this.sessionId = sessionId;
			response = await sendRequest();
		}

		if (!response.ok) {
			throw new Error(
				`Transmission ${method} failed: HTTP ${response.status}`,
			);
		}

		let rawBody: unknown;

		try {
			rawBody = await response.json();
		} catch {
			throw new Error(
				`Transmission ${method} failed: invalid JSON response`,
			);
		}

		if (!rawBody || typeof rawBody !== "object") {
			throw new Error(
				`Transmission ${method} failed: invalid JSON response`,
			);
		}

		const body = rawBody as RpcResponse<Result>;

		if (body.error) {
			throw new Error(
				`Transmission ${method} failed: ${
					body.error.data?.error_string ??
					body.error.message ??
					"RPC request failed"
				}`,
			);
		}

		if (!("result" in body)) {
			throw new Error(
				`Transmission ${method} failed: response has no result`,
			);
		}

		return body.result as Result;
	}

	getSession(): Promise<SessionInfo> {
		return this.rpcCall<SessionInfo>("session_get", {
			fields: [
				"version",
				"rpc_version_semver",
				"download_dir",
				"peer_port",
			],
		});
	}

	listTorrents(): Promise<TorrentList> {
		return this.rpcCall<TorrentList>("torrent_get", {
			fields: [
				"id",
				"hash_string",
				"name",
				"status",
				"percent_done",
				"rate_download",
				"rate_upload",
				"eta",
				"total_size",
				"is_finished",
				"error",
				"error_string",
			],
		});
	}

	addTorrent(source: string): Promise<TorrentAddResult> {
		return this.rpcCall<TorrentAddResult>("torrent_add", {
			filename: source,
			paused: true,
		});
	}

	async startTorrent(torrentHash: string): Promise<void> {
		await this.rpcCall("torrent_start", {
			ids: [torrentHash],
		});
	}

	async stopTorrent(torrentHash: string): Promise<void> {
		await this.rpcCall("torrent_stop", {
			ids: [torrentHash],
		});
	}

	async removeTorrent(torrentHash: string): Promise<void> {
		await this.rpcCall("torrent_remove", {
			ids: [torrentHash],
			delete_local_data: false, // default
		});
	}
}
