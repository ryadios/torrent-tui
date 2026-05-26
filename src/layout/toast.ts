import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import {
	TOAST_DEFAULT_DURATION,
	TOAST_MARGIN,
	TOAST_WIDTH,
} from "../constants";
import { getTheme } from "../theme";
import type { LayoutDimensions } from "../types/layout";

export type ToastType = "info" | "success" | "warning" | "error" | "action";

export interface ToastConfig {
	id: string;
	type: ToastType;
	title: string;
	message: string;
	duration?: number | null;
	dismissable?: boolean;
	onDismiss?: () => void;
}

export class Toast {
	private renderer: CliRenderer;
	private config: ToastConfig;
	private x: number;
	private y: number;
	private height: number;

	private createdAt: number;
	private dismissed: boolean = false;
	private addedToRenderer: boolean = false;

	private layout: LayoutDimensions;
	private container: BoxRenderable;
	private titleLabel: TextRenderable;
	private messageLabel: TextRenderable;

	constructor(
		renderer: CliRenderer,
		config: ToastConfig,
		layout: LayoutDimensions,
		x: number,
		y: number,
	) {
		this.renderer = renderer;
		this.config = {
			dismissable: true,
			duration: TOAST_DEFAULT_DURATION,
			...config,
		};
		this.layout = layout;
		this.x = x;
		this.y = y;
		this.createdAt = Date.now();

		this.height = this.calculateHeight();
		this.container = this.createContainer();
		this.titleLabel = this.createTitleLabel();
		this.messageLabel = this.createMessageLabel();
	}

	private calculateHeight(): number {
		let height = 3;
		const maxLineWidth = TOAST_WIDTH - 4;
		const messageLines = this.wrapText(this.config.message, maxLineWidth);
		height += messageLines.length;
		return height;
	}

	private wrapText(text: string, maxWidth: number): string[] {
		const words = text.split(" ");
		const lines: string[] = [];
		let currentLine = "";

		for (const word of words) {
			const testLine = currentLine ? `${currentLine} ${word}` : word;
			if (testLine.length <= maxWidth) {
				currentLine = testLine;
			} else {
				if (currentLine) lines.push(currentLine);
				currentLine = word;
			}
		}
		if (currentLine) lines.push(currentLine);

		return lines;
	}

	private getBorderColor(): string {
		const theme = getTheme();
		switch (this.config.type) {
			case "info":
			case "action":
				return theme.accent;
			case "success":
				return theme.success;
			case "warning":
				return theme.warning;
			case "error":
				return theme.error;
		}
	}

	private getIcon(): string {
		switch (this.config.type) {
			case "info":
				return "i";
			case "success":
				return "+";
			case "warning":
				return "!";
			case "error":
				return "x";
			case "action":
				return ">";
		}
	}

	private createContainer(): BoxRenderable {
		const theme = getTheme();
		return new BoxRenderable(this.renderer, {
			position: "absolute",
			left: this.x,
			top: this.y,
			width: TOAST_WIDTH,
			height: this.height,
			borderColor: this.getBorderColor(),
			borderStyle: "single",
			backgroundColor: theme.bgPrimary,
		});
	}

	private createTitleLabel(): TextRenderable {
		const _theme = getTheme();
		const icon = this.getIcon();
		return new TextRenderable(this.renderer, {
			content: `${icon} ${this.config.title}`,
			fg: this.getBorderColor(),
			position: "absolute",
			left: this.x + 2,
			top: this.y + 1,
		});
	}

	private createMessageLabel(): TextRenderable {
		const theme = getTheme();
		const messageLines = this.wrapText(this.config.message, TOAST_WIDTH - 4);
		const messageContent = messageLines.join("\n");
		return new TextRenderable(this.renderer, {
			content: messageContent,
			fg: theme.fgPrimary,
			position: "absolute",
			left: this.x + 2,
			top: this.y + 2,
		});
	}

	shouldAutoDismiss(): boolean {
		if (this.config.duration === null || this.config.duration === undefined) {
			return false;
		}
		return Date.now() - this.createdAt >= this.config.duration;
	}

	addToRenderer(): void {
		if (this.addedToRenderer || this.dismissed) return;

		this.renderer.root.add(this.container);
		this.renderer.root.add(this.titleLabel);
		this.renderer.root.add(this.messageLabel);
		this.addedToRenderer = true;
	}

	removeFromRenderer(): void {
		if (!this.addedToRenderer) return;

		try {
			this.container.destroy();
			this.titleLabel.destroy();
			this.messageLabel.destroy();
		} catch {
			// Elements might not exist
		}
		this.addedToRenderer = false;
	}

	updatePosition(x: number, y: number): void {
		this.x = x;
		this.y = y;

		(this.container as unknown as { left: number }).left = x;
		(this.container as unknown as { top: number }).top = y;
		(this.titleLabel as unknown as { left: number }).left = x + 2;
		(this.titleLabel as unknown as { top: number }).top = y + 1;
		(this.messageLabel as unknown as { left: number }).left = x + 2;
		(this.messageLabel as unknown as { top: number }).top = y + 2;
	}

	handleInput(key: string): boolean {
		if (this.config.dismissable && key === "escape") {
			this.dismiss();
			return true;
		}
		return false;
	}

	dismiss(): void {
		if (this.dismissed) return;

		this.dismissed = true;
		this.removeFromRenderer();
		this.config.onDismiss?.();
	}

	getId(): string {
		return this.config.id;
	}

	getHeight(): number {
		return this.height;
	}

	isDismissed(): boolean {
		return this.dismissed;
	}

	getDuration(): number | null | undefined {
		return this.config.duration;
	}

	setY(y: number): void {
		this.y = y;
		this.updatePosition(this.x, y);
	}

	getY(): number {
		return this.y;
	}

	isAddedToRenderer(): boolean {
		return this.addedToRenderer;
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;

		const newX = layout.terminal.width - TOAST_WIDTH - TOAST_MARGIN;
		if (newX !== this.x) {
			this.x = newX;
			this.updatePosition(this.x, this.y);
		}
	}

	getWidth(): number {
		return TOAST_WIDTH;
	}
}
