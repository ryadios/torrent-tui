import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
	startTorrent,
	stopTorrent,
	type TorrentOperations,
} from "../torrent/actions";
import type { TorrentSummary } from "../transmission/types/torrent";
import { Footer } from "./footer";
import { Frame } from "./frame";
import { keybinds } from "./keybinds";
import { theme } from "./theme";
import { TorrentList } from "./torrent-list";

type AppInnerProps = {
	operations: TorrentOperations;
};

type Activity =
	| { kind: "idle" }
	| { kind: "busy"; message: string }
	| { kind: "message"; message: string; tone: "error" | "warning" };

type ListState =
	| { status: "loading" }
	| {
			status: "loaded";
			torrents: TorrentSummary[];
			selectedHash?: string;
			activity: Activity;
	  }
	| { status: "failed" };

function withTorrents(
	current: ListState,
	torrents: TorrentSummary[],
): ListState {
	const selectedHash =
		current.status === "loaded" &&
		current.selectedHash &&
		torrents.some((torrent) => torrent.hash_string === current.selectedHash)
			? current.selectedHash
			: torrents[0]?.hash_string;

	return {
		status: "loaded",
		torrents,
		selectedHash,
		activity: { kind: "idle" },
	};
}

export function AppInner({ operations }: AppInnerProps) {
	const [list, setList] = useState<ListState>({ status: "loading" });
	const busy = useRef(false);
	const mounted = useRef(true);
	const selectedHash = useRef<string | undefined>(undefined);

	const showMessage = (
		message: string,
		tone: "error" | "warning" = "error",
	) => {
		if (!mounted.current) return;

		setList((current) =>
			current.status === "loaded"
				? {
						...current,
						activity: { kind: "message", message, tone },
					}
				: current,
		);
	};

	useEffect(() => {
		let active = true;

		void operations
			.listTorrents()
			.then(({ torrents }) => {
				if (!active) return;
				setList((current) => withTorrents(current, torrents));
			})
			.catch(() => {
				if (active) setList({ status: "failed" });
			});

		return () => {
			active = false;
		};
	}, [operations]);

	useEffect(() => {
		selectedHash.current =
			list.status === "loaded" ? list.selectedHash : undefined;
	}, [list]);

	useEffect(() => {
		mounted.current = true;

		return () => {
			mounted.current = false;
		};
	}, []);

	async function refresh(): Promise<void> {
		if (list.status === "loading" || busy.current) return;

		busy.current = true;
		setList((current) =>
			current.status === "loaded"
				? {
						...current,
						activity: { kind: "busy", message: "Refreshing…" },
					}
				: { status: "loading" },
		);

		try {
			const { torrents } = await operations.listTorrents();
			if (mounted.current) {
				setList((current) => withTorrents(current, torrents));
			}
		} catch {
			if (!mounted.current) return;
			if (list.status === "loaded") showMessage("Refresh failed");
			else setList({ status: "failed" });
		} finally {
			busy.current = false;
		}
	}

	async function start(): Promise<void> {
		const torrentHash = selectedHash.current;
		if (list.status !== "loaded" || !torrentHash || busy.current) return;

		busy.current = true;
		setList((current) =>
			current.status === "loaded"
				? {
						...current,
						activity: { kind: "busy", message: "Starting…" },
					}
				: current,
		);

		try {
			const outcome = await startTorrent(operations, torrentHash);
			if (!mounted.current) return;
			if (outcome.status === "refreshed") {
				setList((current) =>
					withTorrents(current, outcome.torrents.torrents),
				);
			} else {
				showMessage("Started · refresh failed", "warning");
			}
		} catch {
			showMessage("Start failed");
		} finally {
			busy.current = false;
		}
	}

	async function stop(): Promise<void> {
		const torrentHash = selectedHash.current;
		if (list.status !== "loaded" || !torrentHash || busy.current) return;

		busy.current = true;
		setList((current) =>
			current.status === "loaded"
				? {
						...current,
						activity: { kind: "busy", message: "Stopping…" },
					}
				: current,
		);

		try {
			const outcome = await stopTorrent(operations, torrentHash);
			if (!mounted.current) return;
			if (outcome.status === "refreshed") {
				setList((current) =>
					withTorrents(current, outcome.torrents.torrents),
				);
			} else {
				showMessage("Stopped · refresh failed", "warning");
			}
		} catch {
			showMessage("Stop failed");
		} finally {
			busy.current = false;
		}
	}

	function select(target: "next" | "previous" | "first" | "last"): void {
		if (list.status !== "loaded" || list.torrents.length === 0) return;

		const currentIndex = Math.max(
			0,
			list.torrents.findIndex(
				(torrent) => torrent.hash_string === selectedHash.current,
			),
		);
		const nextIndex =
			target === "first"
				? 0
				: target === "last"
					? list.torrents.length - 1
					: Math.min(
							Math.max(
								currentIndex + (target === "next" ? 1 : -1),
								0,
							),
							list.torrents.length - 1,
						);
		const torrentHash = list.torrents[nextIndex]?.hash_string;

		if (torrentHash === selectedHash.current) return;
		selectedHash.current = torrentHash;
		setList((current) =>
			current.status === "loaded" && current.selectedHash !== torrentHash
				? { ...current, selectedHash: torrentHash }
				: current,
		);
	}

	useKeyboard((key) => {
		// Ignore modified shortcuts.
		if (key.ctrl || key.meta || key.shift) return;
		// Ignore held network shortcuts.
		if (
			key.repeated &&
			(key.name === keybinds.refresh.key ||
				key.name === keybinds.start.key ||
				key.name === keybinds.stop.key)
		) {
			return;
		}

		// Refresh the torrent list.
		if (key.name === keybinds.refresh.key) {
			void refresh();
			return;
		}
		// Start the selected torrent.
		if (key.name === keybinds.start.key) {
			void start();
			return;
		}
		// Stop the selected torrent.
		if (key.name === keybinds.stop.key) {
			void stop();
			return;
		}
		// Select the next torrent.
		if (key.name === "j" || key.name === "down") {
			select("next");
			return;
		}
		// Select the previous torrent.
		if (key.name === "k" || key.name === "up") {
			select("previous");
			return;
		}
		// Select the first torrent.
		if (key.name === "home") {
			select("first");
			return;
		}
		// Select the last torrent.
		if (key.name === "end") select("last");
	});

	return (
		<box
			flexGrow={1}
			minHeight={0}
			flexDirection="column"
			backgroundColor={theme.background}
		>
			<box
				flexGrow={1}
				minHeight={0}
				paddingX={1}
				paddingY={0}
				backgroundColor={theme.background}
			>
				<Frame
					titleRight={
						<text fg={theme.primary} selectable={false}>
							List
						</text>
					}
					style={{
						flexGrow: 1,
						paddingLeft: 1,
						paddingRight: 1,
						backgroundColor: theme.background,
					}}
				>
					{list.status === "loading" ? (
						<box
							flexGrow={1}
							flexDirection="column"
							alignItems="center"
							justifyContent="center"
						>
							<text fg={theme.primary} selectable={false}>
								{" /\\_/\\"}
							</text>
							<text fg={theme.primary} selectable={false}>
								( o.o )
							</text>
							<text fg={theme.primary} selectable={false}>
								{" > ^ <"}
							</text>
							<text fg={theme.textMuted} selectable={false}>
								Loading torrents...
							</text>
						</box>
					) : list.status === "failed" ? (
						<box
							flexGrow={1}
							alignItems="center"
							justifyContent="center"
						>
							<text fg={theme.textMuted} selectable={false}>
								Unable to load torrents
							</text>
						</box>
					) : (
						<TorrentList
							torrents={list.torrents}
							selectedHash={list.selectedHash}
						/>
					)}
				</Frame>
			</box>
			<Footer
				hasSelection={
					list.status === "loaded" && list.selectedHash !== undefined
				}
				status={
					list.status === "loaded" ? list.activity : { kind: "idle" }
				}
			/>
		</box>
	);
}
