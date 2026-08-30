import { afterEach, describe, expect, test } from "bun:test";

import { TransmissionClient } from "../../../src/transmission/client";

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

type RpcRequestBody = {
	method?: string;
	params?: unknown;
};

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init.headers,
		},
	});
}

function stubFetch(responses: Response[]): RecordedRequest[] {
	const requests: RecordedRequest[] = [];

	globalThis.fetch = (async (input, init) => {
		requests.push({ url: String(input), init });

		const response = responses.shift();
		if (!response) {
			throw new Error("Test fetch response queue exhausted");
		}

		return response;
	}) as typeof fetch;

	return requests;
}

function requestBody(request: RecordedRequest): RpcRequestBody {
	return JSON.parse(String(request.init?.body)) as RpcRequestBody;
}

function requestAt(
	requests: RecordedRequest[],
	index: number,
): RecordedRequest {
	const request = requests[index];
	if (!request) {
		throw new Error(`Expected a recorded request at index ${index}`);
	}

	return request;
}

function expectRpcRequest(
	request: RecordedRequest,
	method: string,
	params: Record<string, unknown>,
): void {
	const body = requestBody(request);

	expect(body.method).toBe(method);
	expect(body.params).toEqual(params);
}

function sessionHeader(request: RecordedRequest): string | null {
	return new Headers(request.init?.headers).get("X-Transmission-Session-Id");
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("TransmissionClient operations", () => {
	test("gets session information from the default RPC endpoint", async () => {
		const sessionInfo = {
			version: "4.0.6",
			rpc_version_semver: "17.0.0",
			download_dir: "/downloads",
			peer_port: 51413,
		};
		const requests = stubFetch([jsonResponse({ result: sessionInfo })]);

		const result = await new TransmissionClient().getSession();

		expect(result).toEqual(sessionInfo);
		expect(requests).toHaveLength(1);
		expect(requestAt(requests, 0).url).toBe(
			"http://127.0.0.1:9091/transmission/rpc",
		);
		expectRpcRequest(requestAt(requests, 0), "session_get", {
			fields: [
				"version",
				"rpc_version_semver",
				"download_dir",
				"peer_port",
			],
		});
	});

	test("lists torrents with the fields needed by the client", async () => {
		const torrentList = {
			torrents: [
				{
					id: 1,
					hash_string: "abc123",
					name: "example.iso",
					status: 4,
					percent_done: 0.5,
					rate_download: 1024,
					rate_upload: 256,
					eta: 60,
					total_size: 2048,
					is_finished: false,
					error: 0,
					error_string: "",
				},
			],
		};
		const requests = stubFetch([jsonResponse({ result: torrentList })]);

		const result = await new TransmissionClient().listTorrents();

		expect(result).toEqual(torrentList);
		expectRpcRequest(requestAt(requests, 0), "torrent_get", {
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
	});

	test("adds a torrent paused and returns the server result", async () => {
		const addResult = {
			torrent_added: {
				id: 1,
				hash_string: "abc123",
				name: "example.iso",
			},
		};
		const requests = stubFetch([jsonResponse({ result: addResult })]);

		const result = await new TransmissionClient().addTorrent(
			"/tmp/example.torrent",
		);

		expect(result).toEqual(addResult);
		expectRpcRequest(requestAt(requests, 0), "torrent_add", {
			filename: "/tmp/example.torrent",
			paused: true,
		});
	});

	test("starts a torrent by hash", async () => {
		const requests = stubFetch([jsonResponse({ result: {} })]);

		const result = await new TransmissionClient().startTorrent("abc123");

		expect(result).toBeUndefined();
		expectRpcRequest(requestAt(requests, 0), "torrent_start", {
			ids: ["abc123"],
		});
	});

	test("stops a torrent by hash", async () => {
		const requests = stubFetch([jsonResponse({ result: {} })]);

		const result = await new TransmissionClient().stopTorrent("abc123");

		expect(result).toBeUndefined();
		expectRpcRequest(requestAt(requests, 0), "torrent_stop", {
			ids: ["abc123"],
		});
	});

	test("removes a torrent without deleting local data", async () => {
		const requests = stubFetch([jsonResponse({ result: {} })]);

		const result = await new TransmissionClient().removeTorrent("abc123");

		expect(result).toBeUndefined();
		expectRpcRequest(requestAt(requests, 0), "torrent_remove", {
			ids: ["abc123"],
			delete_local_data: false,
		});
	});
});

describe("TransmissionClient session negotiation", () => {
	test("retries after 409 and reuses the session ID", async () => {
		const sessionId = "session-token";
		const sessionInfo = {
			version: "4.0.6",
			rpc_version_semver: "17.0.0",
			download_dir: "/downloads",
			peer_port: 51413,
		};
		const requests = stubFetch([
			new Response(null, {
				status: 409,
				headers: { "X-Transmission-Session-Id": sessionId },
			}),
			jsonResponse({ result: sessionInfo }),
			jsonResponse({ result: sessionInfo }),
		]);
		const client = new TransmissionClient();

		await expect(client.getSession()).resolves.toEqual(sessionInfo);
		await expect(client.getSession()).resolves.toEqual(sessionInfo);

		expect(requests).toHaveLength(3);
		expect(sessionHeader(requestAt(requests, 0))).toBeNull();
		expect(sessionHeader(requestAt(requests, 1))).toBe(sessionId);
		expect(sessionHeader(requestAt(requests, 2))).toBe(sessionId);
	});

	test("rejects a 409 response without a session ID", async () => {
		const requests = stubFetch([new Response(null, { status: 409 })]);

		await expect(new TransmissionClient().getSession()).rejects.toThrow(
			"missing session ID",
		);

		expect(requests).toHaveLength(1);
	});
});

describe("TransmissionClient response failures", () => {
	test("rejects a non-successful HTTP response", async () => {
		stubFetch([new Response(null, { status: 503 })]);

		await expect(new TransmissionClient().getSession()).rejects.toThrow(
			"HTTP 503",
		);
	});

	test("rejects a response with invalid JSON", async () => {
		stubFetch([new Response("not-json")]);

		await expect(new TransmissionClient().getSession()).rejects.toThrow(
			"invalid JSON response",
		);
	});

	test("rejects a response whose JSON body is not an object", async () => {
		stubFetch([jsonResponse(null)]);

		await expect(new TransmissionClient().getSession()).rejects.toThrow(
			"invalid JSON response",
		);
	});

	test("surfaces an RPC error returned by Transmission", async () => {
		stubFetch([
			jsonResponse({
				error: { data: { error_string: "torrent unavailable" } },
			}),
		]);

		await expect(new TransmissionClient().getSession()).rejects.toThrow(
			"torrent unavailable",
		);
	});

	test("rejects a response without a result", async () => {
		stubFetch([jsonResponse({})]);

		await expect(new TransmissionClient().getSession()).rejects.toThrow(
			"response has no result",
		);
	});
});
