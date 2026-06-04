import { homedir } from "node:os";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TorrentPeerState, TorrentState } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

export type DetailTab = "Pieces" | "Peers" | "Files";

interface DetailSections {
	fixedLines: string[];
	scrollLines: string[];
}

interface DetailBodyRow {
	container: BoxRenderable;
	leftText: TextRenderable;
	barText: TextRenderable; // always FILE_BAR_WIDTH chars — no empty-string layout issues
	rightText: TextRenderable;
	scrollbar: TextRenderable;
}

interface ColumnSpec {
	min: number;
	preferred: number;
}

function formatPercent(downloaded: number, total: number): string {
	if (total <= 0) return "0%";
	return `${Math.floor((downloaded / total) * 100)}%`;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
	return `${bytes} B`;
}

function formatSpeed(bps: number): string {
	if (bps <= 0) return "0 B/s";
	return `${formatBytes(bps)}/s`;
}

export function abbreviateHomePath(path: string): string {
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = homedir().replace(/\\/g, "/");
	if (normalizedPath === normalizedHome) return "~";
	if (normalizedPath.startsWith(`${normalizedHome}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return path;
}

function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (max === 1) return text.length > 0 ? "…" : "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function setText(node: TextRenderable, content: string): void {
	(node as unknown as { content: string }).content = content;
}

function setFg(node: TextRenderable, fg: string): void {
	(node as unknown as { fg: string }).fg = fg;
}

function padCell(
	text: string,
	width: number,
	align: "left" | "right" = "left",
): string {
	const value = truncate(text, width);
	return align === "right" ? value.padStart(width) : value.padEnd(width);
}

function distributeWidths(total: number, specs: ColumnSpec[]): number[] {
	const widths = specs.map((spec) => spec.min);
	const gapWidth = Math.max(0, specs.length - 1);
	let remaining = Math.max(
		0,
		total - gapWidth - widths.reduce((a, b) => a + b, 0),
	);

	for (let i = 0; i < specs.length; i++) {
		if (remaining <= 0) break;
		const spec = specs[i];
		const width = widths[i] ?? 0;
		if (!spec) continue;
		const grow = Math.min(remaining, Math.max(0, spec.preferred - width));
		widths[i] = (widths[i] ?? 0) + grow;
		remaining -= grow;
	}

	if (remaining > 0 && widths.length > 0) {
		widths[0] = (widths[0] ?? 0) + remaining;
	}

	return widths;
}

function buildPeerColumns(innerWidth: number): number[] {
	return distributeWidths(innerWidth, [
		{ min: 12, preferred: 22 },
		{ min: 6, preferred: 10 },
		{ min: 7, preferred: 12 },
		{ min: 6, preferred: 6 },
		{ min: 10, preferred: 20 },
	]);
}

const FILE_INDICATOR_W = 4; // "[✓]" or "[ ]" padded to 4
const FILE_SIZE_W = 9; // right-aligned size (matches torrent-view SIZE_W)
const FILE_LEFT_W = FILE_INDICATOR_W + 1 + FILE_SIZE_W + 1; // 15 (+1 space before bar)
const FILE_BAR_WIDTH = 10;
export const FILE_TAB_FIXED_LINES = 3;

function buildPeerRow(
	peer: TorrentPeerState,
	totalPieces: number,
	widths: number[],
): string {
	const [addressW, clientW, piecesW, chokedW, speedW] = widths;
	const speed = `↓ ${formatSpeed(peer.downloadBps)} ↑ ${formatSpeed(peer.uploadBps)}`;
	return [
		padCell(peer.address, addressW ?? 0),
		padCell(peer.client, clientW ?? 0),
		padCell(`${peer.pieces}/${totalPieces}`, piecesW ?? 0, "right"),
		padCell(peer.choked ? "yes" : "no", chokedW ?? 0),
		padCell(speed, speedW ?? 0),
	].join(" ");
}

function buildPeerSections(
	torrent: TorrentState,
	innerWidth: number,
): DetailSections {
	const widths = buildPeerColumns(innerWidth);
	return {
		fixedLines: [
			`Peers: ${torrent.peerDetails.length}`,
			[
				padCell("Address", widths[0] ?? 0),
				padCell("Client", widths[1] ?? 0),
				padCell("Pieces", widths[2] ?? 0, "right"),
				padCell("Choked", widths[3] ?? 0),
				padCell("Speed", widths[4] ?? 0),
			].join(" "),
		],
		scrollLines:
			torrent.peerDetails.length === 0
				? ["No connected peers"]
				: torrent.peerDetails.map((peer) =>
						buildPeerRow(peer, torrent.totalPieces, widths),
					),
	};
}

function buildFileSections(
	torrent: TorrentState,
	innerWidth: number,
): DetailSections {
	const pathW = Math.max(4, innerWidth - FILE_LEFT_W - FILE_BAR_WIDTH - 1);
	const header =
		padCell("", FILE_INDICATOR_W) +
		" " +
		padCell("Size", FILE_SIZE_W, "right") +
		" " + // gap between size and bar
		" ".repeat(FILE_BAR_WIDTH) +
		" " + // gap before path
		padCell("Path", pathW);
	return {
		fixedLines: [
			`Files: ${torrent.files.length}`,
			`Download path: ${abbreviateHomePath(torrent.targetPath)}`,
			header,
		],
		// Content is computed directly in update(); only the count matters here.
		scrollLines:
			torrent.files.length === 0 ? ["No files"] : torrent.files.map(() => ""),
	};
}

function buildPieceSections(torrent: TorrentState): DetailSections {
	return {
		fixedLines: [
			torrent.name,
			`Pieces: ${torrent.downloadedPieces}/${torrent.totalPieces} (${formatPercent(torrent.downloadedPieces, torrent.totalPieces)})`,
			`Piece size: ${formatBytes(torrent.pieceLength)}`,
			`Status: ${torrent.status}`,
			`Path: ${abbreviateHomePath(torrent.targetPath)}`,
		],
		scrollLines: [],
	};
}

function buildSections(
	torrent: TorrentState | null,
	tab: DetailTab,
	innerWidth: number,
	placeholder?: string | null,
): DetailSections {
	if (!torrent) {
		return placeholder
			? { fixedLines: [placeholder], scrollLines: [] }
			: { fixedLines: [], scrollLines: [] };
	}
	if (tab === "Peers") return buildPeerSections(torrent, innerWidth);
	if (tab === "Files") return buildFileSections(torrent, innerWidth);
	return buildPieceSections(torrent);
}

export function getDetailMaxScrollOffset(
	torrent: TorrentState | null,
	tab: DetailTab,
	bodyRows: number,
): number {
	if (!torrent || bodyRows <= 0) return 0;
	const sections = buildSections(torrent, tab, 80);
	const visibleScrollRows = Math.max(0, bodyRows - sections.fixedLines.length);
	if (visibleScrollRows <= 0) return 0;
	return Math.max(0, sections.scrollLines.length - visibleScrollRows);
}

export class DetailPanel {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable;
	private headerText: TextRenderable;
	private bodyRows: DetailBodyRow[] = [];

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		const built = this.build();
		this.container = built.container;
		this.headerText = built.headerText;
		this.bodyRows = built.bodyRows;
	}

	getContainer(): BoxRenderable {
		return this.container;
	}

	getBodyRowCount(): number {
		return Math.max(1, this.layout.content.height - 3);
	}

	update(
		torrent: TorrentState | null,
		tab: DetailTab,
		focused: boolean,
		scrollOffset = 0,
		placeholder: string | null = null,
		filesTabCursor = -1,
	): void {
		const theme = getTheme();
		(this.container as unknown as { borderColor: string }).borderColor = focused
			? theme.accent
			: theme.border;
		const hasPlaceholder = torrent === null && Boolean(placeholder);
		setText(
			this.headerText,
			torrent ? this.formatTabs(tab) : (placeholder ?? ""),
		);
		setFg(
			this.headerText,
			torrent ? (focused ? theme.accent : theme.fgSecondary) : theme.fgMuted,
		);

		const baseWidth = Math.max(1, this.layout.content.width - 4);
		const preSections = buildSections(torrent, tab, baseWidth, placeholder);
		const fixedLines = (
			hasPlaceholder ? preSections.fixedLines.slice(1) : preSections.fixedLines
		).slice(0, this.bodyRows.length);
		const scrollRows = Math.max(0, this.bodyRows.length - fixedLines.length);
		const showScrollbar =
			tab !== "Pieces" &&
			torrent !== null &&
			scrollRows > 0 &&
			preSections.scrollLines.length > scrollRows;
		const textWidth = Math.max(1, baseWidth - (showScrollbar ? 1 : 0));
		const sections = buildSections(torrent, tab, textWidth, placeholder);
		const stableFixedLines = (
			hasPlaceholder ? sections.fixedLines.slice(1) : sections.fixedLines
		).slice(0, this.bodyRows.length);
		const stableScrollRows = Math.max(
			0,
			this.bodyRows.length - stableFixedLines.length,
		);
		const visibleScroll = sections.scrollLines.slice(
			scrollOffset,
			scrollOffset + stableScrollRows,
		);
		const lines = [...stableFixedLines, ...visibleScroll];
		const thumb = this.buildScrollbar(
			showScrollbar,
			stableFixedLines.length,
			stableScrollRows,
			sections.scrollLines.length,
			scrollOffset,
		);

		const isFilesTab = tab === "Files" && torrent !== null;
		const filePathW = Math.max(1, textWidth - FILE_LEFT_W - FILE_BAR_WIDTH - 1);

		for (let i = 0; i < this.bodyRows.length; i++) {
			const row = this.bodyRows[i];
			if (!row) continue;

			const scrollRowIndex = i - stableFixedLines.length;
			const fileIndex = scrollOffset + scrollRowIndex;
			const file =
				isFilesTab && scrollRowIndex >= 0 && torrent
					? (torrent.files[fileIndex] ?? null)
					: null;

			const isCursorRow =
				isFilesTab &&
				focused &&
				scrollRowIndex >= 0 &&
				fileIndex === filesTabCursor;

			const textFg =
				torrent === null
					? theme.fgMuted
					: isCursorRow
						? theme.accent
						: i === 0
							? theme.fgPrimary
							: theme.fgSecondary;

			if (file) {
				// File row: [✓]/[ ] + size + space | bar (selected only) | path
				const prefix = `${torrent?.name}/`;
				const displayPath = file.path.startsWith(prefix)
					? file.path.slice(prefix.length)
					: file.path;
				const indicator = file.selected ? "[✓]" : "[ ]";
				const rowFg = file.selected
					? textFg
					: isCursorRow
						? theme.fgSecondary
						: theme.fgMuted;

				setText(
					row.leftText,
					padCell(indicator, FILE_INDICATOR_W) +
						" " +
						padCell(formatBytes(file.length), FILE_SIZE_W, "right") +
						" ", // space before bar
				);
				setFg(row.leftText, rowFg);

				// Single bar renderable: filled ━ + spaces, always FILE_BAR_WIDTH chars
				if (file.selected) {
					const pct =
						file.length > 0
							? Math.min(1, file.downloadedBytes / file.length)
							: 0;
					const filledLen = Math.round(pct * FILE_BAR_WIDTH);
					setText(
						row.barText,
						"━".repeat(filledLen) + " ".repeat(FILE_BAR_WIDTH - filledLen),
					);
					setFg(row.barText, theme.accent);
				} else {
					setText(row.barText, " ".repeat(FILE_BAR_WIDTH));
				}

				setText(
					row.rightText,
					` ${truncate(displayPath, filePathW - 1).padEnd(filePathW - 1)}`,
				);
				setFg(row.rightText, rowFg);
			} else {
				// Non-file row: full content in leftText, barText invisible
				setText(
					row.leftText,
					truncate(lines[i] ?? "", textWidth).padEnd(textWidth),
				);
				setText(row.barText, "");
				setText(row.rightText, "");
				setFg(row.leftText, textFg);
			}

			setText(row.scrollbar, thumb[i]?.char ?? "");
			setFg(
				row.scrollbar,
				thumb[i]?.active
					? focused
						? theme.accent
						: theme.fgSecondary
					: theme.fgMuted,
			);
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		this.container.left = 0;
		this.container.top = layout.content.y;
		this.container.width = layout.content.width;
		this.container.height = layout.content.height;
		this.syncBodyLines();
	}

	private build(): {
		container: BoxRenderable;
		headerText: TextRenderable;
		bodyRows: DetailBodyRow[];
	} {
		const theme = getTheme();
		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 0,
			top: this.layout.content.y,
			width: this.layout.content.width,
			height: this.layout.content.height,
			border: true,
			borderColor: theme.border,
			flexDirection: "column",
			paddingX: 1,
		});

		const headerText = new TextRenderable(this.renderer, {
			content: "",
			fg: theme.accent,
		});
		container.add(headerText);

		const bodyRows = this.buildBodyRows(container);
		return { container, headerText, bodyRows };
	}

	private buildBodyRows(container: BoxRenderable): DetailBodyRow[] {
		const theme = getTheme();
		const bodyRows: DetailBodyRow[] = [];
		for (let i = 0; i < this.getBodyRowCount(); i++) {
			const rowContainer = new BoxRenderable(this.renderer, {
				width: Math.max(1, this.layout.content.width - 2),
				height: 1,
				flexDirection: "row",
			});
			const leftText = new TextRenderable(this.renderer, {
				content: "",
				fg: theme.fgSecondary,
			});
			// Single bar renderable — always FILE_BAR_WIDTH chars, never empty string
			const barText = new TextRenderable(this.renderer, {
				content: " ".repeat(FILE_BAR_WIDTH),
				fg: theme.accent,
			});
			const rightText = new TextRenderable(this.renderer, {
				content: "",
				fg: theme.fgSecondary,
			});
			const scrollbar = new TextRenderable(this.renderer, {
				content: "",
				fg: theme.fgMuted,
			});
			rowContainer.add(leftText);
			rowContainer.add(barText);
			rowContainer.add(rightText);
			rowContainer.add(scrollbar);
			container.add(rowContainer);
			bodyRows.push({
				container: rowContainer,
				leftText,
				barText,
				rightText,
				scrollbar,
			});
		}
		return bodyRows;
	}

	private syncBodyLines(): void {
		const nextCount = this.getBodyRowCount();
		if (nextCount === this.bodyRows.length) return;
		for (const row of this.bodyRows) {
			row.container.destroy();
		}
		this.bodyRows = this.buildBodyRows(this.container);
	}

	private buildScrollbar(
		showScrollbar: boolean,
		fixedCount: number,
		scrollRows: number,
		totalScrollLines: number,
		scrollOffset: number,
	): Array<{ char: string; active: boolean }> {
		const rows = Array.from({ length: this.bodyRows.length }, () => ({
			char: "",
			active: false,
		}));
		if (!showScrollbar || scrollRows <= 0 || totalScrollLines <= scrollRows) {
			return rows;
		}

		const maxOffset = Math.max(0, totalScrollLines - scrollRows);
		const thumbHeight = Math.max(
			1,
			Math.round((scrollRows * scrollRows) / totalScrollLines),
		);
		const thumbRange = Math.max(0, scrollRows - thumbHeight);
		const thumbStart =
			maxOffset === 0 ? 0 : Math.round((scrollOffset / maxOffset) * thumbRange);

		for (let i = 0; i < scrollRows; i++) {
			const rowIndex = fixedCount + i;
			if (!rows[rowIndex]) continue;
			const active = i >= thumbStart && i < thumbStart + thumbHeight;
			rows[rowIndex] = {
				char: active ? "│" : "",
				active,
			};
		}

		return rows;
	}

	private formatTabs(active: DetailTab): string {
		const tabs = (["Pieces", "Peers", "Files"] as const)
			.map((tab) => (tab === active ? `[${tab}]` : ` ${tab} `))
			.join("  ");
		return `─ ${tabs}`;
	}
}
