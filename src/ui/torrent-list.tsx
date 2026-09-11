import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";
import type { TorrentSummary } from "../transmission/types/torrent";
import { FullBorder } from "./borders";
import { ProgressBar } from "./progress-bar";
import { theme } from "./theme";

const COMPACT_WIDTH = 60;

type TorrentListProps = {
	torrents: TorrentSummary[];
	selectedHash?: string;
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

function TorrentRow({
	torrent,
	compact,
	selected,
}: {
	torrent: TorrentSummary;
	compact: boolean;
	selected: boolean;
}) {
	return (
		<box
			id={`torrent-${torrent.hash_string}`}
			border={["left"]}
			customBorderChars={FullBorder.customBorderChars}
			borderColor={selected ? theme.borderActive : theme.backgroundPanel}
			backgroundColor={
				selected ? theme.backgroundElement : theme.backgroundPanel
			}
			style={{
				flexDirection: "row",
				flexShrink: 0,
				paddingLeft: 1,
				width: "100%",
			}}
		>
			<text
				fg={theme.text}
				selectable={false}
				wrapMode="none"
				truncate
				style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
			>
				{torrent.name}
			</text>
			<text
				fg={theme.textMuted}
				selectable={false}
				wrapMode="none"
				style={{ flexShrink: 0 }}
			>
				{`  ${formatStatus(torrent)}`}
			</text>
			<box style={{ flexShrink: 0, paddingLeft: 2 }}>
				<ProgressBar
					percentDone={torrent.percent_done}
					compact={compact}
				/>
			</box>
			{compact ? null : (
				<box style={{ flexShrink: 0, paddingLeft: 2 }}>
					<text
						fg={theme.textMuted}
						selectable={false}
						wrapMode="none"
					>
						{`↓ ${formatRate(torrent.rate_download)}  ↑ ${formatRate(torrent.rate_upload)}`}
					</text>
				</box>
			)}
		</box>
	);
}

export function TorrentList({ torrents, selectedHash }: TorrentListProps) {
	const { width } = useTerminalDimensions();
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const compact = width < COMPACT_WIDTH;
	const selectedIndex = selectedHash
		? torrents.findIndex((torrent) => torrent.hash_string === selectedHash)
		: -1;

	useEffect(() => {
		if (selectedHash && selectedIndex >= 0) {
			scrollRef.current?.scrollChildIntoView(`torrent-${selectedHash}`);
		}
	}, [selectedHash, selectedIndex]);

	return (
		<scrollbox
			ref={scrollRef}
			focusable={false}
			scrollY
			style={{ flexGrow: 1 }}
		>
			{torrents.length === 0 ? (
				<box flexGrow={1} alignItems="center" justifyContent="center">
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
					/>
				))
			)}
		</scrollbox>
	);
}
