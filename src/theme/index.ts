import { DEFAULT_COLORSCHEME } from "./default";
import type { ColorScheme } from "./types";

let currentTheme: ColorScheme = { ...DEFAULT_COLORSCHEME };

export function getTheme(): ColorScheme {
	return currentTheme;
}

export function setTheme(theme: ColorScheme): void {
	currentTheme = { ...theme };
}

export function resetTheme(): void {
	currentTheme = { ...DEFAULT_COLORSCHEME };
}

export type { ColorScheme } from "./types";
export { DEFAULT_COLORSCHEME };
