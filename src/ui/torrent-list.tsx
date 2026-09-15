import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { stringWidth } from "bun";
import { useEffect, useRef } from "react";
import type { TorrentSummary } from "../transmission/types/torrent";
import { FullBorder } from "./borders";
import { ProgressBar } from "./progress-bar";
import { theme } from "./theme";

const COMPACT_WIDTH = 100;
const STATUS_WIDTH = 24;
const COMPACT_STATUS_WIDTH = 12;
const FULL_PROGRESS_WIDTH = 15;
const COMPACT_PROGRESS_WIDTH = 8;

type TorrentListProps = {
	torrents: TorrentSummary[];
	selectedHash?: string;
};

type ColumnWidths = {
	name: number;
	status: number;
	progress: number;
	download: number;
	upload: number;
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

function formatStatus(torrent: TorrentSummary): string {
	if (torrent.error !== 0) {
		return torrent.error_string
			? `Error: ${torrent.error_string}`
			: "Error";
	}

	return statuses[torrent.status] ?? `Status ${torrent.status}`;
}

function formatRate(bytesPerSecond: number): string {
	const rate = Math.max(0, bytesPerSecond);
	const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
	let value = rate;
	let unitIndex = 0;

	if (value < 1024) return `${Math.round(value)} B/s`;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function widest(values: string[]): number {
	return Math.max(...values.map((value) => stringWidth(value)));
}

function getColumnWidths(
	torrents: TorrentSummary[],
	compact: boolean,
): ColumnWidths {
	return {
		name: widest(["Name", ...torrents.map((torrent) => torrent.name)]),
		status: Math.min(
			compact ? COMPACT_STATUS_WIDTH : STATUS_WIDTH,
			widest(["Status", ...torrents.map(formatStatus)]),
		),
		progress: compact ? COMPACT_PROGRESS_WIDTH : FULL_PROGRESS_WIDTH,
		download: widest([
			"Download",
			...torrents.map(
				(torrent) => `↓ ${formatRate(torrent.rate_download)}`,
			),
		]),
		upload: widest([
			"Upload",
			...torrents.map(
				(torrent) => `↑ ${formatRate(torrent.rate_upload)}`,
			),
		]),
	};
}

function TorrentRow({
	torrent,
	compact,
	selected,
	widths,
}: {
	torrent: TorrentSummary;
	compact: boolean;
	selected: boolean;
	widths: ColumnWidths;
}) {
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
				paddingLeft: 1,
				columnGap: 2,
				width: "100%",
			}}
		>
			<box
				style={{
					width: widths.name,
					flexShrink: 1,
					minWidth: 0,
					overflow: "hidden",
				}}
			>
				<text
					fg={theme.text}
					selectable={false}
					wrapMode="none"
					truncate
				>
					{torrent.name}
				</text>
			</box>
			<box
				style={{
					width: widths.status,
					flexShrink: 0,
					overflow: "hidden",
				}}
			>
				<text
					fg={theme.textMuted}
					selectable={false}
					wrapMode="none"
					truncate
				>
					{formatStatus(torrent)}
				</text>
			</box>
			<box style={{ width: widths.progress, flexShrink: 0 }}>
				<ProgressBar
					percentDone={torrent.percent_done}
					compact={compact}
				/>
			</box>
			{compact ? null : (
				<>
					<box style={{ width: widths.download, flexShrink: 0 }}>
						<text
							fg={theme.textMuted}
							selectable={false}
							wrapMode="none"
						>
							{`↓ ${formatRate(torrent.rate_download)}`}
						</text>
					</box>
					<box style={{ width: widths.upload, flexShrink: 0 }}>
						<text
							fg={theme.textMuted}
							selectable={false}
							wrapMode="none"
						>
							{`↑ ${formatRate(torrent.rate_upload)}`}
						</text>
					</box>
				</>
			)}
		</box>
	);
}

function TorrentListHeader({
	compact,
	widths,
}: {
	compact: boolean;
	widths: ColumnWidths;
}) {
	return (
		<box
			style={{
				flexDirection: "row",
				flexShrink: 0,
				paddingLeft: 2,
				columnGap: 2,
				width: "100%",
			}}
		>
			<text
				fg={theme.textMuted}
				selectable={false}
				wrapMode="none"
				truncate
				style={{ width: widths.name, flexShrink: 1, minWidth: 0 }}
			>
				Name
			</text>
			<text
				fg={theme.textMuted}
				selectable={false}
				wrapMode="none"
				truncate
				style={{ width: widths.status, flexShrink: 0 }}
			>
				Status
			</text>
			<text
				fg={theme.textMuted}
				selectable={false}
				wrapMode="none"
				style={{ width: widths.progress, flexShrink: 0 }}
			>
				Progress
			</text>
			{compact ? null : (
				<>
					<text
						fg={theme.textMuted}
						selectable={false}
						wrapMode="none"
						style={{ width: widths.download, flexShrink: 0 }}
					>
						Download
					</text>
					<text
						fg={theme.textMuted}
						selectable={false}
						wrapMode="none"
						style={{ width: widths.upload, flexShrink: 0 }}
					>
						Upload
					</text>
				</>
			)}
		</box>
	);
}

export function TorrentList({ torrents, selectedHash }: TorrentListProps) {
	const { width } = useTerminalDimensions();
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const compact = width < COMPACT_WIDTH;
	const widths = getColumnWidths(torrents, compact);
	const selectedIndex = selectedHash
		? torrents.findIndex((torrent) => torrent.hash_string === selectedHash)
		: -1;

	useEffect(() => {
		if (selectedHash && selectedIndex >= 0) {
			scrollRef.current?.scrollChildIntoView(`torrent-${selectedHash}`);
		}
	}, [selectedHash, selectedIndex]);

	return (
		<box flexGrow={1} minHeight={0} flexDirection="column" rowGap={1}>
			<TorrentListHeader compact={compact} widths={widths} />
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
							No torrents
						</text>
					</box>
				) : (
					torrents.map((torrent) => (
						<TorrentRow
							key={torrent.hash_string}
							torrent={torrent}
							compact={compact}
							selected={torrent.hash_string === selectedHash}
							widths={widths}
						/>
					))
				)}
			</scrollbox>
		</box>
	);
}
