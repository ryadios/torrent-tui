import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";
import type { TorrentFileState } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

const DIALOG_WIDTH = 62;
const DIALOG_HEIGHT = 22;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;
const LIST_ROWS = 14;
const SIZE_W = 8;

function formatBytes(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
	return `${bytes} B`;
}

function truncate(s: string, max: number): string {
	if (max <= 0) return "";
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function setBg(node: BoxRenderable, bg: string | undefined): void {
	(node as unknown as { backgroundColor: string | undefined }).backgroundColor =
		bg;
}

function setText(node: TextRenderable, content: string): void {
	(node as unknown as { content: string }).content = content;
}

function setFg(node: TextRenderable, fg: string): void {
	(node as unknown as { fg: string }).fg = fg;
}

interface ListRow {
	container: BoxRenderable;
	text: TextRenderable;
}

export class FilePickerDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable | null = null;
	private isOpen = false;

	private torrentId = "";
	private files: TorrentFileState[] = [];
	private selectedSet = new Set<number>();
	private cursor = 0;
	private scrollOffset = 0;

	private listRows: ListRow[] = [];
	private infoText: TextRenderable | null = null;

	onConfirm?: (torrentId: string, selectedIndices: number[] | null) => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.createElements();
	}

	open(torrentId: string, files: TorrentFileState[]): void {
		if (this.isOpen) return;
		this.torrentId = torrentId;
		this.files = files;
		this.cursor = 0;
		this.scrollOffset = 0;
		this.selectedSet = new Set(files.map((_, i) => i));
		this.isOpen = true;
		this.updatePosition();
		this.updateInfo();
		this.render();
		if (this.container) this.container.visible = true;
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		if (this.container) this.container.visible = false;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	confirmWithAllFiles(): void {
		if (!this.isOpen) return;
		const id = this.torrentId;
		this.close();
		this.onConfirm?.(id, null);
	}

	handleInput(key: KeyEvent): boolean {
		if (!this.isOpen) return false;

		if (key.name === "j" || key.name === "down") {
			if (this.cursor < this.files.length - 1) {
				this.cursor++;
				this.ensureCursorVisible();
				this.render();
			}
			return true;
		}
		if (key.name === "k" || key.name === "up") {
			if (this.cursor > 0) {
				this.cursor--;
				this.ensureCursorVisible();
				this.render();
			}
			return true;
		}
		if (key.name === "space") {
			if (this.selectedSet.has(this.cursor)) {
				this.selectedSet.delete(this.cursor);
			} else {
				this.selectedSet.add(this.cursor);
			}
			this.updateInfo();
			this.render();
			return true;
		}
		if (key.name === "a") {
			this.selectedSet = new Set(this.files.map((_, i) => i));
			this.updateInfo();
			this.render();
			return true;
		}
		if (key.name === "n") {
			this.selectedSet.clear();
			this.updateInfo();
			this.render();
			return true;
		}
		if (key.name === "return") {
			const id = this.torrentId;
			const allSelected = this.selectedSet.size === this.files.length;
			const selectedIndices = allSelected
				? null
				: [...this.selectedSet].sort((a, b) => a - b);
			this.close();
			this.onConfirm?.(id, selectedIndices);
			return true;
		}
		return false;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		if (this.isOpen) this.updatePosition();
	}

	private ensureCursorVisible(): void {
		if (this.cursor < this.scrollOffset) {
			this.scrollOffset = this.cursor;
		} else if (this.cursor >= this.scrollOffset + LIST_ROWS) {
			this.scrollOffset = this.cursor - LIST_ROWS + 1;
		}
	}

	private updateInfo(): void {
		if (!this.infoText) return;
		const total = this.files.reduce((s, f) => s + f.length, 0);
		const selected = this.files
			.filter((_, i) => this.selectedSet.has(i))
			.reduce((s, f) => s + f.length, 0);
		setText(
			this.infoText,
			`${this.selectedSet.size}/${this.files.length} selected · ${formatBytes(selected)} of ${formatBytes(total)}`,
		);
	}

	private render(): void {
		const theme = getTheme();
		// indicator(4) + space + size(SIZE_W) + space + name
		const nameW = Math.max(4, INNER_W - MARGIN * 2 - 4 - 1 - SIZE_W - 1);

		for (let i = 0; i < LIST_ROWS; i++) {
			const row = this.listRows[i];
			if (!row) continue;
			const fileIndex = this.scrollOffset + i;
			const file = this.files[fileIndex];

			if (!file) {
				setText(row.text, "");
				setBg(row.container, undefined);
				continue;
			}

			const isCurrentCursor = fileIndex === this.cursor;
			const isSelected = this.selectedSet.has(fileIndex);

			setBg(row.container, isCurrentCursor ? theme.bgTertiary : undefined);

			const indicator = isSelected ? "[✓]" : "[ ]";
			const size = formatBytes(file.length).padStart(SIZE_W);
			const name = truncate(file.path, nameW);
			setText(row.text, `${" ".repeat(MARGIN) + indicator} ${size} ${name}`);
			setFg(
				row.text,
				isCurrentCursor
					? theme.fgPrimary
					: isSelected
						? theme.fgSecondary
						: theme.fgMuted,
			);
		}
	}

	private updatePosition(): void {
		if (!this.container) return;
		const left = Math.max(
			0,
			Math.floor((this.layout.terminal.width - DIALOG_WIDTH) / 2),
		);
		const top = Math.max(
			0,
			Math.floor((this.layout.terminal.height - DIALOG_HEIGHT) / 2),
		);
		this.container.left = left;
		this.container.top = top;
	}

	private createElements(): void {
		const theme = getTheme();

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left: 0,
			top: 0,
			width: DIALOG_WIDTH,
			height: DIALOG_HEIGHT,
			border: true,
			borderStyle: "single",
			borderColor: theme.accent,
			flexDirection: "column",
			backgroundColor: theme.bgPrimary,
			visible: false,
		});

		// Title row
		const titleRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			flexDirection: "row",
			justifyContent: "space-between",
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		titleRow.add(
			new TextRenderable(this.renderer, {
				content: "Select files to download",
				fg: theme.accent,
			}),
		);
		titleRow.add(
			new TextRenderable(this.renderer, {
				content: "Enter: confirm",
				fg: theme.fgMuted,
			}),
		);
		container.add(titleRow);

		// Blank line
		container.add(
			new BoxRenderable(this.renderer, { width: INNER_W, height: 1 }),
		);

		// Info row
		const infoRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
		});
		this.infoText = new TextRenderable(this.renderer, {
			content: "",
			fg: theme.fgSecondary,
		});
		infoRow.add(this.infoText);
		container.add(infoRow);

		// Blank line
		container.add(
			new BoxRenderable(this.renderer, { width: INNER_W, height: 1 }),
		);

		// Pre-created list rows (LIST_ROWS = 14)
		this.listRows = [];
		for (let i = 0; i < LIST_ROWS; i++) {
			const rowContainer = new BoxRenderable(this.renderer, {
				width: INNER_W,
				height: 1,
			});
			const text = new TextRenderable(this.renderer, {
				content: "",
				fg: theme.fgSecondary,
			});
			rowContainer.add(text);
			container.add(rowContainer);
			this.listRows.push({ container: rowContainer, text });
		}

		// Blank line
		container.add(
			new BoxRenderable(this.renderer, { width: INNER_W, height: 1 }),
		);

		// Bottom hint row
		const hintRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
		});
		hintRow.add(
			new TextRenderable(this.renderer, {
				content: "Space: toggle  j/k: move  a: all  n: none  Esc: all files",
				fg: theme.fgMuted,
			}),
		);
		container.add(hintRow);

		// Total rows: 1(title) + 1(blank) + 1(info) + 1(blank) + 14(list) + 1(blank) + 1(hint) = 20
		// + 2 (border top+bottom) = 22 = DIALOG_HEIGHT ✓

		this.renderer.root.add(container);
		this.container = container;
	}
}
