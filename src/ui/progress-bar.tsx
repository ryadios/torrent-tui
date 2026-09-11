import { theme } from "./theme";

const PROGRESS_CELLS = 10;

type ProgressBarProps = {
	percentDone: number;
	compact?: boolean;
};

function clampPercent(percentDone: number): number {
	if (!Number.isFinite(percentDone)) return 0;
	return Math.min(1, Math.max(0, percentDone));
}

export function ProgressBar({
	percentDone,
	compact = false,
}: ProgressBarProps) {
	const progress = clampPercent(percentDone);
	const percentage = Math.round(progress * 100);

	if (compact) {
		return (
			<text fg={theme.textMuted} selectable={false} wrapMode="none">
				{`${percentage}%`}
			</text>
		);
	}

	const exactFilled = progress * PROGRESS_CELLS;
	const fullCells = Math.floor(exactFilled);
	const hasPartialCell =
		fullCells < PROGRESS_CELLS && exactFilled > fullCells;
	const emptyCells = PROGRESS_CELLS - fullCells - (hasPartialCell ? 1 : 0);
	const bar =
		"━".repeat(fullCells) +
		(hasPartialCell ? "╸" : "") +
		"─".repeat(emptyCells);

	return (
		<text fg={theme.textMuted} selectable={false} wrapMode="none">
			{`${bar} ${percentage}%`}
		</text>
	);
}
