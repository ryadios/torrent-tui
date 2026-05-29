import { describe, expect, test } from "bun:test";
import { TrackerCoordinator } from "../../src/torrent/tracker/coordinator.ts";
import type {
	TrackerAnnounceRequest,
	TrackerResponse,
} from "../../src/torrent/types.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

describe("TrackerCoordinator", () => {
	test("starts immediately and reschedules using tracker intervals", async () => {
		const fixture = singleFileTorrentFixture({
			announceList: [["http://tracker-a.example/announce"]],
		});
		const scheduler = new FakeScheduler();
		const calls: TrackerAnnounceRequest[] = [];
		const coordinator = new TrackerCoordinator(fixture.metadata, {
			getSnapshot: () => ({ downloaded: 1, uploaded: 2, left: 3 }),
			scheduler,
			announceTracker: async (_url, _metadata, request) => {
				calls.push({ ...request });
				return {
					complete: 0,
					incomplete: 0,
					interval: 120,
					peers: [],
				};
			},
		});

		coordinator.start();
		await flush();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.event).toBe("started");

		scheduler.runNext();
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls[1]?.event).toBeUndefined();
		expect(scheduler.lastDelayMs).toBe(120_000);
	});

	test("retries failed trackers independently and merges peers from successes", async () => {
		const fixture = singleFileTorrentFixture({
			announceList: [
				["http://tracker-a.example/announce"],
				["udp://tracker-b.example:6969"],
			],
		});
		const scheduler = new FakeScheduler();
		const seenPeers: string[] = [];
		const callsByUrl = new Map<string, number>();
		const coordinator = new TrackerCoordinator(fixture.metadata, {
			getSnapshot: () => ({ downloaded: 0, uploaded: 0, left: fixture.metadata.totalSize }),
			scheduler,
			onPeers: (peers) => {
				for (const peer of peers) {
					seenPeers.push(`${peer.ip}:${peer.port}`);
				}
			},
			announceTracker: async (url) => {
				const count = (callsByUrl.get(url) ?? 0) + 1;
				callsByUrl.set(url, count);
				if (url.startsWith("http://")) {
					throw new Error("tracker down");
				}
				return {
					complete: 0,
					incomplete: 0,
					interval: 90,
					peers: [{ ip: "127.0.0.1", port: 6881 }],
				};
			},
		});

		coordinator.start();
		await flush();

		expect(callsByUrl.get("http://tracker-a.example/announce")).toBe(1);
		expect(callsByUrl.get("udp://tracker-b.example:6969")).toBe(1);
		expect(seenPeers).toEqual(["127.0.0.1:6881"]);
		expect(scheduler.delays()).toEqual([15_000, 90_000]);
	});

	test("sends completed once and stopped on shutdown", async () => {
		const fixture = singleFileTorrentFixture({
			announceList: [["http://tracker-a.example/announce"]],
		});
		const scheduler = new FakeScheduler();
		const events: Array<string | undefined> = [];
		const coordinator = new TrackerCoordinator(fixture.metadata, {
			getSnapshot: () => ({ downloaded: 5, uploaded: 6, left: 0 }),
			scheduler,
			announceTracker: async (_url, _metadata, request) => {
				events.push(request.event);
				return {
					complete: 0,
					incomplete: 0,
					interval: 60,
					peers: [],
				};
			},
		});

		coordinator.start();
		await flush();
		coordinator.markCompleted();
		await flush();
		coordinator.markCompleted();
		await flush();
		await coordinator.stop();

		expect(events).toEqual(["started", "completed", "stopped"]);
	});
});

class FakeScheduler {
	private readonly timers: Array<{ delayMs: number; fn: () => void }> = [];
	lastDelayMs = 0;

	setTimeout(fn: () => void, delayMs: number): object {
		this.lastDelayMs = delayMs;
		const timer = { delayMs, fn };
		this.timers.push(timer);
		return timer;
	}

	clearTimeout(handle: unknown): void {
		const index = this.timers.indexOf(handle as { delayMs: number; fn: () => void });
		if (index >= 0) this.timers.splice(index, 1);
	}

	runNext(): void {
		const next = this.timers.shift();
		next?.fn();
	}

	delays(): number[] {
		return this.timers.map((timer) => timer.delayMs).sort((a, b) => a - b);
	}
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
