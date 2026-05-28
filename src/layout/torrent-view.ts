import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TorrentState } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import type { FocusArea } from "./content-window";

const PREFIX_W = 2;
const SUFFIX_W = 3;
const SIZE_W = 9;
const SEP_W = 2;
const STATUS_W = 13;
const DL_W = 12;
const UL_W = 12;
const ETA_W = 9;
const PCT_W = 5;

const RIGHT_W =
	SIZE_W + SEP_W + STATUS_W + DL_W + UL_W + ETA_W + PCT_W + SUFFIX_W;

function calcWidths(cw: number) {
	const available = cw - PREFIX_W - RIGHT_W;
	const nameWidth = Math.max(12, Math.min(Math.floor(cw * 0.4), available));
	const gap = Math.max(0, available - nameWidth);
	return { nameWidth, gap };
}

function rightGroup(
	size: string,
	status: string,
	dl: string,
	ul: string,
	eta: string,
	pct: string,
): string {
	return (
		size.padStart(SIZE_W) +
		" ".repeat(SEP_W) +
		status.padEnd(STATUS_W) +
		dl.padEnd(DL_W) +
		ul.padEnd(UL_W) +
		eta.padEnd(ETA_W) +
		pct.padStart(PCT_W) +
		" ".repeat(SUFFIX_W)
	);
}

function buildRow(
	left: string,
	nameWidth: number,
	gap: number,
	right: string,
	prefix = "  ",
): string {
	return prefix + left.padEnd(nameWidth) + " ".repeat(gap) + right;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
	return `${bytes} B`;
}

function formatSpeed(bps: number): string {
	if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
	if (bps >= 1_000) return `${Math.round(bps / 1_000)} KB/s`;
	return "";
}

function formatEta(secs: number | null): string {
	if (!secs || secs <= 0) return "";
	const h = Math.floor(secs / 3600);
	const m = Math.floor((secs % 3600) / 60);
	const s = Math.floor(secs % 60);
	if (h > 0)
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

function formatStatus(status: TorrentState["status"]): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "checking":
			return "Checking";
		case "connecting":
			return "Connecting";
		case "downloading":
			return "Downloading";
		case "stalled":
			return "Stalled";
		case "paused":
			return "Paused";
		case "seeding":
			return "Seeding";
		case "stopped":
			return "Stopped";
		case "error":
			return "Error";
		case "missing":
			return "Missing";
	}
}

function setText(node: TextRenderable, content: string): void {
	(node as unknown as { content: string }).content = content;
}

function setFg(node: TextRenderable, fg: string): void {
	(node as unknown as { fg: string }).fg = fg;
}

function setBg(node: BoxRenderable, bg: string | undefined): void {
	(node as unknown as { backgroundColor: string | undefined }).backgroundColor =
		bg;
}

interface TorrentRow {
	metaRow: BoxRenderable;
	metaText: TextRenderable;
	barRow: BoxRenderable;
	filledText: TextRenderable;
	emptyText: TextRenderable;
}

export class TorrentTable {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private widths: ReturnType<typeof calcWidths>;
	private container: BoxRenderable;
	private headerText: TextRenderable;
	private rows: TorrentRow[] = [];

