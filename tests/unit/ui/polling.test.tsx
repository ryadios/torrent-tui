import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { TorrentOperations } from "../../../src/torrent/actions";
import type {
	TorrentList,
	TorrentSummary,
} from "../../../src/transmission/types/torrent";
import { App } from "../../../src/ui/app";
import { theme } from "../../../src/ui/theme";
import { useTorrentPolling } from "../../../src/ui/use-torrent-polling";

const operations: TorrentOperations = {
	listTorrents: () => new Promise(() => {}),
	addTorrent: async () => ({
		torrent_added: {
			id: 1,
			hash_string: "abc123",
			name: "example.torrent",
		},
	}),
	startTorrent: async () => {},
	stopTorrent: async () => {},
	removeTorrent: async () => {},
};

function withListRequest(
	listTorrents: TorrentOperations["listTorrents"],
): TorrentOperations {
	return { ...operations, listTorrents };
}

function torrent(hash: string, name: string): TorrentSummary {
	return {
		id: 1,
		hash_string: hash,
		name,
		status: 4,
		percent_done: 0.5,
		rate_download: 0,
		rate_upload: 0,
		eta: 0,
		total_size: 1,
		is_finished: false,
		error: 0,
		error_string: "",
	};
}

function interceptInterval() {
	let callback: Bun.TimerHandler | undefined;
	let delay: number | undefined;
	const handle = {} as Timer;
	const timerApi = globalThis as {
		setInterval: (handler: Bun.TimerHandler, timeout?: number) => Timer;
		clearInterval: (handle?: Timer) => void;
	};
	const setIntervalSpy = spyOn(timerApi, "setInterval");
	const clearIntervalSpy = spyOn(timerApi, "clearInterval");

	setIntervalSpy.mockImplementation((handler, timeout) => {
		callback = handler;
		delay = timeout;
		return handle;
	});
	clearIntervalSpy.mockImplementation(() => {});

	return {
		delay: () => delay,
		handle,
		tick: () => callback?.(),
		setIntervalSpy,
		clearIntervalSpy,
	};
}

function PollingProbe({
	enabled,
	onTick,
}: {
	enabled: boolean;
	onTick: () => void;
}) {
	useTorrentPolling({ enabled, onTick });
	return <text>probe</text>;
}

afterEach(() => {
	mock.restore();
});

describe("useTorrentPolling", () => {
	test("does not schedule while disabled", async () => {
		const interval = interceptInterval();
		const setup = await testRender(
			<PollingProbe enabled={false} onTick={() => {}} />,
			{ width: 20, height: 4 },
		);

		try {
			await setup.renderOnce();
			expect(interval.setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("schedules a two-second tick, calls it, and cleans it up", async () => {
		const interval = interceptInterval();
		const onTick = mock(() => {});
		const setup = await testRender(
			<PollingProbe enabled onTick={onTick} />,
			{ width: 20, height: 4 },
		);

		try {
			await setup.renderOnce();
			expect(interval.setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(interval.delay()).toBe(2_000);

			act(() => interval.tick());
			expect(onTick).toHaveBeenCalledTimes(1);
		} finally {
			act(() => setup.renderer.destroy());
		}

		expect(interval.clearIntervalSpy).toHaveBeenCalledWith(interval.handle);
	});
});

describe("App polling", () => {
	test("updates rows silently, preserves selection, and skips overlapping polls", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const poll = Promise.withResolvers<TorrentList>();
		const interval = interceptInterval();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					if (listCalls === 1) return initial.promise;
					return poll.promise;
				})}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 10 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				initial.resolve({
					torrents: [
						torrent("hash-1", "First torrent"),
						torrent("hash-2", "Second torrent"),
					],
				});
				await initial.promise;
			});
			await setup.renderOnce();

			expect(interval.setIntervalSpy).toHaveBeenCalledTimes(1);
			act(() => setup.mockInput.pressArrow("down"));
			await setup.renderOnce();

			act(() => interval.tick());
			await setup.renderOnce();
			act(() => interval.tick());
			await setup.renderOnce();

			expect(listCalls).toBe(2);
			expect(setup.captureCharFrame()).not.toContain("Refreshing…");

			await act(async () => {
				poll.resolve({
					torrents: [
						torrent("hash-2", "Updated second torrent"),
						torrent("hash-1", "First torrent"),
					],
				});
				await poll.promise;
			});
			await setup.renderOnce();

			const selectedLine = setup
				.captureSpans()
				.lines.find((line) =>
					line.spans.some((span) =>
						span.text.includes("Updated second torrent"),
					),
				);
			expect(
				selectedLine?.spans.some(
					(span) =>
						span.text.includes("│") &&
						span.fg.equals(RGBA.fromHex(theme.primary)),
				),
			).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("discovers rows while the add dialog remains open", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const poll = Promise.withResolvers<TorrentList>();
		const interval = interceptInterval();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					return listCalls === 1 ? initial.promise : poll.promise;
				})}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 16 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				initial.resolve({ torrents: [] });
				await initial.promise;
			});
			await setup.renderOnce();

			act(() => setup.mockInput.pressKey("a"));
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Add torrent");

			act(() => interval.tick());
			await setup.renderOnce();
			expect(listCalls).toBe(2);

			await act(async () => {
				poll.resolve({ torrents: [torrent("hash-1", "Found")] });
				await poll.promise;
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			expect(frame).toContain("Add torrent");
			expect(frame).toContain("Found");
			expect(frame).not.toContain("No torrents");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("shows one warning per failure streak and warns again after success", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const failureOne = Promise.withResolvers<TorrentList>();
		const failureTwo = Promise.withResolvers<TorrentList>();
		const success = Promise.withResolvers<TorrentList>();
		const failureAfterSuccess = Promise.withResolvers<TorrentList>();
		const interval = interceptInterval();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					if (listCalls === 1) return initial.promise;
					if (listCalls === 2) return failureOne.promise;
					if (listCalls === 3) return failureTwo.promise;
					if (listCalls === 4) return success.promise;
					return failureAfterSuccess.promise;
				})}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 10 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				initial.resolve({
					torrents: [torrent("hash-1", "Existing torrent")],
				});
				await initial.promise;
			});
			await setup.renderOnce();

			act(() => interval.tick());
			await setup.renderOnce();
			await act(async () => {
				failureOne.reject(new Error("first failure"));
				await failureOne.promise.catch(() => {});
			});
			await setup.renderOnce();

			const warning = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes("Refresh failed"));
			expect(warning?.fg.equals(RGBA.fromHex(theme.warning))).toBe(true);

			act(() => interval.tick());
			await setup.renderOnce();
			await act(async () => {
				failureTwo.reject(new Error("second failure"));
				await failureTwo.promise.catch(() => {});
			});
			await setup.renderOnce();
			expect(
				setup.captureCharFrame().match(/Refresh failed/g)?.length,
			).toBe(1);

			act(() => interval.tick());
			await setup.renderOnce();
			await act(async () => {
				success.resolve({
					torrents: [torrent("hash-1", "Updated torrent")],
				});
				await success.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).not.toContain("Refresh failed");

			act(() => interval.tick());
			await setup.renderOnce();
			await act(async () => {
				failureAfterSuccess.reject(new Error("third failure"));
				await failureAfterSuccess.promise.catch(() => {});
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Refresh failed");
			expect(listCalls).toBe(5);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
