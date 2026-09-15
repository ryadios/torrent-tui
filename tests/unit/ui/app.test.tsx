import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import packageJson from "../../../package.json" with { type: "json" };
import type { TorrentOperations } from "../../../src/torrent/actions";
import type {
	TorrentList,
	TorrentSummary,
} from "../../../src/transmission/types/torrent";
import { App } from "../../../src/ui/app";
import { theme } from "../../../src/ui/theme";

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

describe("App", () => {
	test("renders the normal shell", async () => {
		const setup = await testRender(
			<App operations={operations} onQuit={() => {}} />,
			{
				width: 80,
				height: 8,
			},
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			const titleLine = frame
				.split("\n")
				.find((line) => line.includes("List"));

			expect(frame).toContain("torrent-tui");
			expect(frame).toContain(`v${packageJson.version}`);
			expect(frame).toContain("( o.o )");
			expect(frame).toContain("Loading torrents...");
			expect(frame).toContain("r refresh");
			expect(frame).toContain("q quit");
			expect(frame).not.toContain("^c");
			expect(titleLine?.startsWith(" ┌")).toBe(true);
			expect(titleLine).toContain(" List ──┐");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("renders opaque application and dialog surfaces", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 80, height: 16 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({ torrents: [] });
				await request.promise;
			});
			await setup.renderOnce();

			const shellTitle = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes("torrent-tui"));
			expect(shellTitle?.bg.equals(RGBA.fromHex(theme.background))).toBe(
				true,
			);

			act(() => setup.mockInput.pressKey("a"));
			await setup.renderOnce();

			const dialogTitle = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes("Add torrent"));
			expect(
				dialogTitle?.bg.equals(RGBA.fromHex(theme.backgroundPanel)),
			).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("shows structured add-dialog hints", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 24 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({ torrents: [] });
				await request.promise;
			});
			await setup.renderOnce();
			act(() => setup.mockInput.pressKey("a"));
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			expect(frame).toContain("Tab browse");
			expect(frame).toContain("Enter add");
			expect(frame).toContain("Esc close");
			const addSpans = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans);
			expect(
				addSpans
					.find((span) => span.text === "Tab")
					?.fg.equals(RGBA.fromHex(theme.primary)),
			).toBe(true);
			expect(
				addSpans
					.find((span) => span.text === " browse")
					?.fg.equals(RGBA.fromHex(theme.textMuted)),
			).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("refreshes once while preserving rows and selection by hash", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const refresh = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					return listCalls === 1 ? initial.promise : refresh.promise;
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
			act(() => setup.mockInput.pressArrow("down"));
			await setup.renderOnce();
			act(() => {
				setup.mockInput.pressKey("r");
				setup.mockInput.pressKey("r");
			});
			await setup.renderOnce();

			expect(listCalls).toBe(2);
			expect(setup.captureCharFrame()).toContain("First torrent");
			expect(setup.captureCharFrame()).toContain("Refreshing…");
			expect(setup.captureCharFrame()).toContain("r refresh");

			await act(async () => {
				refresh.resolve({
					torrents: [
						torrent("hash-2", "Second torrent"),
						torrent("hash-1", "First torrent"),
					],
				});
				await refresh.promise;
			});
			await setup.renderOnce();

			const selectedLine = setup
				.captureSpans()
				.lines.find((line) =>
					line.spans.some((span) =>
						span.text.includes("Second torrent"),
					),
				);
			expect(
				selectedLine?.spans.some(
					(span) =>
						span.text.includes("│") &&
						span.fg.equals(RGBA.fromHex(theme.primary)),
				),
			).toBe(true);
			expect(setup.captureCharFrame()).not.toContain("Refreshing…");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("starts the selected torrent once while navigation and quit remain available", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const mutation = Promise.withResolvers<void>();
		const refresh = Promise.withResolvers<TorrentList>();
		const startedHashes: string[] = [];
		let stopCalls = 0;
		let listCalls = 0;
		let quitCalls = 0;
		const setup = await testRender(
			<App
				operations={{
					...operations,
					listTorrents: () => {
						listCalls += 1;
						return listCalls === 1
							? initial.promise
							: refresh.promise;
					},
					startTorrent: (hash) => {
						startedHashes.push(hash);
						return mutation.promise;
					},
					stopTorrent: async () => {
						stopCalls += 1;
					},
				}}
				onQuit={() => {
					quitCalls += 1;
				}}
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
			expect(setup.captureCharFrame()).toContain("s start  p stop");

			act(() => {
				setup.mockInput.pressArrow("down");
				setup.mockInput.pressKey("s");
				setup.mockInput.pressKey("s");
				setup.mockInput.pressKey("p");
				setup.mockInput.pressKey("r");
				setup.mockInput.pressArrow("up");
				setup.mockInput.pressKey("q");
			});
			await setup.renderOnce();

			const busyFrame = setup.captureCharFrame();
			expect(startedHashes).toEqual(["hash-2"]);
			expect(stopCalls).toBe(0);
			expect(listCalls).toBe(1);
			expect(quitCalls).toBe(1);
			expect(busyFrame).toContain("Starting…");
			expect(busyFrame).toContain("s start  p stop");
			expect(busyFrame).toContain("r refresh");
			expect(busyFrame).toContain("q quit");
			expect(busyFrame).not.toContain("^c");

			await act(async () => {
				mutation.resolve();
				await mutation.promise;
				await Promise.resolve();
			});
			expect(listCalls).toBe(2);
			await act(async () => {
				refresh.resolve({
					torrents: [
						torrent("hash-2", "Second torrent"),
						torrent("hash-1", "First torrent"),
					],
				});
				await refresh.promise;
			});
			await setup.renderOnce();

			const selectedLine = setup
				.captureSpans()
				.lines.find((line) =>
					line.spans.some((span) =>
						span.text.includes("First torrent"),
					),
				);
			expect(
				selectedLine?.spans.some(
					(span) =>
						span.text.includes("│") &&
						span.fg.equals(RGBA.fromHex(theme.primary)),
				),
			).toBe(true);
			expect(setup.captureCharFrame()).not.toContain("Starting…");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("keeps rows and distinguishes mutation and refresh failures", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const stop = Promise.withResolvers<void>();
		const stoppedHashes: string[] = [];
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={{
					...operations,
					listTorrents: async () => {
						listCalls += 1;
						if (listCalls === 1) return initial.promise;
						throw new Error("refresh unavailable");
					},
					startTorrent: async () => {},
					stopTorrent: async (hash) => {
						stoppedHashes.push(hash);
						return stop.promise;
					},
				}}
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

			act(() => setup.mockInput.pressKey("p"));
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Stopping…");
			expect(setup.captureCharFrame()).toContain("s start  p stop");
			await act(async () => {
				stop.reject(new Error("mutation unavailable"));
				await stop.promise.catch(() => {});
			});
			await act(async () => {
				await Promise.resolve();
			});
			await setup.renderOnce();
			let spans = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans);
			expect(setup.captureCharFrame()).toContain("Existing torrent");
			expect(stoppedHashes).toEqual(["hash-1"]);
			expect(
				spans
					.find((span) => span.text.includes("Stop failed"))
					?.fg.equals(RGBA.fromHex(theme.error)),
			).toBe(true);

			act(() => setup.mockInput.pressKey("s"));
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});
			await setup.renderOnce();
			spans = setup.captureSpans().lines.flatMap((line) => line.spans);
			expect(setup.captureCharFrame()).toContain("Existing torrent");
			expect(
				spans
					.find((span) =>
						span.text.includes("Started · refresh failed"),
					)
					?.fg.equals(RGBA.fromHex(theme.warning)),
			).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("keeps operation failures until the next network operation", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const refresh = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={{
					...withListRequest(() => {
						listCalls += 1;
						return listCalls === 1
							? initial.promise
							: refresh.promise;
					}),
					stopTorrent: async () => {
						throw new Error("unavailable");
					},
				}}
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

			act(() => setup.mockInput.pressKey("p"));
			await act(async () => {
				await Promise.resolve();
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Stop failed");

			await act(async () => {
				await Promise.resolve();
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Stop failed");

			act(() => setup.mockInput.pressKey("r"));
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Refreshing…");
			expect(setup.captureCharFrame()).not.toContain("Stop failed");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("ignores modified network shortcuts", async () => {
		const request = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		let startCalls = 0;
		let stopCalls = 0;
		const setup = await testRender(
			<App
				operations={{
					...operations,
					listTorrents: () => {
						listCalls += 1;
						return request.promise;
					},
					startTorrent: async () => {
						startCalls += 1;
					},
					stopTorrent: async () => {
						stopCalls += 1;
					},
				}}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 10 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({
					torrents: [torrent("hash-1", "Existing torrent")],
				});
				await request.promise;
			});
			await setup.renderOnce();

			act(() => {
				setup.mockInput.pressKey("r", { ctrl: true });
				setup.mockInput.pressKey("s", { meta: true });
				setup.mockInput.pressKey("p", { shift: true });
			});

			expect(listCalls).toBe(1);
			expect(startCalls).toBe(0);
			expect(stopCalls).toBe(0);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("ignores repeated network shortcuts while allowing repeated navigation", async () => {
		const request = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		let startCalls = 0;
		let stopCalls = 0;
		const setup = await testRender(
			<App
				operations={{
					...operations,
					listTorrents: () => {
						listCalls += 1;
						return request.promise;
					},
					startTorrent: async () => {
						startCalls += 1;
					},
					stopTorrent: async () => {
						stopCalls += 1;
					},
				}}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 10 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({
					torrents: [
						torrent("hash-1", "First torrent"),
						torrent("hash-2", "Second torrent"),
						torrent("hash-3", "Third torrent"),
					],
				});
				await request.promise;
			});
			await setup.renderOnce();

			const repeat = (name: string) =>
				setup.renderer.keyInput.processParsedKey({
					name,
					ctrl: false,
					meta: false,
					shift: false,
					option: false,
					sequence: name,
					number: false,
					raw: name,
					eventType: "press",
					source: "kitty",
					repeated: true,
				});
			act(() => {
				repeat("r");
				repeat("s");
				repeat("p");
				repeat("j");
				repeat("j");
			});
			await setup.renderOnce();

			const selectedLine = setup
				.captureSpans()
				.lines.find((line) =>
					line.spans.some((span) =>
						span.text.includes("Third torrent"),
					),
				);
			expect(listCalls).toBe(1);
			expect(startCalls).toBe(0);
			expect(stopCalls).toBe(0);
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

	test("falls back to the first torrent and clears selection for an empty refresh", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const replacementRequest = Promise.withResolvers<TorrentList>();
		const emptyRequest = Promise.withResolvers<TorrentList>();
		const requests = [
			initial.promise,
			replacementRequest.promise,
			emptyRequest.promise,
		];
		const setup = await testRender(
			<App
				operations={withListRequest(() =>
					Promise.resolve(requests.shift() ?? { torrents: [] }),
				)}
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
			act(() => setup.mockInput.pressKey("END"));
			await setup.renderOnce();
			act(() => setup.mockInput.pressKey("r"));
			await setup.renderOnce();
			await act(async () => {
				replacementRequest.resolve({
					torrents: [torrent("hash-3", "Replacement torrent")],
				});
				await replacementRequest.promise;
			});
			await setup.renderOnce();

			const replacement = setup
				.captureSpans()
				.lines.find((line) =>
					line.spans.some((span) =>
						span.text.includes("Replacement torrent"),
					),
				);
			expect(
				replacement?.spans.some(
					(span) =>
						span.text.includes("│") &&
						span.fg.equals(RGBA.fromHex(theme.primary)),
				),
			).toBe(true);

			act(() => setup.mockInput.pressKey("r"));
			await setup.renderOnce();
			await act(async () => {
				emptyRequest.resolve({ torrents: [] });
				await emptyRequest.promise;
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("No torrents");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("keeps existing rows and reports a refresh failure", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const refresh = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					return listCalls === 1 ? initial.promise : refresh.promise;
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
			act(() => setup.mockInput.pressKey("r"));
			await setup.renderOnce();
			await act(async () => {
				refresh.reject(new Error("private transport detail"));
				await refresh.promise.catch(() => {});
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			const failure = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes("Refresh failed"));
			expect(frame).toContain("Existing torrent");
			expect(frame).toContain("Refresh failed");
			expect(frame).not.toContain("private transport detail");
			expect(failure?.fg.equals(RGBA.fromHex(theme.error))).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("retries an initial load failure with the refresh key", async () => {
		const initial = Promise.withResolvers<TorrentList>();
		const retry = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					return listCalls === 1 ? initial.promise : retry.promise;
				})}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 10 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				initial.reject(new Error("unavailable"));
				await initial.promise.catch(() => {});
			});
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain(
				"Unable to load torrents",
			);

			act(() => setup.mockInput.pressKey("r"));
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Loading torrents...");
			await act(async () => {
				retry.resolve({
					torrents: [torrent("hash-1", "Recovered torrent")],
				});
				await retry.promise;
			});
			await setup.renderOnce();

			expect(listCalls).toBe(2);
			expect(setup.captureCharFrame()).toContain("Recovered torrent");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("loads torrents once and selects the first row", async () => {
		const request = Promise.withResolvers<TorrentList>();
		let listCalls = 0;
		const setup = await testRender(
			<App
				operations={withListRequest(() => {
					listCalls += 1;
					return request.promise;
				})}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 10 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({
					torrents: [
						torrent("hash-1", "First torrent"),
						torrent("hash-2", "Second torrent"),
					],
				});
				await request.promise;
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			const captured = setup.captureSpans();
			const activeBorder = RGBA.fromHex(theme.primary);
			const firstLine = captured.lines.find((line) =>
				line.spans.some((span) => span.text.includes("First torrent")),
			);
			const secondLine = captured.lines.find((line) =>
				line.spans.some((span) => span.text.includes("Second torrent")),
			);

			expect(listCalls).toBe(1);
			expect(frame.indexOf("First torrent")).toBeLessThan(
				frame.indexOf("Second torrent"),
			);
			expect(
				firstLine?.spans.some(
					(span) =>
						span.text.includes("│") && span.fg.equals(activeBorder),
				),
			).toBe(true);
			expect(
				secondLine?.spans.some(
					(span) =>
						span.text.includes("│") && span.fg.equals(activeBorder),
				),
			).toBe(false);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("navigates torrent selection and clamps at the list boundaries", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 100, height: 8 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({
					torrents: [
						torrent("hash-1", "First torrent"),
						torrent("hash-2", "Second torrent"),
						torrent("hash-3", "Third torrent"),
					],
				});
				await request.promise;
			});

			const isSelected = (name: string) => {
				const line = setup
					.captureSpans()
					.lines.find((candidate) =>
						candidate.spans.some((span) =>
							span.text.includes(name),
						),
					);

				return line?.spans.some(
					(span) =>
						span.text.includes("│") &&
						span.fg.equals(RGBA.fromHex(theme.primary)),
				);
			};
			const press = async (key: string) => {
				act(() => {
					setup.mockInput.pressKey(key);
				});
				await setup.renderOnce();
			};
			const pressArrow = async (direction: "up" | "down") => {
				act(() => {
					setup.mockInput.pressArrow(direction);
				});
				await setup.renderOnce();
			};

			await pressArrow("down");
			expect(isSelected("Second torrent")).toBe(true);
			await press("j");
			expect(isSelected("Third torrent")).toBe(true);
			await pressArrow("down");
			expect(isSelected("Third torrent")).toBe(true);
			await press("HOME");
			expect(isSelected("First torrent")).toBe(true);
			await press("k");
			expect(isSelected("First torrent")).toBe(true);
			await press("END");
			expect(isSelected("Third torrent")).toBe(true);
			await pressArrow("up");
			expect(isSelected("Second torrent")).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("renders the empty state after loading", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 80, height: 8 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.resolve({ torrents: [] });
				await request.promise;
			});
			await setup.renderOnce();
			act(() => {
				setup.mockInput.pressArrow("down");
				setup.mockInput.pressKey("k");
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressKey("END");
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			expect(frame).toContain("No torrents");
			expect(frame).not.toContain("s start");
			expect(frame).not.toContain("p stop");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("shows a concise initial load error", async () => {
		const request = Promise.withResolvers<TorrentList>();
		const setup = await testRender(
			<App
				operations={withListRequest(() => request.promise)}
				onQuit={() => {}}
			/>,
			{ width: 80, height: 8 },
		);

		try {
			await setup.renderOnce();
			await act(async () => {
				request.reject(new Error("private transport detail"));
				await request.promise.catch(() => {});
			});
			await setup.renderOnce();

			const frame = setup.captureCharFrame();
			expect(frame).toContain("Unable to load torrents");
			expect(frame).not.toContain("private transport detail");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("hides the version in a medium terminal", async () => {
		const setup = await testRender(
			<App operations={operations} onQuit={() => {}} />,
			{ width: 59, height: 8 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("torrent-tui");
			expect(frame).not.toContain(`v${packageJson.version}`);
			expect(frame).toContain("r refresh");
			expect(frame).toContain("q quit");
			expect(frame).not.toContain("^c");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("keeps only the essential quit binding in a compact terminal", async () => {
		const setup = await testRender(
			<App operations={operations} onQuit={() => {}} />,
			{ width: 29, height: 8 },
		);

		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();

			expect(frame).toContain("torrent-tui");
			expect(frame).not.toContain(`v${packageJson.version}`);
			expect(frame).toContain("q quit");
			expect(frame).not.toContain("r refresh");
			expect(frame).not.toContain("^c");
		} finally {
			act(() => setup.renderer.destroy());
		}
	});

	test("calls onQuit only for plain q", async () => {
		let quitCalls = 0;
		const setup = await testRender(
			<App
				operations={operations}
				onQuit={() => {
					quitCalls += 1;
				}}
			/>,
			{ width: 40, height: 8 },
		);

		try {
			await setup.renderOnce();
			setup.mockInput.pressKey("q", { ctrl: true });
			setup.mockInput.pressKey("q", { meta: true });
			setup.mockInput.pressKey("q", { shift: true });
			expect(quitCalls).toBe(0);

			setup.mockInput.pressKey("q");

			expect(quitCalls).toBe(1);
		} finally {
			act(() => setup.renderer.destroy());
		}
	});
});
