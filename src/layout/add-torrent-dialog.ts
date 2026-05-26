import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	BoxRenderable,
	type CliRenderer,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
} from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";
import { resolvePath } from "../utils/paths";

const DIALOG_WIDTH  = 60;
const DIALOG_HEIGHT = 16;
const INNER_W       = DIALOG_WIDTH - 2; // inside border
const MARGIN        = 2;                // left = right margin inside dialog

function truncateName(name: string): string {
	const max = INNER_W - MARGIN * 2;
	return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

export class AddTorrentDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private torrentFolder: string;
	private container: BoxRenderable | null = null;
	private isOpen = false;

	onSelect?: (filePath: string) => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions, torrentFolder: string) {
		this.renderer = renderer;
		this.layout = layout;
		this.torrentFolder = resolvePath(torrentFolder);
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.build();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.container?.destroy();
		this.container = null;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
	}

	private build(): void {
		const theme = getTheme();
		const left = Math.max(0, Math.floor((this.layout.terminal.width  - DIALOG_WIDTH)  / 2));
		const top  = Math.max(0, Math.floor((this.layout.terminal.height - DIALOG_HEIGHT) / 2));

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

		// Title row: left-aligned label + right-aligned hint, equal margins
		const titleRow = new BoxRenderable(this.renderer, {
			width: INNER_W,
			height: 1,
			flexDirection: "row",
			justifyContent: "space-between",
			paddingLeft: MARGIN,
			paddingRight: MARGIN,
		});
		titleRow.add(new TextRenderable(this.renderer, { content: "Add Torrent", fg: theme.accent }));
		titleRow.add(new TextRenderable(this.renderer, { content: "Esc to close", fg: theme.fgMuted }));

		// Blank spacer below title
		const spacer = new TextRenderable(this.renderer, { content: "" });

		container.add(titleRow);
		container.add(spacer);

		const files = this.scanTorrentFiles();

		if (files.length === 0) {
			container.add(new TextRenderable(this.renderer, {
				content: " ".repeat(MARGIN) + `No .torrent files in ${this.torrentFolder}`,
				fg: theme.fgMuted,
			}));
		} else {
			const paths = files.map((f) => f.path);
			const displayNames = files.map((f) => " ".repeat(MARGIN) + truncateName(f.name));

			const select = new SelectRenderable(this.renderer, {
				width: INNER_W,
				height: DIALOG_HEIGHT - 4,
				options: displayNames.map((name) => ({ name, description: "" })),
				selectedBackgroundColor: theme.bgTertiary,
				selectedTextColor: theme.fgPrimary,
				textColor: theme.fgSecondary,
				showDescription: false,
			});

			select.on(SelectRenderableEvents.ITEM_SELECTED, (idx: number) => {
				const fullPath = paths[idx];
				if (!fullPath) return;
				this.close();
				this.onSelect?.(fullPath);
			});

			select.focus();
			container.add(select);
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
