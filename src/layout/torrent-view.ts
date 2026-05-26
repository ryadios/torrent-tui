import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TorrentState } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

const PREFIX_W = 2;   // left margin
const SUFFIX_W = 3;   // right margin (matching left for symmetry)
const SIZE_W   = 9;
const SEP_W    = 2;   // space between Size and Status
const STATUS_W = 13;
const DL_W     = 12;
const UL_W     = 12;
const ETA_W    = 9;
const PCT_W    = 5;

const RIGHT_W = SIZE_W + SEP_W + STATUS_W + DL_W + UL_W + ETA_W + PCT_W + SUFFIX_W;

function calcWidths(cw: number) {
	const available = cw - PREFIX_W - RIGHT_W;
	const nameWidth = Math.max(12, Math.min(Math.floor(cw * 0.4), available));
	const gap = Math.max(0, available - nameWidth);
	return { nameWidth, gap };
}

function rightGroup(size: string, status: string, dl: string, ul: string, eta: string, pct: string): string {
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

function buildRow(left: string, nameWidth: number, gap: number, right: string): string {
	return "  " + left.padEnd(nameWidth) + " ".repeat(gap) + right;
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
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
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

function setText(node: TextRenderable, content: string): void {
	(node as unknown as { content: string }).content = content;
}

function setFg(node: TextRenderable, fg: string): void {
	(node as unknown as { fg: string }).fg = fg;
}

function setBg(node: BoxRenderable, bg: string | undefined): void {
	(node as unknown as { backgroundColor: string | undefined }).backgroundColor = bg;
}

export class TorrentTable {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private widths: ReturnType<typeof calcWidths>;

	private container:    BoxRenderable;
	private headerText:   TextRenderable;
	private metaRow:      BoxRenderable;
	private metaText:     TextRenderable;
	private barRow:       BoxRenderable;
	// Bar: prefix + filled share the same TextRenderable to guarantee x-alignment
	private filledText:   TextRenderable; // content = "  " + "━"×filled
	private emptyText:    TextRenderable; // content = "━"×empty + trailing spaces
	private setLeft: (n: number) => void = () => {};

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.widths = calcWidths(layout.content.width);
		const built = this.build(layout.content.width);
		this.container  = built.container;
		this.headerText = built.headerText;
		this.metaRow    = built.metaRow;
		this.metaText   = built.metaText;
		this.barRow     = built.barRow;
		this.filledText = built.filledText;
		this.emptyText  = built.emptyText;
	}

	getContainer(): BoxRenderable {
		return this.container;
	}

	update(torrent: TorrentState | null, focusArea: "sidebar" | "table"): void {
		const theme = getTheme();
		const { nameWidth, gap } = this.widths;
		const trailingW = gap + RIGHT_W;

		if (!torrent) {
			setBg(this.metaRow, undefined);
			setBg(this.barRow, undefined);
			setText(this.metaText, buildRow(" ".repeat(nameWidth), nameWidth, gap, " ".repeat(RIGHT_W)));
			// Prefix embedded in filledText so bar starts at same x as name text
			setText(this.filledText, "  ");
			setText(this.emptyText, " ".repeat(nameWidth + trailingW));
			return;
		}

		const pct = torrent.totalPieces > 0
			? Math.floor((torrent.downloadedPieces / torrent.totalPieces) * 100)
			: 0;
		const filledLen = Math.round((pct / 100) * nameWidth);
		const emptyLen  = nameWidth - filledLen;
		const barColor  = torrent.status === "seeding" ? theme.success : theme.accent;
		const bg        = focusArea === "table" ? theme.bgSecondary : undefined;

		setBg(this.metaRow, bg);
		setBg(this.barRow, bg);

		const name   = truncate(torrent.name, nameWidth);
		const status = torrent.status.charAt(0).toUpperCase() + torrent.status.slice(1);
		const dl     = torrent.downloadBps > 0 ? `↓ ${formatSpeed(torrent.downloadBps)}` : "";
		const ul     = torrent.uploadBps   > 0 ? `↑ ${formatSpeed(torrent.uploadBps)}`   : "";

		setText(this.metaText, buildRow(name, nameWidth, gap, rightGroup(
			formatBytes(torrent.totalSize), status, dl, ul, formatEta(torrent.etaSeconds), `${pct}%`,
		)));

		// "  " prefix embedded so filledText starts at same column as name
		setText(this.filledText, "  " + "━".repeat(Math.max(0, filledLen)));
		setFg(this.filledText, barColor);
		setText(this.emptyText, "━".repeat(Math.max(0, emptyLen)) + " ".repeat(trailingW));
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		this.widths = calcWidths(layout.content.width);
		(this.container as unknown as { width: number }).width = layout.content.width;
		const { nameWidth, gap } = this.widths;
		setText(this.headerText, buildRow("Name", nameWidth, gap, rightGroup("Size", "Status", "↓ Speed", "↑ Speed", "ETA", "%")));
	}

	private build(cw: number): {
		container:  BoxRenderable;
		headerText: TextRenderable;
		metaRow:    BoxRenderable;
		metaText:   TextRenderable;
		barRow:     BoxRenderable;
		filledText: TextRenderable;
		emptyText:  TextRenderable;
	} {
		const theme = getTheme();
		const { nameWidth, gap } = this.widths;
		const trailingW = gap + RIGHT_W;

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 0,
			top: 0,
			width: cw,
			flexDirection: "column",
		});

		const headerText = new TextRenderable(this.renderer, {
			content: buildRow("Name", nameWidth, gap, rightGroup("Size", "Status", "↓ Speed", "↑ Speed", "ETA", "%")),
			fg: theme.fgSecondary,
		});

		// One blank line between header and first data row
		const spacer = new TextRenderable(this.renderer, { content: "" });

		const metaRow = new BoxRenderable(this.renderer, { width: cw, height: 1 });
		const metaText = new TextRenderable(this.renderer, {
			content: buildRow(" ".repeat(nameWidth), nameWidth, gap, " ".repeat(RIGHT_W)),
			fg: theme.fgPrimary,
		});
		metaRow.add(metaText);

		// Bar row: two TextRenderables only (no separate prefix element)
		// filledText starts with "  " so its x-position matches the name above it
		const barRow = new BoxRenderable(this.renderer, {
			width: cw,
			height: 1,
			flexDirection: "row",
		});
		const filledText = new TextRenderable(this.renderer, {
			content: "  ",   // "  " prefix + 0 bars when idle
			fg: theme.accent,
		});
		const emptyText = new TextRenderable(this.renderer, {
			content: " ".repeat(nameWidth + trailingW),
			fg: theme.fgMuted,
		});
		barRow.add(filledText);
		barRow.add(emptyText);

		container.add(headerText);
		container.add(spacer);
		container.add(metaRow);
		container.add(barRow);

		return { container, headerText, metaRow, metaText, barRow, filledText, emptyText };
	}
}
