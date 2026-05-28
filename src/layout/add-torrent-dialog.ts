import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { resolvePath } from "../utils/paths";

const DIALOG_WIDTH = 60;
const DIALOG_HEIGHT = 16;
const INNER_W = DIALOG_WIDTH - 2;
const MARGIN = 2;

function truncateName(name: string): string {
	const max = INNER_W - MARGIN * 2;
	return name.length > max ? `${name.slice(0, max - 1)}…` : name;
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
	private itemRows: BoxRenderable[] = [];

	onSelect?: (filePath: string) => void;

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
		this.files = this.scanTorrentFiles();
		this.build();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.container?.destroy();
		this.container = null;
		this.itemRows = [];
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	handleInput(key: string): boolean {
		if (!this.isOpen) return false;

		if (key === "j" || key === "down") {
			if (this.selectedIndex < this.files.length - 1) {
				this.selectedIndex++;
				this.updateHighlight();
			}
			return true;
		}
		if (key === "k" || key === "up") {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.updateHighlight();
			}
			return true;
		}
		if (key === "return") {
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

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
	}

	private updateHighlight(): void {
		const theme = getTheme();
		for (let i = 0; i < this.itemRows.length; i++) {
			setBg(
				this.itemRows[i]!,
				i === this.selectedIndex ? theme.bgTertiary : undefined,
			);
		}
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
			borderColor: theme.border,
			flexDirection: "column",
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

		// Spacer
		container.add(new TextRenderable(this.renderer, { content: "" }));

		this.itemRows = [];

		if (this.files.length === 0) {
			container.add(
				new TextRenderable(this.renderer, {
					content: `${" ".repeat(MARGIN)}No .torrent files in ${this.torrentFolder}`,
					fg: theme.fgMuted,
				}),
			);
		} else {
			for (let i = 0; i < this.files.length; i++) {
				const file = this.files[i]!;
				const row = new BoxRenderable(this.renderer, {
					width: INNER_W,
					height: 1,
					backgroundColor:
						i === this.selectedIndex ? theme.bgTertiary : undefined,
				});
				row.add(
					new TextRenderable(this.renderer, {
						content: " ".repeat(MARGIN) + truncateName(file.name),
						fg: i === this.selectedIndex ? theme.fgPrimary : theme.fgSecondary,
					}),
				);
				container.add(row);
				this.itemRows.push(row);
			}
		}

		this.renderer.root.add(container);
		this.container = container;
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
