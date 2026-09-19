import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	addTorrent,
	removeTorrent,
	startTorrent,
	stopTorrent,
	type TorrentOperations,
} from "../torrent/actions";
import type { TorrentSummary } from "../transmission/types/torrent";
import { AddDialog } from "./add-dialog";
import { Footer } from "./footer";
import { Frame } from "./frame";
import { keybinds } from "./keybinds";
import { RemoveDialog } from "./remove-dialog";
import { theme } from "./theme";
import { TorrentList } from "./torrent-list";
import { useTorrentPolling } from "./use-torrent-polling";

type AppInnerProps = {
	operations: TorrentOperations;
	onModalActiveChange: (active: boolean) => void;
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
	| { status: "failed"; activity: Activity };

type AddState =
	| { open: false }
	| { open: true; pending: boolean; error?: string };

type RemoveState =
	| { open: false }
	| {
			open: true;
			name: string;
			hash: string;
			pending: boolean;
	  };

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

export function AppInner({ operations, onModalActiveChange }: AppInnerProps) {
	const [list, setList] = useState<ListState>({ status: "loading" });
	const [add, setAdd] = useState<AddState>({ open: false });
	const [remove, setRemove] = useState<RemoveState>({ open: false });
	const busy = useRef(false);
	const mounted = useRef(true);
	const selectedHash = useRef<string | undefined>(undefined);
	const pollWarningShown = useRef(false);

	const showMessage = (
		message: string,
		tone: "error" | "warning" = "error",
	) => {
		if (!mounted.current) return;

		setList((current) =>
			current.status !== "loading"
				? {
						...current,
						activity: { kind: "message", message, tone },
					}
				: current,
		);
	};

	const applyTorrents = useCallback((torrents: TorrentSummary[]): void => {
		pollWarningShown.current = false;
		setList((current) => withTorrents(current, torrents));
	}, []);

	useEffect(() => {
		let active = true;

		void operations
			.listTorrents()
			.then(({ torrents }) => {
				if (!active) return;
				applyTorrents(torrents);
			})
			.catch(() => {
				if (active) {
					setList({ status: "failed", activity: { kind: "idle" } });
				}
			});

		return () => {
			active = false;
		};
	}, [applyTorrents, operations]);

	useEffect(() => {
		selectedHash.current =
			list.status === "loaded" ? list.selectedHash : undefined;
	}, [list]);

	useEffect(() => {
		mounted.current = true;

		return () => {
			mounted.current = false;
			onModalActiveChange(false);
		};
	}, [onModalActiveChange]);

	async function refresh(): Promise<void> {
		if (list.status === "loading" || busy.current) return;

		busy.current = true;

		try {
			const { torrents } = await operations.listTorrents();
			if (mounted.current) {
				applyTorrents(torrents);
			}
		} catch {
			if (!mounted.current) return;
			if (list.status === "loaded") {
				if (pollWarningShown.current) return;
				pollWarningShown.current = true;
				showMessage("Refresh failed", "warning");
			} else setList({ status: "failed", activity: { kind: "idle" } });
		} finally {
			busy.current = false;
		}
	}

	useTorrentPolling({
		enabled: list.status !== "loading",
		onTick: () => {
			void refresh();
		},
	});

	function openAdd(): void {
		if (list.status === "loading" || busy.current || add.open) return;
		onModalActiveChange(true);
		setAdd({ open: true, pending: false });
	}

	function closeAdd(): void {
		if (!add.open || add.pending) return;
		onModalActiveChange(false);
		setAdd({ open: false });
	}

	async function submitAdd(source: string): Promise<void> {
		if (!add.open || add.pending || busy.current) return;

		busy.current = true;
		setAdd({ open: true, pending: true });
		setList((current) =>
			current.status === "loading"
				? current
				: { ...current, activity: { kind: "idle" } },
		);

		try {
			const outcome = await addTorrent(operations, source);
			if (!mounted.current) return;

			if (outcome.status === "refreshed") {
				applyTorrents(outcome.torrents.torrents);
			} else {
				showMessage("Refresh failed", "warning");
			}
			onModalActiveChange(false);
			setAdd({ open: false });
		} catch {
			if (mounted.current) {
				setAdd({
					open: true,
					pending: false,
					error: "Unable to add torrent",
				});
			}
		} finally {
			busy.current = false;
		}
	}

	function openRemove(): void {
		if (list.status !== "loaded" || busy.current || remove.open) return;

		const torrentHash = selectedHash.current;
		const torrent = list.torrents.find(
			(candidate) => candidate.hash_string === torrentHash,
		);
		if (!torrent) return;

		onModalActiveChange(true);
		setRemove({
			open: true,
			name: torrent.name,
			hash: torrent.hash_string,
			pending: false,
		});
	}

	function closeRemove(): void {
		if (!remove.open || remove.pending) return;
		onModalActiveChange(false);
		setRemove({ open: false });
	}

	async function submitRemove(): Promise<void> {
		if (!remove.open || remove.pending || busy.current) return;

		const torrentHash = remove.hash;
		busy.current = true;
		setRemove((current) =>
			current.open ? { ...current, pending: true } : current,
		);
		setList((current) =>
			current.status === "loaded"
				? {
						...current,
						activity: { kind: "busy", message: "Removing…" },
					}
				: current,
		);

		try {
			const outcome = await removeTorrent(operations, torrentHash);
			if (!mounted.current) return;

			const nextTorrents =
				outcome.status === "refreshed"
					? outcome.torrents.torrents
					: list.status === "loaded"
						? list.torrents.filter(
								(torrent) =>
									torrent.hash_string !== torrentHash,
							)
						: [];
			applyTorrents(nextTorrents);
			onModalActiveChange(false);
			setRemove({ open: false });
		} catch {
			if (!mounted.current) return;
			onModalActiveChange(false);
			setRemove({ open: false });
			showMessage("Remove failed");
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
				applyTorrents(outcome.torrents.torrents);
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
				applyTorrents(outcome.torrents.torrents);
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
		if (add.open || remove.open) return;
		// Ignore modified shortcuts.
		if (key.ctrl || key.meta || key.shift) return;
		// Ignore held network shortcuts.
		if (
			key.repeated &&
			(key.name === keybinds.start.key ||
				key.name === keybinds.stop.key ||
				key.name === keybinds.add.key ||
				key.name === keybinds.remove.key)
		) {
			return;
		}

		// Open the add dialog.
		if (key.name === keybinds.add.key) {
			openAdd();
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
		if (key.name === keybinds.remove.key) {
			openRemove();
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
				canAdd={list.status !== "loading"}
				hasSelection={
					list.status === "loaded" && list.selectedHash !== undefined
				}
				status={
					list.status === "loading" ? { kind: "idle" } : list.activity
				}
			/>
			{add.open ? (
				<AddDialog
					pending={add.pending}
					error={add.error}
					onSubmit={(source) => {
						void submitAdd(source);
					}}
					onClose={closeAdd}
					onClearError={() => {
						if (add.error) {
							setAdd({ open: true, pending: false });
						}
					}}
				/>
			) : null}
			{remove.open ? (
				<RemoveDialog
					name={remove.name}
					pending={remove.pending}
					onConfirm={() => {
						void submitRemove();
					}}
					onClose={closeRemove}
				/>
			) : null}
		</box>
	);
}
