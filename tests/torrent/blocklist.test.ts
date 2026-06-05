import { describe, expect, test } from "bun:test";
import { Blocklist, parseBlocklist } from "../../src/torrent/blocklist.ts";
import { PeerManager } from "../../src/torrent/peer/manager.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

describe("Blocklist", () => {
	test("parses common single IP, range, P2P, DAT, and CIDR lines", () => {
		const blocklist = new Blocklist(
			parseBlocklist(`
# comment
192.0.2.10
198.51.100.1-198.51.100.10
bad range:203.0.113.20-203.0.113.30
010.000.000.001 - 010.000.000.255
172.16.4.0/24
`),
		);

		expect(blocklist.isBlocked({ ip: "192.0.2.10", port: 1 })).toBe(true);
		expect(blocklist.isBlocked({ ip: "198.51.100.8", port: 1 })).toBe(true);
		expect(blocklist.isBlocked({ ip: "203.0.113.25", port: 1 })).toBe(true);
		expect(blocklist.isBlocked({ ip: "10.0.0.44", port: 1 })).toBe(true);
		expect(blocklist.isBlocked({ ip: "172.16.4.200", port: 1 })).toBe(true);
		expect(blocklist.isBlocked({ ip: "172.16.5.1", port: 1 })).toBe(false);
	});

	test("PeerManager treats blocked peers as unavailable", () => {
		const fixture = singleFileTorrentFixture();
		const blocklist = new Blocklist(
			parseBlocklist("203.0.113.1-203.0.113.255"),
		);
		const manager = new PeerManager(fixture.metadata, 50, { blocklist });

		expect(manager.hasPeer({ ip: "203.0.113.9", port: 6881 })).toBe(true);
		expect(manager.isBlocked({ ip: "203.0.113.9", port: 6881 })).toBe(true);
		expect(manager.hasPeer({ ip: "198.51.100.9", port: 6881 })).toBe(false);
	});
});
