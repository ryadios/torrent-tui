import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { resolvePath } from "../utils/paths";

const DIALOG_WIDTH = 62;
const DIALOG_HEIGHT = 12;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;

export interface CategoryDialogResult {
	name: string;
	savePath: string | null;
}

export interface CategoryDialogOpenOptions {
	name?: string;
	savePath?: string | null;
	title?: string;
}

function setText(node: TextRenderable, content: string): void {
	(node as unknown as { content: string }).content = content;
}

function setFg(node: TextRenderable, fg: string): void {
	(node as unknown as { fg: string }).fg = fg;
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	const left = Math.floor((max - 1) / 2);
	const right = max - 1 - left;
	return `${text.slice(0, left)}…${text.slice(-right)}`;
}

export class CategoryDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable | null = null;
	private titleText: TextRenderable | null = null;
	private nameText: TextRenderable | null = null;
	private pathText: TextRenderable | null = null;
	private hintText: TextRenderable | null = null;
	private isOpen = false;
	private name = "";
	private savePath: string | null = null;
	private initialBrowsePath = "";
	private title = "New category";

	onBrowse?: (initialPath: string) => void;
	onCancel?: () => void;
	onConfirm?: (result: CategoryDialogResult) => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.createElements();
	}

	open(
		initialBrowsePath: string,
		options: CategoryDialogOpenOptions = {},
	): void {
		this.isOpen = true;
		this.name = options.name ?? "";
		this.savePath = options.savePath ? resolvePath(options.savePath) : null;
		this.title = options.title ?? "New category";
		this.initialBrowsePath = resolvePath(initialBrowsePath);
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

	setSavePath(path: string): void {
		this.savePath = resolvePath(path);
		this.render();
	}

	handleInput(key: KeyEvent): boolean {
		if (!this.isOpen) return false;
		if (key.name === "escape") {
			this.close();
			this.onCancel?.();
			return true;
		}
		if (key.name === "backspace") {
			this.name = this.name.slice(0, -1);
			this.render();
			return true;
		}
		if (key.name === "b") {
			this.onBrowse?.(this.savePath ?? this.initialBrowsePath);
			return true;
		}
		if (key.name === "x") {
			this.savePath = null;
			this.render();
			return true;
		}
		if (key.name === "return" || key.name === "enter") {
			const name = this.name.trim();
			if (name.length === 0) return true;
			const savePath = this.savePath;
			this.close();
			this.onConfirm?.({ name, savePath });
			return true;
		}
		const char = charFromKey(key);
		if (char) {
			this.name += char;
			this.render();
		}
		return true;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		if (this.isOpen) this.updatePosition();
	}

	private render(): void {
		const theme = getTheme();
		if (this.titleText) setText(this.titleText, this.title);
		if (this.nameText) {
			setText(this.nameText, `Name: ${this.name}█`);
			setFg(this.nameText, theme.accent);
		}
		if (this.pathText) {
			const path = this.savePath
				? truncateMiddle(this.savePath, INNER_W - 10)
				: "none";
			setText(this.pathText, `Path: ${path}`);
			setFg(this.pathText, this.savePath ? theme.fgPrimary : theme.fgMuted);
		}
		if (this.hintText) {
			setText(
				this.hintText,
				"b browse path  x clear path  Enter save  Esc cancel",
			);
		}
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
		for (const [index, assign] of [
			[0, (text: TextRenderable) => (this.titleText = text)],
			[2, (text: TextRenderable) => (this.nameText = text)],
			[4, (text: TextRenderable) => (this.pathText = text)],
			[8, (text: TextRenderable) => (this.hintText = text)],
		] as const) {
			const row = new BoxRenderable(this.renderer, {
				width: INNER_W,
				height: 1,
				paddingLeft: MARGIN,
				paddingRight: MARGIN,
				marginTop: index === 0 ? 0 : 1,
			});
			const text = new TextRenderable(this.renderer, {
				content: "",
				fg: index === 0 ? theme.accent : theme.fgPrimary,
			});
			assign(text);
			row.add(text);
			container.add(row);
		}
		this.renderer.root.add(container);
		this.container = container;
	}
}

function charFromKey(key: KeyEvent): string {
	if (key.ctrl || key.meta) return "";
	if (key.name === "space") return " ";
	if (key.name.length !== 1) return "";
	if (key.shift && /^[a-z]$/.test(key.name)) return key.name.toUpperCase();
	return key.name;
}
