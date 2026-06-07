import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

const DIALOG_WIDTH = 38;
const DIALOG_HEIGHT = 7;

export class ConfirmDialog {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private container: BoxRenderable | null = null;
	private confirmBtn: TextRenderable | null = null;
	private cancelBtn: TextRenderable | null = null;
	private isOpen = false;
	private focusedBtn: "confirm" | "cancel" = "cancel";

	onConfirm?: () => void;
	onCancel?: () => void;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;
	}

	open(message: string, detail = "Files will be deleted from disk."): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.focusedBtn = "cancel";
		this.build(message, detail);
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.container?.destroy();
		this.container = null;
		this.confirmBtn = null;
		this.cancelBtn = null;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	handleInput(key: string): boolean {
		if (!this.isOpen) return false;
		if (
			key === "tab" ||
			key === "h" ||
			key === "l" ||
			key === "left" ||
			key === "right"
		) {
			this.focusedBtn = this.focusedBtn === "confirm" ? "cancel" : "confirm";
			this.updateButtons();
			return true;
		}
		if (key === "return" || key === "y") {
			if (key === "y" || this.focusedBtn === "confirm") {
				this.close();
				this.onConfirm?.();
				return true;
			}
			this.close();
			this.onCancel?.();
			return true;
		}
		if (key === "n" || key === "escape") {
			this.close();
			this.onCancel?.();
			return true;
		}
		return true;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
	}

	private updateButtons(): void {
		const theme = getTheme();
		if (this.confirmBtn) {
			(this.confirmBtn as unknown as { fg: string }).fg =
				this.focusedBtn === "confirm" ? theme.error : theme.fgMuted;
		}
		if (this.cancelBtn) {
			(this.cancelBtn as unknown as { fg: string }).fg =
				this.focusedBtn === "cancel" ? theme.accent : theme.fgMuted;
		}
	}

	private build(message: string, detail: string): void {
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
			borderColor: theme.warning,
			flexDirection: "column",
		});

		const inner = DIALOG_WIDTH - 2;

		container.add(
			new TextRenderable(this.renderer, { content: " ".repeat(inner) }),
		);
		container.add(
			new TextRenderable(this.renderer, {
				content: `  ${message}`.padEnd(inner),
				fg: theme.fgPrimary,
			}),
		);
		container.add(
			new TextRenderable(this.renderer, { content: " ".repeat(inner) }),
		);
		container.add(
			new TextRenderable(this.renderer, {
				content: `  ${detail}`.padEnd(inner),
				fg: theme.fgSecondary,
			}),
		);
		container.add(
			new TextRenderable(this.renderer, { content: " ".repeat(inner) }),
		);

		const btnRow = new BoxRenderable(this.renderer, {
			width: inner,
			height: 1,
			flexDirection: "row",
			justifyContent: "space-between",
			paddingLeft: 2,
			paddingRight: 2,
		});

		this.confirmBtn = new TextRenderable(this.renderer, {
			content: "[y] Confirm",
			fg: theme.fgMuted,
		});
		this.cancelBtn = new TextRenderable(this.renderer, {
			content: "[n] Cancel",
			fg: theme.accent,
		});

		btnRow.add(this.confirmBtn);
		btnRow.add(this.cancelBtn);
		container.add(btnRow);

		this.renderer.root.add(container);
		this.container = container;
	}
}
