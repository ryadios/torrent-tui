import { describe, expect, test } from "bun:test";
import type { RemoteInfo } from "node:dgram";
import { DhtClient } from "../../src/torrent/dht/node.ts";
import {
	compactNodes,
	compactPeers,
	type DhtNode,
	decodeDhtMessage,
	encodeDhtResponse,
	nodeIdFromHex,
	parseCompactNodes,
	parseCompactPeers,
} from "../../src/torrent/dht/protocol.ts";
import { DhtRoutingTable } from "../../src/torrent/dht/routing.ts";

const OWN_ID = nodeIdFromHex("0000000000000000000000000000000000000001");
const BOOTSTRAP_ID = nodeIdFromHex("0000000000000000000000000000000000000002");
const INFO_HASH = nodeIdFromHex("1111111111111111111111111111111111111111");

describe("DHT protocol helpers", () => {
	test("encodes and parses compact peers and nodes", () => {
		const peers = [
			{ ip: "127.0.0.1", port: 6881 },
			{ ip: "10.0.0.2", port: 51413 },
		];
		expect(parseCompactPeers(compactPeers(peers))).toEqual(peers);

		const nodes: DhtNode[] = [
			{ id: BOOTSTRAP_ID, ip: "127.0.0.1", port: 6881 },
		];
		expect(parseCompactNodes(compactNodes(nodes))).toEqual(nodes);
	});

	test("decodes KRPC responses", () => {
		const tid = new Uint8Array([1, 2]);
		const response = decodeDhtMessage(
			encodeDhtResponse(tid, {
				id: BOOTSTRAP_ID,
				values: [compactPeers([{ ip: "127.0.0.9", port: 7000 }])],
			}),
		);

		expect(response.type).toBe("response");
		expect(response.transactionId).toEqual(tid);
		expect(response.response?.id).toEqual(BOOTSTRAP_ID);
	});
});

describe("DhtRoutingTable", () => {
	test("keeps bounded closest nodes", () => {
		const table = new DhtRoutingTable(OWN_ID);
		for (let i = 2; i < 100; i++) {
			const id = new Uint8Array(20);
			id[19] = i;
			table.add({ id, ip: `127.0.0.${i}`, port: 6000 + i });
		}

		expect(table.size).toBeLessThanOrEqual(256);
		expect(table.closest(INFO_HASH, 8)).toHaveLength(8);
	});
});

describe("DhtClient", () => {
	test("discovers peers through fake KRPC get_peers", async () => {
		const transport = new FakeDhtTransport();
		const client = new DhtClient({
			nodeId: OWN_ID,
			bootstrapNodes: [{ ip: "127.0.0.2", port: 6881 }],
			transport,
			persist: false,
		});

		transport.onSend = (data, port, host) => {
			const decoded = decodeDhtMessage(data);
			const tid = decoded.transactionId;
			if (decoded.query === "find_node") {
				transport.deliver(
					encodeDhtResponse(tid, {
						id: BOOTSTRAP_ID,
						nodes: compactNodes([{ id: BOOTSTRAP_ID, ip: host, port }]),
					}),
					host,
					port,
				);
			}
			if (decoded.query === "get_peers") {
				transport.deliver(
					encodeDhtResponse(tid, {
						id: BOOTSTRAP_ID,
						token: new Uint8Array([7]),
						values: [compactPeers([{ ip: "127.0.0.9", port: 7000 }])],
					}),
					host,
					port,
				);
			}
		};

		await client.start(0);
		const peers = await client.getPeers(INFO_HASH);

		expect(peers).toEqual([{ ip: "127.0.0.9", port: 7000 }]);
		client.close();
	});
});

class FakeDhtTransport {
	private cb: ((data: Uint8Array, rinfo: RemoteInfo) => void) | null = null;
	onSend: ((data: Uint8Array, port: number, host: string) => void) | null =
		null;

	async bind(port: number): Promise<number> {
		return port;
	}

	onMessage(cb: (data: Uint8Array, rinfo: RemoteInfo) => void): void {
		this.cb = cb;
	}

	async send(data: Uint8Array, port: number, host: string): Promise<void> {
		this.onSend?.(data, port, host);
	}

	close(): void {}

	deliver(data: Uint8Array, address: string, port: number): void {
		this.cb?.(data, {
			address,
			port,
			family: "IPv4",
			size: data.length,
		});
	}
}
