import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	type PasteEvent,
	TextareaRenderable,
	TextRenderable,
} from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { resolvePath } from "../utils/paths";

const DIALOG_WIDTH = 60;
const DIALOG_HEIGHT = 22;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;
const MAGNET_LABEL = "Magnet:";
const MAGNET_INPUT_HEIGHT = 5;
type DialogFocus = "files" | "magnet";

function truncateName(name: string): string {
	const max = INNER_W - MARGIN * 2;
	return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

const TAB_INDICATOR = "Tab: switch tabs";

function truncateMiddle(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	if (maxLen <= 1) return "…";
	const half = Math.floor((maxLen - 1) / 2);
	const tail = maxLen - 1 - half;
	return `${text.slice(0, half)}…${text.slice(-tail)}`;
}

function shortenPath(fullPath: string, maxLen: number): string {
	const normalizedPath = normalize(fullPath);
	const normalizedHome = normalize(homedir());
	const isHome = normalizedPath === normalizedHome;
	const isInsideHome = normalizedPath.startsWith(`${normalizedHome}${sep}`);
	const short =
		isHome || isInsideHome
			? `~${normalizedPath.slice(normalizedHome.length)}`
			: normalizedPath;
	return truncateMiddle(short, maxLen);
}

function setBg(node: BoxRenderable, bg: string | undefined): void {
	(node as unknown as { backgroundColor: string | undefined }).backgroundColor =
		bg;
}

export class AddTorrentDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private torrentFolder: string;
	private container: BoxRenderable | null = null;
	private isOpen = false;
	private files: Array<{ name: string; path: string }> = [];
	private selectedIndex = 0;
	private focus: DialogFocus = "files";
	private itemRows: BoxRenderable[] = [];
	private itemTextNodes: TextRenderable[] = [];
	private input: TextareaRenderable | null = null;
	private tabBarText: TextRenderable | null = null;
	private filesSection: BoxRenderable | null = null;
	private magnetSection: BoxRenderable | null = null;
	private titleRow: BoxRenderable | null = null;
	private tabBarRow: BoxRenderable | null = null;
	private folderHintRow: BoxRenderable | null = null;
	private folderPathText: TextRenderable | null = null;

	onSelect?: (input: string) => void;

	constructor(
		renderer: CliRenderer,
		layout: LayoutDimensions,
		torrentFolder: string,
	) {
		this.renderer = renderer;
		this.layout = layout;
		this.torrentFolder = resolvePath(torrentFolder);
		this.createElements();
		this.update();
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.selectedIndex = 0;
		this.focus = "files";
		this.files = this.scanTorrentFiles();
		this.input?.setText("");
		this.input?.gotoBufferHome();
		this.refreshFiles();
		this.update();
		if (this.container) this.container.visible = true;
		this.updateFocus();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.input?.blur();
		this.renderer.setCursorPosition(0, 0, false);
		if (this.container) this.container.visible = false;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	handleInput(key: KeyEvent): boolean {
		if (!this.isOpen) return false;
		const keyName = key.name;

		if (keyName === "tab") {
			this.focus = this.focus === "files" ? "magnet" : "files";
			this.updateFocus();
			return true;
		}

		if (this.focus === "magnet") {
			this.input?.handleKeyPress(key);
			return true;
		}

		if (keyName === "j" || keyName === "down") {
			if (this.selectedIndex < this.files.length - 1) {
				this.selectedIndex++;
				this.updateHighlight();
			}
			return true;
		}
		if (keyName === "k" || keyName === "up") {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.updateHighlight();
			}
			return true;
		}
		if (keyName === "return") {
			const file = this.files[this.selectedIndex];
			if (file) {
				const path = file.path;
				this.close();
				this.onSelect?.(path);
			}
			return true;
		}
		return false;
	}

	handlePaste(event: PasteEvent): boolean {
		if (!this.isOpen) return false;
		this.focus = "magnet";
		this.updateFocus();
		this.input?.handlePaste(event);
		return true;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		if (this.isOpen) this.update();
	}

	update(): void {
		const left = Math.max(
			0,
			Math.floor((this.layout.terminal.width - DIALOG_WIDTH) / 2),
		);
		const top = Math.max(
			0,
			Math.floor((this.layout.terminal.height - DIALOG_HEIGHT) / 2),
		);

		if (this.container) {
			this.container.left = left;
			this.container.top = top;
			this.container.width = DIALOG_WIDTH;
			this.container.height = DIALOG_HEIGHT;
		}
		if (this.titleRow) this.titleRow.width = INNER_W;
		if (this.tabBarRow) this.tabBarRow.width = INNER_W;
		if (this.filesSection) this.filesSection.width = INNER_W;
		if (this.magnetSection) this.magnetSection.width = INNER_W;
		if (this.input) {
			this.input.width = INNER_W - MARGIN * 2;
			this.input.height = MAGNET_INPUT_HEIGHT;
		}
		if (this.folderHintRow) this.folderHintRow.width = INNER_W;
		if (this.folderPathText) {
			const maxPathLen = INNER_W - MARGIN * 2 - TAB_INDICATOR.length - 2;
			this.folderPathText.content = shortenPath(this.torrentFolder, maxPathLen);
		}
	}

	private updateHighlight(): void {
		const theme = getTheme();
		for (let i = 0; i < this.itemRows.length; i++) {
			const row = this.itemRows[i];
			const text = this.itemTextNodes[i];
			if (!row || !text) continue;
			const isSelected = this.focus === "files" && i === this.selectedIndex;
			setBg(row, isSelected ? theme.bgTertiary : undefined);
			text.fg = isSelected ? theme.fgPrimary : theme.fgSecondary;
		}
	}

	private updateFocus(): void {
		const theme = getTheme();
		if (this.tabBarText) {
			this.tabBarText.content = this.formatTabs();
		}
		if (this.filesSection) {
			this.filesSection.visible = this.focus === "files";
		}
		if (this.magnetSection) {
			this.magnetSection.visible = this.focus === "magnet";
		}
		if (this.folderPathText) {
			this.folderPathText.visible = this.focus === "files";
		}
		if (this.input) {
			if (this.focus === "magnet") {
				this.input.focus();
			} else {
				this.input.blur();
			}
			this.input.backgroundColor =
				this.focus === "magnet" ? theme.bgTertiary : undefined;
		}
		this.updateHighlight();
	}

	private submitMagnet(): void {
		const value = this.input?.plainText.replace(/[\r\n]/g, "").trim() ?? "";
		if (value.length === 0) return;
		this.close();
		this.onSelect?.(value);
	}

	private formatTabs(): string {
		const tabs = (["Files", "Magnet"] as const)
			.map((tab) => {
				const active =
					tab === "Files" ? this.focus === "files" : this.focus === "magnet";
				return active ? `[${tab}]` : ` ${tab} `;
			})
			.join("  ");
		return `─ ${tabs}`;
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
				content: "Add Torrent",
				fg: theme.accent,
			}),
		);
		titleRow.add(
			new TextRenderable(this.renderer, {
				content: "Esc to close",
				fg: theme.fgMuted,
			}),
		);
		container.add(titleRow);
		this.titleRow = titleRow;

		// Tab bar
		const tabBarRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
			marginTop: 2,
		});
		this.tabBarText = new TextRenderable(this.renderer, {
			content: this.formatTabs(),
			fg: theme.accent,
		});
		tabBarRow.add(this.tabBarText);
		container.add(tabBarRow);
		this.tabBarRow = tabBarRow;

		// Files section
		this.filesSection = new BoxRenderable(this.renderer, {
			width: INNER_W,
			flexDirection: "column",
			marginTop: 1,
		});
		container.add(this.filesSection);

		// Magnet section
		this.magnetSection = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: MAGNET_INPUT_HEIGHT + 2,
			flexDirection: "column",
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
			marginTop: 1,
		});
		this.magnetSection.add(
			new TextRenderable(this.renderer, {
				content: MAGNET_LABEL,
				fg: theme.fgSecondary,
			}),
		);
		this.input = new TextareaRenderable(this.renderer, {
			width: INNER_W - MARGIN * 2,
			height: MAGNET_INPUT_HEIGHT,
			wrapMode: "char",
			placeholder: "paste or type magnet URI",
			textColor: theme.fgPrimary,
			backgroundColor: theme.bgTertiary,
			focusedBackgroundColor: theme.bgTertiary,
			placeholderColor: theme.fgMuted,
			keyBindings: [
				{ name: "return", action: "submit" },
				{ name: "linefeed", action: "submit" },
			],
			onSubmit: () => this.submitMagnet(),
		});
		this.magnetSection.add(this.input);
		container.add(this.magnetSection);

		container.add(new BoxRenderable(this.renderer, { flexGrow: 1 }));

		// Bottom bar: folder path (left, Files tab only) + tab indicator (right, always)
		this.folderHintRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			flexDirection: "row",
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		const maxPathLen = INNER_W - MARGIN * 2 - TAB_INDICATOR.length - 2;
		this.folderPathText = new TextRenderable(this.renderer, {
			content: shortenPath(this.torrentFolder, maxPathLen),
			fg: theme.fgMuted,
		});
		this.folderHintRow.add(this.folderPathText);
		const tabIndicatorBox = new BoxRenderable(this.renderer, {
			marginLeft: "auto",
		});
		tabIndicatorBox.add(
			new TextRenderable(this.renderer, {
				content: TAB_INDICATOR,
				fg: theme.fgMuted,
			}),
		);
		this.folderHintRow.add(tabIndicatorBox);
		container.add(this.folderHintRow);

		this.renderer.root.add(container);
		this.container = container;
		this.refreshFiles();
	}

	private refreshFiles(): void {
		const theme = getTheme();
		for (const row of this.itemRows) row.destroy();
		this.itemRows = [];
		this.itemTextNodes = [];
		if (!this.filesSection) return;
		if (this.files.length === 0) {
			const row = new BoxRenderable(this.renderer, {
				width: INNER_W,
				height: 1,
			});
			row.add(
				new TextRenderable(this.renderer, {
					content: `${" ".repeat(MARGIN)}No .torrent files in ${this.torrentFolder}`,
					fg: theme.fgMuted,
				}),
			);
			this.filesSection.add(row);
			this.itemRows.push(row);
			return;
		}
		for (const file of this.files) {
			const row = new BoxRenderable(this.renderer, {
				width: INNER_W,
				height: 1,
			});
			const text = new TextRenderable(this.renderer, {
				content: " ".repeat(MARGIN) + truncateName(file.name),
				fg: theme.fgSecondary,
			});
			row.add(text);
			this.filesSection.add(row);
			this.itemRows.push(row);
			this.itemTextNodes.push(text);
		}
	}

	private scanTorrentFiles(): Array<{ name: string; path: string }> {
		if (!existsSync(this.torrentFolder)) return [];
		try {
			return readdirSync(this.torrentFolder)
				.filter((f) => f.toLowerCase().endsWith(".torrent"))
				.map((f) => ({ name: f, path: join(this.torrentFolder, f) }));
		} catch {
			return [];
		}
	}
}
