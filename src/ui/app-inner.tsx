import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	addTorrent,
	removeTorrent,
	startTorrent,
	stopTorrent,
	type TorrentOperations,
} from "../torrent/actions";
import type { SessionStats } from "../transmission/types/session";
import type { TorrentSummary } from "../transmission/types/torrent";
import { AddDialog } from "./add-dialog";
import { Footer } from "./footer";
import { Frame } from "./frame";
import { keybinds } from "./keybinds";
import { RemoveDialog } from "./remove-dialog";
import {
	SESSION_SPEED_HISTORY_MS,
	SessionSpeedGraph,
	type SessionSpeedSample,
} from "./session-speed-graph";
import { theme } from "./theme";
import {
	type DetailsTab,
	TorrentDetailsPane,
	type TorrentDetailsState,
} from "./torrent-details";
import { TorrentList } from "./torrent-list";
import { useTorrentPolling } from "./use-torrent-polling";

type AppInnerProps = {
	operations: TorrentOperations;
	onQuitBlockedChange: (blocked: boolean) => void;
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

type TorrentDetailsRequest = {
	torrentHash: string;
	includeFiles: boolean;
};

const SEARCH_DELAY_MS = 150;

function filterByName(
	torrents: TorrentSummary[],
	query: string,
): TorrentSummary[] {
	const needle = query.trim().toLocaleLowerCase();
	return needle
		? torrents.filter((torrent) =>
				torrent.name.toLocaleLowerCase().includes(needle),
			)
		: torrents;
}

function pickHash(
	torrents: TorrentSummary[],
	selectedHash?: string,
): string | undefined {
	return torrents.some((torrent) => torrent.hash_string === selectedHash)
		? selectedHash
		: torrents[0]?.hash_string;
}

function withTorrents(
	current: ListState,
	torrents: TorrentSummary[],
	query: string,
): ListState {
	const selectedHash = pickHash(
		filterByName(torrents, query),
		current.status === "loaded" ? current.selectedHash : undefined,
	);

	return {
		status: "loaded",
		torrents,
		selectedHash,
		activity: { kind: "idle" },
	};
}

export function AppInner({ operations, onQuitBlockedChange }: AppInnerProps) {
	const { width: terminalWidth, height: terminalHeight } =
		useTerminalDimensions();
	const [list, setList] = useState<ListState>({ status: "loading" });
	const [add, setAdd] = useState<AddState>({ open: false });
	const [remove, setRemove] = useState<RemoveState>({ open: false });
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [searchEditing, setSearchEditing] = useState(false);
	const [speedSamples, setSpeedSamples] = useState<SessionSpeedSample[]>([]);
	const [sessionStats, setSessionStats] = useState<SessionStats>();
	const [speedNow, setSpeedNow] = useState(Date.now);
	const [focusedPane, setFocusedPane] = useState<"list" | "details">("list");
	const [detailsTab, setDetailsTab] = useState<DetailsTab>("overview");
	const [torrentDetails, setTorrentDetails] = useState<TorrentDetailsState>();
	const busy = useRef(false);
	const statsBusy = useRef(false);
	const activeDetailsRequest = useRef<TorrentDetailsRequest | undefined>(
		undefined,
	);
	const queuedDetailsRequest = useRef<TorrentDetailsRequest | undefined>(
		undefined,
	);
	const mounted = useRef(true);
	const selectedHash = useRef<string | undefined>(undefined);
	const pollWarningShown = useRef(false);
	const draftRef = useRef("");
	const queryRef = useRef("");
	const searchEditingRef = useRef(false);
	const visibleTorrents =
		list.status === "loaded" ? filterByName(list.torrents, query) : [];
	const visibleSelectedHash = pickHash(
		visibleTorrents,
		list.status === "loaded" ? list.selectedHash : undefined,
	);
	const selectedDetails =
		visibleSelectedHash && torrentDetails?.hash === visibleSelectedHash
			? torrentDetails.data
			: undefined;
	const filesAvailable =
		(selectedDetails?.metadata_percent_complete ?? 0) >= 1;
	const visibleDetailsTab =
		detailsTab === "files" && !filesAvailable ? "overview" : detailsTab;
	const lowerPanesVisible = terminalHeight >= 16;
	const detailsRowWidth = Math.max(0, terminalWidth - 2);
	const pairedWidth = detailsRowWidth - 2;
	const showSpeed = lowerPanesVisible && pairedWidth >= 80;
	const speedWidth = showSpeed
		? Math.min(80, Math.floor(pairedWidth * 0.4))
		: 0;
	const detailsWidth = showSpeed ? pairedWidth - speedWidth : detailsRowWidth;
	const detailPaneHeight = terminalHeight < 28 ? 10 : 13;
	const activeHash = useRef<string | undefined>(visibleSelectedHash);
	activeHash.current = visibleSelectedHash;

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
		setList((current) => withTorrents(current, torrents, queryRef.current));
	}, []);

	const refreshSessionStats = useCallback(async (): Promise<void> => {
		if (statsBusy.current) return;
		statsBusy.current = true;

		try {
			const stats = await operations.getSessionStats();
			if (
				!Number.isFinite(stats.download_speed) ||
				!Number.isFinite(stats.upload_speed)
			) {
				throw new TypeError("Session speeds must be finite numbers");
			}
			if (!mounted.current) return;

			const sampledAt = Date.now();
			setSpeedNow(sampledAt);
			setSessionStats(stats);
			setSpeedSamples((current) => [
				...current.filter(
					(sample) =>
						sample.at >= sampledAt - SESSION_SPEED_HISTORY_MS,
				),
				{
					at: sampledAt,
					download: stats.download_speed,
					upload: stats.upload_speed,
				},
			]);
		} catch {
			if (!mounted.current) return;
			setSpeedNow(Date.now());
			setSessionStats(undefined);
		} finally {
			statsBusy.current = false;
		}
	}, [operations]);

	const refreshTorrentDetails = useCallback(
		async (torrentHash: string, includeFiles: boolean): Promise<void> => {
			const request = { torrentHash, includeFiles };
			const activeRequest = activeDetailsRequest.current;
			if (activeRequest) {
				queuedDetailsRequest.current =
					activeRequest.torrentHash === torrentHash &&
					activeRequest.includeFiles === includeFiles
						? undefined
						: request;
				return;
			}
			activeDetailsRequest.current = request;
			setTorrentDetails((current) =>
				current?.hash === torrentHash
					? { ...current, unavailable: false }
					: {
							hash: torrentHash,
							unavailable: false,
							stale: false,
						},
			);

			try {
				const data = await operations.getTorrentDetails(
					torrentHash,
					includeFiles,
				);
				if (!data) throw new Error("Torrent details not found");
				if (!mounted.current || activeHash.current !== torrentHash)
					return;

				setTorrentDetails((current) => ({
					hash: torrentHash,
					data: {
						...data,
						files:
							data.files ??
							(current?.hash === torrentHash
								? current.data?.files
								: undefined),
					},
					unavailable: false,
					stale: false,
				}));
			} catch {
				if (!mounted.current || activeHash.current !== torrentHash)
					return;
				setTorrentDetails((current) =>
					current?.hash === torrentHash && current.data
						? {
								...current,
								unavailable: false,
								stale: true,
							}
						: {
								hash: torrentHash,
								unavailable: true,
								stale: false,
							},
				);
			} finally {
				if (activeDetailsRequest.current === request) {
					const queuedRequest = queuedDetailsRequest.current;
					queuedDetailsRequest.current = undefined;
					activeDetailsRequest.current = undefined;

					if (
						mounted.current &&
						queuedRequest &&
						(queuedRequest.torrentHash !== torrentHash ||
							queuedRequest.includeFiles !== includeFiles)
					) {
						void refreshTorrentDetails(
							queuedRequest.torrentHash,
							queuedRequest.includeFiles,
						);
					}
				}
			}
		},
		[operations],
	);

	useEffect(() => {
		if (!visibleSelectedHash) {
			queuedDetailsRequest.current = undefined;
			setTorrentDetails(undefined);
			return;
		}
		setDetailsTab("overview");
	}, [visibleSelectedHash]);

	useEffect(() => {
		if (!visibleSelectedHash || !lowerPanesVisible) {
			queuedDetailsRequest.current = undefined;
			return;
		}
		void refreshTorrentDetails(
			visibleSelectedHash,
			visibleDetailsTab === "files",
		);
	}, [
		visibleSelectedHash,
		visibleDetailsTab,
		lowerPanesVisible,
		refreshTorrentDetails,
	]);

	useEffect(() => {
		if (!lowerPanesVisible && focusedPane === "details") {
			setFocusedPane("list");
		}
	}, [focusedPane, lowerPanesVisible]);

	useEffect(() => {
		if (detailsTab === "files" && !filesAvailable) {
			setDetailsTab("overview");
		}
	}, [detailsTab, filesAvailable]);

	const applySearch = useCallback((value: string): void => {
		const nextQuery = value.trim();
		queryRef.current = nextQuery;
		setQuery(nextQuery);
		setList((current) => {
			if (current.status !== "loaded") return current;
			const nextSelectedHash = pickHash(
				filterByName(current.torrents, nextQuery),
				current.selectedHash,
			);
			return current.selectedHash === nextSelectedHash
				? current
				: { ...current, selectedHash: nextSelectedHash };
		});
	}, []);

	useEffect(() => {
		if (!searchEditing || draft.trim() === query) return;
		const timer = setTimeout(() => applySearch(draft), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [applySearch, searchEditing, draft, query]);

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
		void refreshSessionStats();
	}, [refreshSessionStats]);

	useEffect(() => {
		selectedHash.current =
			list.status === "loaded" ? list.selectedHash : undefined;
	}, [list]);

	useEffect(() => {
		mounted.current = true;

		return () => {
			mounted.current = false;
			onQuitBlockedChange(false);
		};
	}, [onQuitBlockedChange]);

	function currentHash(): string | undefined {
		if (list.status !== "loaded") return undefined;
		return pickHash(
			filterByName(list.torrents, queryRef.current),
			selectedHash.current,
		);
	}

	function openSearch(): void {
		if (list.status !== "loaded" || searchEditingRef.current) return;
		searchEditingRef.current = true;
		onQuitBlockedChange(true);
		setSearchEditing(true);
	}

	function finishSearch(apply: boolean): void {
		searchEditingRef.current = false;
		onQuitBlockedChange(false);
		setSearchEditing(false);
		if (apply) {
			applySearch(draftRef.current);
		} else {
			draftRef.current = "";
			setDraft("");
			applySearch("");
		}
	}

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
		enabled: true,
		onTick: () => {
			setSpeedNow(Date.now());
			void refresh();
			void refreshSessionStats();
			if (lowerPanesVisible && visibleSelectedHash) {
				void refreshTorrentDetails(
					visibleSelectedHash,
					visibleDetailsTab === "files",
				);
			}
		},
	});

	function openAdd(): void {
		if (list.status === "loading" || busy.current || add.open) return;
		onQuitBlockedChange(true);
		setAdd({ open: true, pending: false });
	}

	function closeAdd(): void {
		if (!add.open || add.pending) return;
		onQuitBlockedChange(false);
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
			onQuitBlockedChange(false);
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

		const torrentHash = currentHash();
		const torrent = list.torrents.find(
			(candidate) => candidate.hash_string === torrentHash,
		);
		if (!torrent) return;

		onQuitBlockedChange(true);
		setRemove({
			open: true,
			name: torrent.name,
			hash: torrent.hash_string,
			pending: false,
		});
	}

	function closeRemove(): void {
		if (!remove.open || remove.pending) return;
		onQuitBlockedChange(false);
		setRemove({ open: false });
	}

	async function submitRemove(deleteLocalData: boolean): Promise<void> {
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
			const outcome = await removeTorrent(
				operations,
				torrentHash,
				deleteLocalData,
			);
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
			onQuitBlockedChange(false);
			setRemove({ open: false });
		} catch {
			if (!mounted.current) return;
			onQuitBlockedChange(false);
			setRemove({ open: false });
			showMessage("Remove failed");
		} finally {
			busy.current = false;
		}
	}

	async function start(): Promise<void> {
		const torrentHash = currentHash();
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
		const torrentHash = currentHash();
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
		if (list.status !== "loaded") return;
		const torrents = filterByName(list.torrents, queryRef.current);
		if (torrents.length === 0) return;

		const currentIndex = Math.max(
			0,
			torrents.findIndex(
				(torrent) => torrent.hash_string === currentHash(),
			),
		);
		const nextIndex =
			target === "first"
				? 0
				: target === "last"
					? torrents.length - 1
					: Math.min(
							Math.max(
								currentIndex + (target === "next" ? 1 : -1),
								0,
							),
							torrents.length - 1,
						);
		const torrentHash = torrents[nextIndex]?.hash_string;

		if (torrentHash === selectedHash.current) return;
		selectedHash.current = torrentHash;
		setList((current) =>
			current.status === "loaded" && current.selectedHash !== torrentHash
				? { ...current, selectedHash: torrentHash }
				: current,
		);
	}

	useKeyboard((key) => {
		if (searchEditingRef.current) {
			if (
				!key.ctrl &&
				!key.meta &&
				!key.shift &&
				(key.name === "return" || key.name === "escape")
			) {
				key.preventDefault();
				key.stopPropagation();
				finishSearch(key.name === "return");
			}
			return;
		}
		if (add.open || remove.open) return;
		if (lowerPanesVisible && !key.ctrl && !key.meta && key.name === "tab") {
			key.preventDefault();
			setFocusedPane((current) =>
				key.shift
					? current === "details"
						? "list"
						: "details"
					: current === "list"
						? "details"
						: "list",
			);
			return;
		}
		// Ignore modified shortcuts.
		if (key.ctrl || key.meta || key.shift) return;
		if (key.name === "escape" && queryRef.current) {
			finishSearch(false);
			return;
		}
		if (key.name === keybinds.search.key) {
			openSearch();
			return;
		}
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
		if (focusedPane === "details") return;
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
				flexDirection="column"
				backgroundColor={theme.background}
			>
				<Frame
					borderColor={
						focusedPane === "list"
							? theme.primary
							: theme.borderSubtle
					}
					titleRight={
						<box paddingX={1} backgroundColor={theme.background}>
							<text
								fg={
									focusedPane === "list"
										? theme.primary
										: theme.textMuted
								}
								selectable={false}
							>
								List
							</text>
						</box>
					}
					style={{
						flexGrow: 1,
						minHeight: 0,
						paddingLeft: 1,
						paddingRight: 1,
						backgroundColor: theme.background,
					}}
				>
					<box flexGrow={1} minHeight={0} flexDirection="column">
						{list.status === "loading" ? (
							<box
								flexGrow={1}
								minHeight={0}
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
								minHeight={0}
								alignItems="center"
								justifyContent="center"
							>
								<text fg={theme.textMuted} selectable={false}>
									Unable to load torrents
								</text>
							</box>
						) : (
							<TorrentList
								torrents={visibleTorrents}
								selectedHash={visibleSelectedHash}
								emptyMessage={
									query ? "No matches" : "No torrents"
								}
							/>
						)}
					</box>
				</Frame>
				{lowerPanesVisible ? (
					<box
						flexDirection="row"
						columnGap={2}
						flexShrink={0}
						height={detailPaneHeight}
						width="100%"
					>
						<TorrentDetailsPane
							key={visibleSelectedHash ?? "no-selection"}
							state={torrentDetails}
							selectedHash={visibleSelectedHash}
							tab={visibleDetailsTab}
							focused={focusedPane === "details"}
							width={detailsWidth}
							height={detailPaneHeight}
							onTabChange={setDetailsTab}
						/>
						{showSpeed ? (
							<SessionSpeedGraph
								samples={speedSamples}
								stats={sessionStats}
								now={speedNow}
								width={speedWidth}
								height={detailPaneHeight}
							/>
						) : null}
					</box>
				) : null}
			</box>
			<Footer
				canAdd={list.status !== "loading"}
				hasSelection={visibleSelectedHash !== undefined}
				focusedPane={focusedPane}
				detailsTab={visibleDetailsTab}
				filesAvailable={filesAvailable}
				search={
					list.status === "loaded"
						? {
								editing: searchEditing,
								draft,
								query,
								onInput: (value) => {
									draftRef.current = value;
									setDraft(value);
									if (!value.trim()) applySearch("");
								},
							}
						: undefined
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
					onConfirm={(deleteLocalData) => {
						void submitRemove(deleteLocalData);
					}}
					onClose={closeRemove}
				/>
			) : null}
		</box>
	);
}
