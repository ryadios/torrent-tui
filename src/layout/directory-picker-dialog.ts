import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { resolvePath } from "../utils/paths";

const DIALOG_WIDTH = 68;
const DIALOG_HEIGHT = 22;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;
const LIST_ROWS = 13;
const ROOT_DIRECTORY = normalize(homedir());

interface DirectoryRow {
	container: BoxRenderable;
	text: TextRenderable;
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	const left = Math.floor((max - 1) / 2);
	const right = max - 1 - left;
	return `${text.slice(0, left)}…${text.slice(-right)}`;
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

export class DirectoryPickerDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable | null = null;
	private titleText: TextRenderable | null = null;
	private pathText: TextRenderable | null = null;
	private hintText: TextRenderable | null = null;
	private rows: DirectoryRow[] = [];
	private isOpen = false;
	private currentPath = "";
	private entries: string[] = [];
	private cursor = 0;
	private scrollOffset = 0;
	private creatingFolder = false;
	private folderName = "";
	private errorMessage = "";

	onCancel?: () => void;
	onSelect?: (path: string) => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
		this.createElements();
	}

	open(initialPath: string, title = "Choose directory"): void {
		this.isOpen = true;
		this.creatingFolder = false;
		this.folderName = "";
		this.errorMessage = "";
		this.currentPath = nearestExistingDirectory(resolvePath(initialPath));
		this.cursor = 0;
		this.scrollOffset = 0;
		if (this.titleText) setText(this.titleText, title);
		this.refreshEntries();
		this.updatePosition();
		this.render();
		if (this.container) this.container.visible = true;
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.creatingFolder = false;
		this.folderName = "";
		if (this.container) this.container.visible = false;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	handleInput(key: KeyEvent): boolean {
		if (!this.isOpen) return false;
		if (this.creatingFolder) return this.handleFolderNameInput(key);

		if (key.name === "escape") {
			this.close();
			this.onCancel?.();
			return true;
		}
		if (key.name === "space") {
			const selected = this.currentPath;
			this.close();
			this.onSelect?.(selected);
			return true;
		}
		if (key.name === "backspace" || key.name === "left") {
			if (this.currentPath !== ROOT_DIRECTORY) {
				this.openPath(dirname(this.currentPath));
			}
			return true;
		}
		if (key.name === "n") {
			this.creatingFolder = true;
			this.folderName = "";
			this.render();
			return true;
		}
		if (key.name === "j" || key.name === "down") {
			if (this.cursor < this.entries.length - 1) {
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
			const next = this.entries[this.cursor];
			if (next) this.openPath(next);
			return true;
		}
		return false;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		if (this.isOpen) this.updatePosition();
	}

	private handleFolderNameInput(key: KeyEvent): boolean {
		if (key.name === "escape") {
			this.creatingFolder = false;
			this.folderName = "";
			this.render();
			return true;
		}
		if (key.name === "backspace") {
			this.folderName = this.folderName.slice(0, -1);
			this.render();
			return true;
		}
		if (key.name === "return" || key.name === "enter") {
			const name = this.folderName.trim();
			if (name.length > 0 && !name.includes("/")) {
				const nextPath = join(this.currentPath, name);
				try {
					mkdirSync(nextPath, { recursive: true });
					this.creatingFolder = false;
					this.folderName = "";
					this.openPath(nextPath);
				} catch (err) {
					this.errorMessage = err instanceof Error ? err.message : String(err);
					this.render();
				}
			}
			return true;
		}
		const char = charFromKey(key);
		if (char) {
			this.folderName += char;
			this.render();
		}
		return true;
	}

	private openPath(path: string): void {
		this.currentPath = nearestExistingDirectory(path);
		this.cursor = 0;
		this.scrollOffset = 0;
		this.refreshEntries();
		this.render();
	}

	private refreshEntries(): void {
		this.errorMessage = "";
		try {
			const children = readdirSync(this.currentPath)
				.map((name) => join(this.currentPath, name))
				.filter((path) => {
					try {
						return statSync(path).isDirectory();
					} catch {
						return false;
					}
				})
				.sort((a, b) => a.localeCompare(b));
			const parent = dirname(this.currentPath);
			this.entries =
				this.currentPath === ROOT_DIRECTORY || parent === this.currentPath
					? children
					: [parent, ...children];
		} catch (err) {
			this.entries =
				this.currentPath === ROOT_DIRECTORY ? [] : [dirname(this.currentPath)];
			this.errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	private ensureCursorVisible(): void {
		if (this.cursor < this.scrollOffset) {
			this.scrollOffset = this.cursor;
		} else if (this.cursor >= this.scrollOffset + LIST_ROWS) {
			this.scrollOffset = this.cursor - LIST_ROWS + 1;
		}
	}

	private render(): void {
		const theme = getTheme();
		const pathWidth = INNER_W - MARGIN * 2;
		if (this.pathText) {
			setText(this.pathText, truncateMiddle(this.currentPath, pathWidth));
		}
		if (this.hintText) {
			const content = this.creatingFolder
				? `New folder: ${this.folderName}█`
				: this.errorMessage ||
					"Enter open  Space choose  Backspace parent  n new  Esc cancel";
			setText(this.hintText, truncateMiddle(content, pathWidth));
			setFg(this.hintText, this.errorMessage ? theme.error : theme.fgMuted);
		}

		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			const entry = this.entries[this.scrollOffset + i];
			if (!row) continue;
			if (!entry) {
				setText(row.text, "");
				setBg(row.container, undefined);
				continue;
			}
			const selected = this.scrollOffset + i === this.cursor;
			const parent = entry === dirname(this.currentPath);
			const name = parent
				? ".."
				: (entry.split("/").filter(Boolean).pop() ?? entry);
			setText(
				row.text,
				`${" ".repeat(MARGIN)}${truncateMiddle(name, pathWidth)}`,
			);
			setFg(row.text, selected ? theme.fgPrimary : theme.fgSecondary);
			setBg(row.container, selected ? theme.bgTertiary : undefined);
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

		const titleRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		this.titleText = new TextRenderable(this.renderer, {
			content: "Choose directory",
			fg: theme.accent,
		});
		titleRow.add(this.titleText);
		container.add(titleRow);

		const pathRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
			marginTop: 1,
		});
		this.pathText = new TextRenderable(this.renderer, {
			content: "",
			fg: theme.fgPrimary,
		});
		pathRow.add(this.pathText);
		container.add(pathRow);

		container.add(new BoxRenderable(this.renderer, { height: 1 }));
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

function nearestExistingDirectory(path: string): string {
	let current = normalize(path || ROOT_DIRECTORY);
	if (!isWithinRoot(current)) return ROOT_DIRECTORY;
	while (!existsSync(current) || !statSync(current).isDirectory()) {
		const parent = dirname(current);
		if (parent === current || !isWithinRoot(parent)) return ROOT_DIRECTORY;
		current = parent;
	}
	return current;
}

function isWithinRoot(path: string): boolean {
	const normalized = normalize(path);
	const rel = relative(ROOT_DIRECTORY, normalized);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function charFromKey(key: KeyEvent): string {
	if (key.ctrl || key.meta) return "";
	if (key.name === "space") return " ";
	if (key.name.length !== 1) return "";
	if (key.shift && /^[a-z]$/.test(key.name)) return key.name.toUpperCase();
	return key.name;
}
