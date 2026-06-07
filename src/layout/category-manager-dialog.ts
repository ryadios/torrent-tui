import { homedir } from "node:os";
import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";
import type { CategoryState } from "../store";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

const DIALOG_WIDTH = 58;
const DIALOG_HEIGHT = 18;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;
const ROWS = 11;

interface Row {
	container: BoxRenderable;
	text: TextRenderable;
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

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	const left = Math.floor((max - 1) / 2);
	const right = max - 1 - left;
	return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function truncateRight(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	return `${text.slice(0, max - 1)}…`;
}

function abbreviateHomePath(path: string): string {
	const trimmed = path.trim();
	const normalizedPath = trimmed.replace(/\\/g, "/");
	const normalizedHome = homedir().replace(/\\/g, "/");
	if (normalizedPath === normalizedHome) return "~";
	if (normalizedPath.startsWith(`${normalizedHome}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return trimmed;
}

export class CategoryManagerDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable | null = null;
	private titleText: TextRenderable | null = null;
	private hintText: TextRenderable | null = null;
	private rows: Row[] = [];
	private isOpen = false;
	private categories: CategoryState[] = [];
	private cursor = 0;
	private scrollOffset = 0;

	onCancel?: () => void;
	onDelete?: (category: CategoryState) => void;
	onEdit?: (category: CategoryState) => void;
	onNew?: () => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.createElements();
	}

	open(categories: CategoryState[]): void {
		this.isOpen = true;
		this.categories = categories;
		this.cursor = Math.min(this.cursor, Math.max(0, categories.length - 1));
		this.scrollOffset = 0;
		this.updatePosition();
		this.render();
		if (this.container) this.container.visible = true;
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		if (this.container) this.container.visible = false;
	}

	hide(): void {
		if (this.container) this.container.visible = false;
	}

	show(categories = this.categories): void {
		if (!this.isOpen) return;
		this.categories = categories;
		this.cursor = Math.min(this.cursor, Math.max(0, categories.length - 1));
		this.updatePosition();
		this.render();
		if (this.container) this.container.visible = true;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	handleInput(key: KeyEvent): boolean {
		if (!this.isOpen) return false;
		if (key.name === "escape") {
			this.close();
			this.onCancel?.();
			return true;
		}
		if (key.name === "n") {
			this.onNew?.();
			return true;
		}
		if (key.name === "j" || key.name === "down") {
			if (this.cursor < this.categories.length - 1) {
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
		const selected = this.categories[this.cursor];
		if (
			(key.name === "e" || key.name === "return" || key.name === "enter") &&
			selected
		) {
			this.onEdit?.(selected);
			return true;
		}
		if (key.name === "d" && selected) {
			this.onDelete?.(selected);
			return true;
		}
		return true;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		if (this.isOpen) this.updatePosition();
	}

	private ensureCursorVisible(): void {
		if (this.cursor < this.scrollOffset) {
			this.scrollOffset = this.cursor;
		} else if (this.cursor >= this.scrollOffset + ROWS) {
			this.scrollOffset = this.cursor - ROWS + 1;
		}
	}

	private render(): void {
		const theme = getTheme();
		if (this.titleText) setText(this.titleText, "Manage categories");
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			const category = this.categories[this.scrollOffset + i];
			if (!row) continue;
			if (!category) {
				setText(
					row.text,
					i === 0 && this.categories.length === 0
						? `${" ".repeat(MARGIN)}No categories`
						: "",
				);
				setFg(row.text, theme.fgMuted);
				setBg(row.container, undefined);
				continue;
			}
			const selected = this.scrollOffset + i === this.cursor;
			setText(row.text, this.formatCategory(category));
			setFg(row.text, selected ? theme.fgPrimary : theme.fgSecondary);
			setBg(row.container, selected ? theme.bgTertiary : undefined);
		}
		if (this.hintText) {
			setText(this.hintText, "Enter/e edit  n new  d delete  Esc close");
		}
	}

	private formatCategory(category: CategoryState): string {
		const nameWidth = 18;
		const pathWidth = INNER_W - MARGIN * 2 - nameWidth - 1;
		const name = truncateRight(category.name, nameWidth);
		const path = category.savePath
			? abbreviateHomePath(category.savePath)
			: "no default path";
		return `${" ".repeat(MARGIN)}${name.padEnd(nameWidth)} ${truncateMiddle(path, pathWidth)}`;
	}

	private updatePosition(): void {
		if (!this.container) return;
		this.container.left = Math.max(
			0,
			Math.floor((this.layout.terminal.width - DIALOG_WIDTH) / 2),
		);
		this.container.top = Math.max(
			0,
			Math.floor((this.layout.terminal.height - DIALOG_HEIGHT) / 2),
		);
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
			backgroundColor: theme.bgPrimary,
			visible: false,
			flexDirection: "column",
		});
		const titleRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		this.titleText = new TextRenderable(this.renderer, {
			content: "",
			fg: theme.accent,
		});
		titleRow.add(this.titleText);
		container.add(titleRow);
		container.add(new BoxRenderable(this.renderer, { height: 1 }));
		for (let i = 0; i < ROWS; i++) {
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
			this.rows.push({ container: rowContainer, text });
		}
		container.add(new BoxRenderable(this.renderer, { flexGrow: 1 }));
		const hintRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		this.hintText = new TextRenderable(this.renderer, {
			content: "",
			fg: theme.fgMuted,
		});
		hintRow.add(this.hintText);
		container.add(hintRow);
		this.renderer.root.add(container);
		this.container = container;
	}
}
