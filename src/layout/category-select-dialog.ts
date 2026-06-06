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

const DIALOG_WIDTH = 48;
const DIALOG_HEIGHT = 16;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;
const ROWS = 9;

type CategorySelectMode = "add" | "reassign";

export interface CategorySelectOpenOptions {
	categories: CategoryState[];
	currentCategoryId?: string | null;
	defaultCategoryId?: string | null;
	globalDownloadPath?: string;
	mode: CategorySelectMode;
}

export interface CategorySelectOption {
	id: string | null;
	name: string;
	savePath: string | null;
}

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

function truncateRight(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	return `${text.slice(0, max - 1)}…`;
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	const left = Math.floor((max - 1) / 2);
	const right = max - 1 - left;
	return `${text.slice(0, left)}…${text.slice(-right)}`;
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

export class CategorySelectDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable | null = null;
	private titleText: TextRenderable | null = null;
	private hintText: TextRenderable | null = null;
	private rows: Row[] = [];
	private isOpen = false;
	private categories: CategoryState[] = [];
	private globalDownloadPath = "";
	private mode: CategorySelectMode = "reassign";
	private cursor = 0;
	private scrollOffset = 0;

	onCancel?: () => void;
	onNewCategory?: () => void;
	onSelect?: (category: CategorySelectOption | null) => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.createElements();
	}

	open(options: CategorySelectOpenOptions): void {
		this.isOpen = true;
		this.mode = options.mode;
		this.categories = options.categories;
		this.globalDownloadPath = options.globalDownloadPath ?? "";
		this.cursor = this.initialCursor(options);
		this.scrollOffset = 0;
		if (this.titleText) setText(this.titleText, "Select category");
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

	show(): void {
		if (!this.isOpen) return;
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
			this.onNewCategory?.();
			return true;
		}
		if (key.name === "b") {
			return true;
		}
		if (key.name === "j" || key.name === "down") {
			if (this.cursor < this.options().length - 1) {
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
		if (key.name === "return" || key.name === "enter") {
			const selected = this.options()[this.cursor];
			this.close();
			this.onSelect?.(selected?.id ? selected : null);
			return true;
		}
		return true;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		if (this.isOpen) this.updatePosition();
	}

	private options(): CategorySelectOption[] {
		return [
			{ id: null, name: "None", savePath: null },
			...this.categories.map((category) => ({
				id: category.id,
				name: category.name,
				savePath: category.savePath,
			})),
		];
	}

	private initialCursor(options: CategorySelectOpenOptions): number {
		const selectedId =
			options.mode === "add"
				? options.defaultCategoryId
				: options.currentCategoryId;
		if (!selectedId) return 0;
		const index = this.categories.findIndex(
			(category) => category.id === selectedId,
		);
		return index >= 0 ? index + 1 : 0;
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
		const options = this.options();
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			const option = options[this.scrollOffset + i];
			if (!row) continue;
			if (!option) {
				setText(row.text, "");
				setBg(row.container, undefined);
				continue;
			}
			const selected = this.scrollOffset + i === this.cursor;
			setText(row.text, this.formatOption(option));
			setFg(row.text, selected ? theme.fgPrimary : theme.fgSecondary);
			setBg(row.container, selected ? theme.bgTertiary : undefined);
		}
		if (this.hintText) {
			const hint =
				this.mode === "add"
					? "Enter choose  n new  Esc cancel"
					: "Enter apply  n new  Esc cancel";
			setText(this.hintText, hint);
		}
	}

	private formatOption(option: CategorySelectOption): string {
		const nameWidth = 16;
		const pathWidth = INNER_W - MARGIN * 2 - nameWidth - 1;
		const name = truncateRight(option.name, nameWidth);
		const path = this.optionPathLabel(option);
		return `${" ".repeat(MARGIN)}${name.padEnd(nameWidth)} ${truncateMiddle(path, pathWidth)}`;
	}

	private optionPathLabel(option: CategorySelectOption): string {
		if (this.mode === "add") {
			if (option.id === null)
				return this.globalDownloadPath
					? abbreviateHomePath(this.globalDownloadPath)
					: "global path";
			return option.savePath
				? abbreviateHomePath(option.savePath)
				: this.globalDownloadPath
					? abbreviateHomePath(this.globalDownloadPath)
					: "global path";
		}
		if (option.id === null) return "uncategorized";
		return option.savePath
			? abbreviateHomePath(option.savePath)
			: "no default path";
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
