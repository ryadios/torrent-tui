import type { CliRenderer } from "@opentui/core";
import { TOAST_MARGIN, TOAST_MAX_COUNT, TOAST_WIDTH } from "../constants";
import type { LayoutDimensions } from "../types/layout";
import { Toast, type ToastConfig } from "./toast";

export class ToastManager {
	private renderer: CliRenderer;
	private layout: LayoutDimensions;
	private toasts: Toast[] = [];
	private dismissInterval: ReturnType<typeof setInterval>;

	constructor(renderer: CliRenderer, layout: LayoutDimensions) {
		this.renderer = renderer;
		this.layout = layout;

		this.dismissInterval = setInterval(() => {
			this.tick();
		}, 100);
	}

	show(config: ToastConfig): Toast {
		const x = this.layout.terminal.width - TOAST_WIDTH - TOAST_MARGIN;
		const y = this.calculateYPosition();

		const toast = new Toast(this.renderer, config, x, y);
		this.toasts.push(toast);
		toast.addToRenderer();
		this.repositionToasts();

		if (this.toasts.length > TOAST_MAX_COUNT) {
			const oldest = this.toasts.shift();
			if (oldest) {
				oldest.dismiss();
			}
		}

		return toast;
	}

	private calculateYPosition(): number {
		let y = TOAST_MARGIN;
		for (const toast of this.toasts) {
			y += toast.getHeight() + TOAST_MARGIN;
		}
		return y;
	}

	private repositionToasts(): void {
		let y = TOAST_MARGIN;
		for (const toast of this.toasts) {
			toast.setY(y);
			y += toast.getHeight() + TOAST_MARGIN;
		}
	}

	dismiss(id: string): void {
		const index = this.toasts.findIndex((t) => t.getId() === id);
		if (index !== -1) {
			const toast = this.toasts[index];
			if (toast) {
				toast.dismiss();
				this.toasts.splice(index, 1);
				this.repositionToasts();
			}
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		this.layout = layout;
		for (const toast of this.toasts) {
			toast.updateLayout(layout);
		}
		this.repositionToasts();
	}

	handleInput(key: string): boolean {
		const topToast = this.toasts[this.toasts.length - 1];
		if (topToast) {
			return topToast.handleInput(key);
		}
		return false;
	}

	tick(): void {
		const toRemove: Toast[] = [];

		for (const toast of this.toasts) {
			if (toast.shouldAutoDismiss()) {
				toRemove.push(toast);
			}
		}

		for (const toast of toRemove) {
			this.dismiss(toast.getId());
		}
	}

	destroy(): void {
		clearInterval(this.dismissInterval);
		for (const toast of this.toasts) {
			toast.dismiss();
		}
		this.toasts = [];
	}

	getToasts(): Toast[] {
		return this.toasts;
	}
}
