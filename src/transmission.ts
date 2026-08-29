type TransmissionMethod =
	| "session_get"
	| "torrent_get"
	| "torrent_add"
	| "torrent_start"
	| "torrent_stop"
	| "torrent_remove";

async function rpcCall(
	method: TransmissionMethod,
	params?: Record<string, unknown>,
) {
	const url = "http://127.0.0.1:19091/transmission/rpc";

	const payload = {
		jsonrpc: "2.0",
		method,
		params,
		id: 1,
	};

	let res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (res.status == 409) {
		// Retry on 409 session response
		const sessionId = res.headers.get("X-Transmission-Session-Id");

		if (!sessionId) {
			throw new Error("Transmission returned 409 without a session ID");
		}

		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Transmission-Session-Id": sessionId,
			},
			body: JSON.stringify(payload),
		});
	}

	const body = (await res.json()) as {
		result?: unknown;
		error?: {
			message?: string;
			data?: { error_string?: string };
		};
	};

	if (body.error) {
		throw new Error(
			body.error.data?.error_string ??
				body.error.message ??
				"Transmission RPC request failed",
		);
	}

	return body.result;
}

export function getSession() {
	return rpcCall("session_get", {
		fields: ["version", "rpc_version_semver", "download_dir", "peer_port"],
	});
}

export function listTorrents() {
	return rpcCall("torrent_get", {
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

export function addTorrent(filename: string) {
	return rpcCall("torrent_add", {
		filename,
		paused: true,
	});
}

export function startTorrent(hash: string) {
	return rpcCall("torrent_start", {
		ids: [hash],
	});
}

export function stopTorrent(hash: string) {
	return rpcCall("torrent_stop", {
		ids: [hash],
	});
}

export function removeTorrent(hash: string) {
	return rpcCall("torrent_remove", {
		ids: [hash],
		delete_local_data: false, // default
	});
}
