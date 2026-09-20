import { fg, t } from "@opentui/core";
import { theme } from "./theme";

type ProgressBarProps = {
	percentDone: number;
	width: number;
};

function clampPercent(percentDone: number): number {
	if (!Number.isFinite(percentDone)) return 0;
	return Math.min(1, Math.max(0, percentDone));
}

export function ProgressBar({ percentDone, width }: ProgressBarProps) {
	const progress = clampPercent(percentDone);
	const percentage = Math.round(progress * 100);
	const label = ` ${percentage}% `;
	const railWidth = Math.max(0, Math.floor(width));

	if (railWidth < label.length + 2) {
		return (
			<text fg={theme.text} selectable={false} wrapMode="none">
				{`${percentage}%`}
			</text>
		);
	}

	const barCells = railWidth - label.length;
	const leftCells = Math.floor(barCells / 2);
	const rightCells = barCells - leftCells;
	const completedCells = Math.round(progress * barCells);
	const completedLeft = Math.min(completedCells, leftCells);
	const completedRight = Math.max(0, completedCells - leftCells);
	const leftCompleted = "━".repeat(completedLeft);
	const leftRemaining = "━".repeat(leftCells - completedLeft);
	const rightCompleted = "━".repeat(Math.min(completedRight, rightCells));
	const rightRemaining = "━".repeat(
		rightCells - Math.min(completedRight, rightCells),
	);

	return (
		<text
			content={t`${fg(theme.primary)(leftCompleted)}${fg(theme.borderSubtle)(leftRemaining)}${fg(theme.text)(label)}${fg(theme.primary)(rightCompleted)}${fg(theme.borderSubtle)(rightRemaining)}`}
			height={1}
			selectable={false}
			wrapMode="none"
		/>
	);
}
