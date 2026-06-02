import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { DhtClient } from "../../src/torrent/dht/node.ts";
import { DiscoveryCoordinator } from "../../src/torrent/discovery/coordinator.ts";
import type { PeerManager } from "../../src/torrent/peer/manager.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

describe("DiscoveryCoordinator", () => {
	test("does not start DHT for private torrents", async () => {
		const fixture = singleFileTorrentFixture({ private: true });
		const dht = new FakeDiscoveryDht();
		const coordinator = new DiscoveryCoordinator(
			fixture.metadata,
			new FakeDiscoveryPeerManager().asManager(),
			{
				dht: dht as unknown as DhtClient,
				getSnapshot: () => ({ downloaded: 0, uploaded: 0, left: 1 }),
				onPeers: () => {},
				announceTracker: async () => ({
					complete: 0,
					incomplete: 0,
					interval: 60,
					peers: [],
				}),
			},
		);

		await coordinator.start();
		await coordinator.stop();

		expect(dht.started).toBe(false);
	});

	test("does not refresh DHT when startup fails", async () => {
		const fixture = singleFileTorrentFixture();
		const dht = new FailingDiscoveryDht();
		const coordinator = new DiscoveryCoordinator(
			fixture.metadata,
			new FakeDiscoveryPeerManager().asManager(),
			{
				dht: dht as unknown as DhtClient,
				getSnapshot: () => ({ downloaded: 0, uploaded: 0, left: 1 }),
				onPeers: () => {},
				announceTracker: async () => ({
					complete: 0,
					incomplete: 0,
					interval: 60,
					peers: [],
				}),
			},
		);

		await coordinator.start();
		coordinator.refreshNow();
		await coordinator.stop();

		expect(dht.getPeerCalls).toBe(0);
	});
});

class FakeDiscoveryDht {
	started = false;

	async start(): Promise<void> {
		this.started = true;
	}
}

class FailingDiscoveryDht {
	getPeerCalls = 0;
	readonly routingTable = {
		add: () => {},
	};

	async start(): Promise<void> {
		throw new Error("bind failed");
	}

	async getPeers(): Promise<[]> {
		this.getPeerCalls++;
		return [];
	}

	close(): void {}
}

class FakeDiscoveryPeerManager extends EventEmitter {
	readonly connections = new Map();

	listenPort(): number {
		return 6881;
	}

	asManager(): PeerManager {
		return this as unknown as PeerManager;
	}
}
