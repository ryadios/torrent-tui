import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { TorrentSummary } from "../transmission/types/torrent";
import { FullBorder } from "./borders";
import { formatRate } from "./format-rate";
import { formatSize } from "./format-size";
import { ProgressBar } from "./progress-bar";
import { theme } from "./theme";
import { truncateEnd } from "./truncate-text";

const MIN_NAME_WIDTH = 36;
const STATUS_WIDTH = 12;
const ETA_WIDTH = 9;
const SIZE_WIDTH = 11;
const RATE_WIDTH = 24;
const COLUMN_GAP = 2;
const NAME_CONTENT_GAP = 1;
const INLINE_PROGRESS_WIDTH = 30;
const CONTENT_PADDING = 3;

type TorrentListProps = {
	torrents: TorrentSummary[];
	selectedHash?: string;
	emptyMessage?: string;
};

type TorrentLayout = {
	nameWidth: number;
	showStatus: boolean;
	showEta: boolean;
	showSize: boolean;
	showRates: boolean;
};

const statuses: Record<number, string> = {
	0: "Stopped",
	1: "Queued",
	2: "Verifying",
	3: "Queued",
	4: "Downloading",
	5: "Queued",
	6: "Seeding",
};

type TorrentStatus = {
	label: string;
	color: string;
};

function getTorrentStatus(torrent: TorrentSummary): TorrentStatus {
	if (torrent.error !== 0) {
		return {
			label: torrent.error_string
				? `Error: ${torrent.error_string}`
				: "Error",
			color: theme.error,
		};
	}

	const label = statuses[torrent.status] ?? `Status ${torrent.status}`;

	switch (torrent.status) {
		case 1:
		case 2:
		case 3:
		case 5:
			return { label, color: theme.warning };
		case 4:
			return { label, color: theme.primary };
		case 6:
			return { label, color: theme.success };
		default:
			return { label, color: theme.textMuted };
	}
}

function formatEta(eta: number): string {
	if (!Number.isFinite(eta) || eta < 0) return "—";

	const seconds = Math.floor(eta);
	if (seconds < 60) return `${seconds} sec`;
	if (seconds < 60 * 60) return `${Math.floor(seconds / 60)} min`;
	if (seconds < 60 * 60 * 24) {
		return `${Math.floor(seconds / (60 * 60))} hrs`;
	}
	if (seconds < 60 * 60 * 24 * 30) {
		return `${Math.floor(seconds / (60 * 60 * 24))} days`;
	}
	if (seconds < 60 * 60 * 24 * 30 * 12) {
		return `${Math.floor(seconds / (60 * 60 * 24 * 30))} months`;
	}
	if (seconds < 60 * 60 * 24 * 365 * 1000) {
		return `${Math.floor(seconds / (60 * 60 * 24 * 365))} years`;
	}

	return "∞";
}

function getTorrentLayout(width: number): TorrentLayout {
	const contentWidth = Math.max(0, Math.floor(width) - CONTENT_PADDING);
	let fixedWidth = 0;
	let fixedColumns = 0;

	function addColumns(widthToAdd: number, columnsToAdd = 1): boolean {
		const nextFixedWidth = fixedWidth + widthToAdd;
		const nextFixedColumns = fixedColumns + columnsToAdd;
		if (
			MIN_NAME_WIDTH + nextFixedWidth + nextFixedColumns * COLUMN_GAP >
			contentWidth
		) {
			return false;
		}

		fixedWidth = nextFixedWidth;
		fixedColumns = nextFixedColumns;
		return true;
	}

	const showStatus = addColumns(STATUS_WIDTH);
	const showEta = showStatus && addColumns(ETA_WIDTH);
	const showSize = showEta && addColumns(SIZE_WIDTH);
	const showRates = showSize && addColumns(RATE_WIDTH);

	return {
		nameWidth: Math.max(
			0,
			contentWidth - fixedWidth - fixedColumns * COLUMN_GAP,
		),
		showStatus,
		showEta,
		showSize,
		showRates,
	};
}

function TorrentCell({
	children,
	width,
	color = theme.textMuted,
}: {
	children: string;
	width: number;
	color?: string;
}) {
	return (
		<box
			style={{
				width,
				flexShrink: 0,
				overflow: "hidden",
				height: 1,
			}}
		>
			<text fg={color} selectable={false} wrapMode="none" truncate>
				{children}
			</text>
		</box>
	);
}

