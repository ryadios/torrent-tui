import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	BoxRenderable,
	type CliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	type PasteEvent,
	TextRenderable,
} from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { resolvePath } from "../utils/paths";

const DIALOG_WIDTH = 60;
const DIALOG_HEIGHT = 17;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;
const MAGNET_LABEL = "Magnet:";
type DialogFocus = "files" | "magnet";

function truncateName(name: string): string {
	const max = INNER_W - MARGIN * 2;
	return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function shortenPath(fullPath: string, maxLen: number): string {
	const home = homedir();
	const short = fullPath.startsWith(home)
		? `~${fullPath.slice(home.length)}`
		: fullPath;
	return short.length > maxLen ? `…${short.slice(-(maxLen - 1))}` : short;
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
	private input: InputRenderable | null = null;
	private tabBarText: TextRenderable | null = null;
	private filesSection: BoxRenderable | null = null;
	private magnetSection: BoxRenderable | null = null;
	private folderHintRow: BoxRenderable | null = null;

	onSelect?: (input: string) => void;

	constructor(
		renderer: CliRenderer,
		layout: LayoutDimensions,
		torrentFolder: string,
	) {
		this.renderer = renderer;
		this.layout = layout;
		this.torrentFolder = resolvePath(torrentFolder);
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.selectedIndex = 0;
		this.focus = "files";
		this.files = this.scanTorrentFiles();
		this.build();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.input?.blur();
		this.input?.destroy();
		this.renderer.setCursorPosition(0, 0, false);
		this.container?.destroy();
		this.container = null;
		this.itemRows = [];
		this.itemTextNodes = [];
		this.input = null;
		this.tabBarText = null;
		this.filesSection = null;
		this.magnetSection = null;
		this.folderHintRow = null;
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
		if (this.folderHintRow) {
			this.folderHintRow.visible = this.focus === "files";
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
		const value = this.input?.value.trim() ?? "";
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

	private build(): void {
		const theme = getTheme();
		const left = Math.max(
			0,
			Math.floor((this.layout.terminal.width - DIALOG_WIDTH) / 2),
		);
		const top = Math.max(
			0,
			Math.floor((this.layout.terminal.height - DIALOG_HEIGHT) / 2),
		);

		const container = new BoxRenderable(this.renderer, {
			position: "absolute",
			left,
			top,
			width: DIALOG_WIDTH,
			height: DIALOG_HEIGHT,
			border: true,
			borderStyle: "single",
			borderColor: theme.accent,
			flexDirection: "column",
			backgroundColor: theme.bgPrimary,
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

		// Tab bar
		const tabBarRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
			marginTop: 1,
		});
		this.tabBarText = new TextRenderable(this.renderer, {
			content: this.formatTabs(),
			fg: theme.accent,
		});
		tabBarRow.add(this.tabBarText);
		container.add(tabBarRow);

		// Files section
		this.filesSection = new BoxRenderable(this.renderer, {
			width: INNER_W,
			flexDirection: "column",
			marginTop: 1,
		});
		this.itemRows = [];
		this.itemTextNodes = [];
		if (this.files.length === 0) {
			this.filesSection.add(
				new TextRenderable(this.renderer, {
					content: `${" ".repeat(MARGIN)}No .torrent files in ${this.torrentFolder}`,
					fg: theme.fgMuted,
				}),
			);
		} else {
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
		container.add(this.filesSection);

		// Magnet section
		this.magnetSection = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			flexDirection: "row",
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
			marginTop: 1,
		});
		this.magnetSection.add(
			new TextRenderable(this.renderer, {
				content: `${MAGNET_LABEL} `,
				fg: theme.fgSecondary,
			}),
		);
		this.input = new InputRenderable(this.renderer, {
			width: INNER_W - MARGIN * 2 - MAGNET_LABEL.length - 1,
			placeholder: "paste or type magnet URI",
			textColor: theme.fgPrimary,
			backgroundColor: theme.bgTertiary,
			focusedBackgroundColor: theme.bgTertiary,
			placeholderColor: theme.fgMuted,
		});
		this.input.on(InputRenderableEvents.ENTER, () => this.submitMagnet());
		this.magnetSection.add(this.input);
		container.add(this.magnetSection);

		container.add(new BoxRenderable(this.renderer, { flexGrow: 1 }));

		// Folder hint — shown at the bottom of the Files tab
		this.folderHintRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		const maxPathLen = INNER_W - MARGIN * 2;
		this.folderHintRow.add(
			new TextRenderable(this.renderer, {
				content: shortenPath(this.torrentFolder, maxPathLen),
				fg: theme.fgMuted,
			}),
		);
		container.add(this.folderHintRow);

		this.renderer.root.add(container);
		this.container = container;
		this.updateFocus();
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