	private lastTorrents: TorrentState[] = [];
	private lastSelectedIndex = 0;
	private lastFocusArea: FocusArea = "sidebar";

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.widths = calcWidths(layout.content.width);
		const built = this.buildShell(layout.content.width);
		this.container = built.container;
		this.headerText = built.headerText;
	}

	getContainer(): BoxRenderable {
		return this.container;
	}

	update(
		torrents: TorrentState[],
		selectedIndex: number,
		focusArea: FocusArea,
	): void {
		const visibleTorrents = torrents.slice(0, this.maxVisibleRows());
		this.lastTorrents = visibleTorrents;
		this.lastSelectedIndex = selectedIndex;
		this.lastFocusArea = focusArea;

		if (visibleTorrents.length !== this.rows.length) {
			this.rebuildRows(visibleTorrents.length);
		}

		for (let i = 0; i < visibleTorrents.length; i++) {
			const row = this.rows[i];
			const torrent = visibleTorrents[i];
			if (!row || !torrent) continue;
			this.updateRow(
				row,
				torrent,
				i === selectedIndex && focusArea === "table",
			);
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		this.widths = calcWidths(layout.content.width);
		(this.container as unknown as { width: number }).width =
			layout.content.width;
		const { nameWidth, gap } = this.widths;
		setText(
			this.headerText,
			buildRow(
				"Name",
				nameWidth,
				gap,
				rightGroup("Size", "Status", "↓ Speed", "↑ Speed", "ETA", "%"),
			),
		);
		this.update(this.lastTorrents, this.lastSelectedIndex, this.lastFocusArea);
	}

	private rebuildRows(count: number): void {
		for (const row of this.rows) {
			row.metaRow.destroy();
			row.barRow.destroy();
		}
		this.rows = [];
		for (let i = 0; i < count; i++) {
			const row = this.createRow();
			this.container.add(row.metaRow);
			this.container.add(row.barRow);
			this.rows.push(row);
		}
	}

	private createRow(): TorrentRow {
		const theme = getTheme();
		const { nameWidth, gap } = this.widths;
		const trailingW = gap + RIGHT_W;
		const cw = this.layout.content.width;

		const metaRow = new BoxRenderable(this.renderer, { width: cw, height: 1 });
		const metaText = new TextRenderable(this.renderer, {
			content: buildRow(
				" ".repeat(nameWidth),
				nameWidth,
				gap,
				" ".repeat(RIGHT_W),
			),
			fg: theme.fgPrimary,
		});
		metaRow.add(metaText);

		const barRow = new BoxRenderable(this.renderer, {
			width: cw,
			height: 1,
			flexDirection: "row",
		});
		const filledText = new TextRenderable(this.renderer, {
			content: "  ",
			fg: theme.accent,
		});
		const emptyText = new TextRenderable(this.renderer, {
			content: " ".repeat(nameWidth + trailingW),
			fg: theme.fgMuted,
		});
		barRow.add(filledText);
		barRow.add(emptyText);

		return { metaRow, metaText, barRow, filledText, emptyText };
	}

	private updateRow(
		row: TorrentRow,
		torrent: TorrentState,
		isSelected: boolean,
	): void {
		const theme = getTheme();
		const { nameWidth, gap } = this.widths;
		const trailingW = gap + RIGHT_W;

		const pct =
			torrent.totalPieces > 0
				? Math.floor((torrent.downloadedPieces / torrent.totalPieces) * 100)
				: 0;
		const filledLen = Math.round((pct / 100) * nameWidth);
		const emptyLen = nameWidth - filledLen;

		const barColor = (() => {
			switch (torrent.status) {
				case "seeding":
					return theme.success;
				case "checking":
					return theme.accentHover;
				case "connecting":
				case "queued":
					return theme.fgSecondary;
				case "stalled":
				case "paused":
					return theme.warning;
				case "stopped":
					return theme.fgSecondary;
				case "error":
					return theme.error;
				case "missing":
					return theme.warning;
				default:
					return theme.accent;
			}
		})();

		// No background color — use text prefix + color to match sidebar pattern
		setBg(row.metaRow, undefined);
		setBg(row.barRow, undefined);

		const prefix = isSelected ? "> " : "  ";
		const name = truncate(torrent.name, nameWidth);
		const status = formatStatus(torrent.status);
		const dl =
			torrent.downloadBps > 0 ? `↓ ${formatSpeed(torrent.downloadBps)}` : "";
		const ul =
			torrent.uploadBps > 0 ? `↑ ${formatSpeed(torrent.uploadBps)}` : "";

		setText(
			row.metaText,
			buildRow(
				name,
				nameWidth,
				gap,
				rightGroup(
					formatBytes(torrent.totalSize),
					status,
					dl,
					ul,
					formatEta(torrent.etaSeconds),
					`${pct}%`,
				),
				prefix,
			),
		);
		setFg(row.metaText, isSelected ? theme.accent : theme.fgPrimary);

		setText(row.filledText, `  ${"━".repeat(Math.max(0, filledLen))}`);
		setFg(row.filledText, barColor);
		setText(
			row.emptyText,
			"━".repeat(Math.max(0, emptyLen)) + " ".repeat(trailingW),
		);
	}

	private buildShell(cw: number): {
		container: BoxRenderable;
		headerText: TextRenderable;
	} {
		const theme = getTheme();
		const { nameWidth, gap } = this.widths;

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 0,
			top: 0,
			width: cw,
			flexDirection: "column",
		});

		const headerText = new TextRenderable(this.renderer, {
			content: buildRow(
				"Name",
				nameWidth,
				gap,
				rightGroup("Size", "Status", "↓ Speed", "↑ Speed", "ETA", "%"),
			),
			fg: theme.fgPrimary,
		});

		const spacer = new TextRenderable(this.renderer, { content: "" });

		container.add(headerText);
		container.add(spacer);

		return { container, headerText };
	}

	private maxVisibleRows(): number {
		return Math.max(0, Math.floor((this.layout.content.height - 2) / 2));
	}
}
