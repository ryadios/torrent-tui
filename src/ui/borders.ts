import type { BorderCharacters, BorderSides } from "@opentui/core";

export type BorderPreset = {
	border: BorderSides[];
	customBorderChars: BorderCharacters;
};

const emptyBorder: BorderCharacters = {
	topLeft: "",
	topRight: "",
	bottomLeft: "",
	bottomRight: "",
	horizontal: " ",
	vertical: "",
	topT: "",
	bottomT: "",
	leftT: "",
	rightT: "",
	cross: "",
};

export const FullBorder: BorderPreset = {
	border: ["left", "right", "top", "bottom"],
	customBorderChars: {
		...emptyBorder,
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		topT: "┬",
		bottomT: "┴",
		leftT: "├",
		rightT: "┤",
		cross: "┼",
	},
};