function TorrentRow({
	torrent,
	layout,
	selected,
}: {
	torrent: TorrentSummary;
	layout: TorrentLayout;
	selected: boolean;
}) {
	const status = getTorrentStatus(torrent);
	const progressWidth = Math.min(
		INLINE_PROGRESS_WIDTH,
		Math.max(0, layout.nameWidth - NAME_CONTENT_GAP),
	);
	const nameWidth = Math.max(
		0,
		layout.nameWidth -
			(progressWidth > 0 ? progressWidth + NAME_CONTENT_GAP : 0),
	);

	return (
		<box
			id={`torrent-${torrent.hash_string}`}
			border={["left"]}
			customBorderChars={FullBorder.customBorderChars}
			borderColor={selected ? theme.primary : theme.background}
			backgroundColor={
				selected ? theme.backgroundElement : theme.background
			}
			style={{
				flexDirection: "row",
				flexShrink: 0,
				height: 1,
				paddingLeft: 1,
				paddingRight: 1,
				columnGap: COLUMN_GAP,
				width: "100%",
			}}
		>
			<box
				style={{
					width: layout.nameWidth,
					flexShrink: 0,
					overflow: "hidden",
					flexDirection: "row",
					columnGap: NAME_CONTENT_GAP,
				}}
			>
				<text
					fg={theme.text}
					selectable={false}
					wrapMode="none"
					style={{ width: nameWidth, flexShrink: 0 }}
				>
					{truncateEnd(torrent.name, nameWidth)}
				</text>
				{progressWidth > 0 ? (
					<ProgressBar
						width={progressWidth}
						percentDone={torrent.percent_done}
						completedColor={status.color}
					/>
				) : null}
			</box>
			{layout.showStatus ? (
				<TorrentCell width={STATUS_WIDTH} color={status.color}>
					{status.label}
				</TorrentCell>
			) : null}
			{layout.showEta ? (
				<TorrentCell width={ETA_WIDTH}>
					{formatEta(torrent.eta)}
				</TorrentCell>
			) : null}
			{layout.showSize ? (
				<TorrentCell width={SIZE_WIDTH}>
					{formatSize(torrent.total_size)}
				</TorrentCell>
			) : null}
			{layout.showRates ? (
				<TorrentCell width={RATE_WIDTH}>
					{`↓ ${formatRate(torrent.rate_download)} ↑ ${formatRate(torrent.rate_upload)}`}
				</TorrentCell>
			) : null}
		</box>
	);
}

function TorrentListHeader({ layout }: { layout: TorrentLayout }) {
	return (
		<box
			style={{
				flexDirection: "row",
				flexShrink: 0,
				paddingLeft: 2,
				paddingRight: 1,
				columnGap: COLUMN_GAP,
				width: "100%",
			}}
		>
			<text
				fg={theme.textMuted}
				selectable={false}
				wrapMode="none"
				truncate
				style={{ width: layout.nameWidth, flexShrink: 0 }}
			>
				Name
			</text>
			{layout.showStatus ? (
				<text
					fg={theme.textMuted}
					selectable={false}
					wrapMode="none"
					truncate
					style={{ width: STATUS_WIDTH, flexShrink: 0 }}
				>
					Status
				</text>
			) : null}
			{layout.showEta ? (
				<text
					fg={theme.textMuted}
					selectable={false}
					wrapMode="none"
					truncate
					style={{ width: ETA_WIDTH, flexShrink: 0 }}
				>
					ETA
				</text>
			) : null}
			{layout.showSize ? (
				<text
					fg={theme.textMuted}
					selectable={false}
					wrapMode="none"
					truncate
					style={{ width: SIZE_WIDTH, flexShrink: 0 }}
				>
					Size
				</text>
			) : null}
			{layout.showRates ? (
				<text
					fg={theme.textMuted}
					selectable={false}
					wrapMode="none"
					style={{ width: RATE_WIDTH, flexShrink: 0 }}
				>
					Rate
				</text>
			) : null}
		</box>
	);
}

export function TorrentList({
	torrents,
	selectedHash,
	emptyMessage = "No torrents",
}: TorrentListProps) {
	const { width: terminalWidth } = useTerminalDimensions();
	const [listWidth, setListWidth] = useState(0);
	const listRef = useRef<BoxRenderable | null>(null);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const layout = getTorrentLayout(listWidth || terminalWidth);
	const selectedIndex = selectedHash
		? torrents.findIndex((torrent) => torrent.hash_string === selectedHash)
		: -1;

	useEffect(() => {
		if (selectedHash && selectedIndex >= 0) {
			scrollRef.current?.scrollChildIntoView(`torrent-${selectedHash}`);
		}
	}, [selectedHash, selectedIndex]);

	return (
		<box
			ref={listRef}
			onSizeChange={() => {
				const nextWidth = listRef.current?.width ?? 0;
				setListWidth((currentWidth) =>
					currentWidth === nextWidth ? currentWidth : nextWidth,
				);
			}}
			flexGrow={1}
			minHeight={0}
			flexDirection="column"
			rowGap={1}
		>
			<TorrentListHeader layout={layout} />
			<scrollbox
				ref={scrollRef}
				focusable={false}
				scrollY
				contentOptions={{ rowGap: 1 }}
				style={{ flexGrow: 1, minHeight: 0 }}
			>
				{torrents.length === 0 ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							{emptyMessage}
						</text>
					</box>
				) : (
					torrents.map((torrent) => (
						<TorrentRow
							key={torrent.hash_string}
							torrent={torrent}
							layout={layout}
							selected={torrent.hash_string === selectedHash}
						/>
					))
				)}
			</scrollbox>
		</box>
	);
}
