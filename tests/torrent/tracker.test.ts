import { describe, expect, test } from "bun:test";
import { encode } from "../../src/torrent/parser.ts";
import {
	buildHTTPTrackerUrl,
	parseHTTPCompactPeers,
	parseHTTPDictionaryPeers,
	parseHTTPTrackerResponse,
} from "../../src/torrent/tracker/http-tracker.ts";
import {
	parseUDPAnnounceResponse,
	parseUDPCompactPeers,
	trackerEventCode,
} from "../../src/torrent/tracker/udp-tracker.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

describe("HTTP tracker response parsing", () => {
	test("parses compact IPv4 peers", () => {
		const peers = parseHTTPCompactPeers(
			new Uint8Array([127, 0, 0, 1, 0x1a, 0xe1, 10, 0, 0, 2, 0x1a, 0xe2]),
		);

		expect(peers).toEqual([
			{ ip: "127.0.0.1", port: 6881 },
			{ ip: "10.0.0.2", port: 6882 },
		]);
	});

	test("parses dictionary peer lists", () => {
		expect(
			parseHTTPDictionaryPeers([
				{ ip: "192.168.1.2", port: 51413 },
				{ ip: new TextEncoder().encode("2001:db8::1"), port: 6000 },
				{ ip: "missing-port" },
			]),
		).toEqual([
			{ ip: "192.168.1.2", port: 51413 },
			{ ip: "2001:db8::1", port: 6000 },
		]);
	});

	test("parses full tracker responses", () => {
		const response = encode({
			interval: 1800,
			complete: 4,
			incomplete: 9,
			peers: new Uint8Array([1, 2, 3, 4, 0x1a, 0xe1]),
		});

		expect(parseHTTPTrackerResponse(response)).toEqual({
			complete: 4,
			incomplete: 9,
			interval: 1800,
			peers: [{ ip: "1.2.3.4", port: 6881 }],
		});
	});

	test("throws tracker failures and ignores malformed compact payloads", () => {
		expect(() =>
			parseHTTPTrackerResponse(encode({ "failure reason": "bad torrent" })),
		).toThrow("Tracker failure: bad torrent");

		expect(parseHTTPCompactPeers(new Uint8Array([1, 2, 3]))).toEqual([]);
	});

	test("builds announce urls with optional lifecycle events", () => {
		const fixture = singleFileTorrentFixture();
		const url = buildHTTPTrackerUrl(
			"http://tracker.example/announce",
			fixture.metadata,
			{
				port: 6881,
				numwant: 25,
				uploaded: 12,
				downloaded: 34,
				left: 56,
				event: "completed",
				peerId: new Uint8Array(20).fill(1),
			},
		);

		expect(url).toContain("uploaded=12");
		expect(url).toContain("downloaded=34");
		expect(url).toContain("left=56");
		expect(url).toContain("numwant=25");
		expect(url).toContain("event=completed");
	});
});

describe("UDP tracker response parsing", () => {
	test("parses compact peers", () => {
		expect(
			parseUDPCompactPeers(
				new Uint8Array([8, 8, 8, 8, 0x1a, 0xe1, 9, 9, 9, 9, 0x1a, 0xe2]),
				0,
			),
		).toEqual([
			{ ip: "8.8.8.8", port: 6881 },
			{ ip: "9.9.9.9", port: 6882 },
		]);
	});

	test("parses announce responses", () => {
		const txId = 0x12345678;
		const response = buildAnnounceResponse(txId, [127, 0, 0, 1, 0x1a, 0xe1]);

		expect(parseUDPAnnounceResponse(response, txId)).toEqual({
			complete: 7,
			incomplete: 3,
			interval: 900,
			peers: [{ ip: "127.0.0.1", port: 6881 }],
		});
	});

	test("rejects malformed announce responses", () => {
		const txId = 0x12345678;
		const response = buildAnnounceResponse(txId, []);
		const badAction = response.slice();
		new DataView(
			badAction.buffer,
			badAction.byteOffset,
			badAction.byteLength,
		).setInt32(0, 2);

		expect(() => parseUDPAnnounceResponse(response.slice(0, 12), txId)).toThrow(
			"too short",
		);
		expect(() => parseUDPAnnounceResponse(badAction, txId)).toThrow(
			"bad announce action",
		);
		expect(() => parseUDPAnnounceResponse(response, 1)).toThrow(
			"announce txId mismatch",
		);
		expect(() => parseUDPCompactPeers(new Uint8Array([1, 2, 3]), 0)).toThrow(
			"Invalid UDP compact peer data",
		);
	});

	test("maps lifecycle events to UDP announce codes", () => {
		expect(trackerEventCode(undefined)).toBe(0);
		expect(trackerEventCode("completed")).toBe(1);
		expect(trackerEventCode("started")).toBe(2);
		expect(trackerEventCode("stopped")).toBe(3);
	});
});

function buildAnnounceResponse(txId: number, peerBytes: number[]): Uint8Array {
	const buf = new Uint8Array(20 + peerBytes.length);
	const view = new DataView(buf.buffer);
	view.setInt32(0, 1);
	view.setUint32(4, txId);
	view.setInt32(8, 900);
	view.setInt32(12, 3);
	view.setInt32(16, 7);
	buf.set(peerBytes, 20);
	return buf;
}
