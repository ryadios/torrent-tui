import { describe, expect, test } from "bun:test";
import {
	buildLsdAnnounce,
	parseLsdAnnounce,
} from "../../src/torrent/discovery/lsd.ts";

describe("BEP 14 LSD", () => {
	test("builds and parses local peer discovery announces", () => {
		const message = buildLsdAnnounce({
			cookie: "abc123",
			host: "239.192.152.143",
			infoHashHex: "0123456789abcdef0123456789abcdef01234567",
			port: 6881,
		});

		expect(parseLsdAnnounce(message.toString("utf-8"))).toEqual({
			cookie: "abc123",
			host: "239.192.152.143",
			infoHashHex: "0123456789abcdef0123456789abcdef01234567",
			port: 6881,
		});
	});

	test("rejects malformed LSD announces", () => {
		expect(parseLsdAnnounce("GET / HTTP/1.1\r\n\r\n")).toBeNull();
		expect(
			parseLsdAnnounce(
				"BT-SEARCH * HTTP/1.1\r\nInfohash: nope\r\nPort: 6881\r\n\r\n",
			),
		).toBeNull();
	});
});
