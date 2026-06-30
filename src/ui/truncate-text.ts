import { stringWidth } from "bun";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateEnd(text: string, maxWidth: number): string {
	if (stringWidth(text) <= maxWidth) return text;
	if (maxWidth <= 0) return "";

	let result = "";
	let width = 0;

	for (const { segment } of graphemes.segment(text)) {
		const segmentWidth = stringWidth(segment);
		if (width + segmentWidth > maxWidth - 1) break;
		result += segment;
		width += segmentWidth;
	}

	return `${result}…`;
}
