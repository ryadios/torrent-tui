import { fg, t } from "@opentui/core";
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

	const completedCells = Math.round(progress * PROGRESS_CELLS);
	const completed = "━".repeat(completedCells);
	const remaining = "━".repeat(PROGRESS_CELLS - completedCells);

	return (
		<text
			content={t`${fg(theme.primary)(completed)}${fg(theme.textMuted)(`${remaining} ${percentage}%`)}`}
			height={1}
			selectable={false}
			wrapMode="none"
		/>
	);
}
