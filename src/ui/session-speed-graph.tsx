import { useTerminalDimensions } from "@opentui/react";
import type { SessionStats } from "../transmission/types/session";
import { formatRate } from "./format-rate";
import { Frame } from "./frame";
import { theme } from "./theme";
import { POLL_INTERVAL_MS } from "./use-torrent-polling";

export const SESSION_SPEED_HISTORY_MS = 2 * 60 * 1000;
const MAX_SPEED_FRAME_WIDTH = 80;
const MAX_SAMPLE_GAP_MS = POLL_INTERVAL_MS * 1.5;
const BRAILLE_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

export type SessionSpeedSample = {
	at: number;
	download: number;
	upload: number;
};

type SessionSpeedGraphProps = {
	samples: SessionSpeedSample[];
	stats?: SessionStats;
	now: number;
	width: number;
	height: number;
};

function drawPoint(
	dots: Uint8Array,
	width: number,
	x: number,
	y: number,
): void {
	const cellX = Math.floor(x / 2);
	const cellY = Math.floor(y / 4);
	const cell = cellY * width + cellX;
	dots[cell] = (dots[cell] ?? 0) | (BRAILLE_BITS[y % 4]?.[x % 2] ?? 0);
}

function drawLine(
	dots: Uint8Array,
	width: number,
	startX: number,
	startY: number,
	endX: number,
	endY: number,
): void {
	let x = startX;
	let y = startY;
	const dx = Math.abs(endX - startX);
	const sx = startX < endX ? 1 : -1;
	const dy = -Math.abs(endY - startY);
	const sy = startY < endY ? 1 : -1;
	let error = dx + dy;

	while (true) {
		drawPoint(dots, width, x, y);
		if (x === endX && y === endY) return;

		const doubledError = 2 * error;
		if (doubledError >= dy) {
			error += dy;
			x += sx;
		}
		if (doubledError <= dx) {
			error += dx;
			y += sy;
		}
	}
}

function renderPlot(
	samples: SessionSpeedSample[],
	valueFor: (sample: SessionSpeedSample) => number,
	width: number,
	rows: number,
	now: number,
): { line: string; row: number }[] {
	const windowStart = now - SESSION_SPEED_HISTORY_MS;
	const visible = samples.filter(
		(sample) => sample.at >= windowStart && sample.at <= now,
	);
	const maximum = visible.reduce(
		(current, sample) => Math.max(current, valueFor(sample)),
		0,
	);
	const scale = maximum * 1.1;
	const dots = new Uint8Array(width * rows);
	const dotWidth = width * 2;
	const dotHeight = rows * 4;
	let previous: { at: number; x: number; y: number } | undefined;

	for (const sample of visible) {
		const value = Math.max(0, valueFor(sample));
		const x = Math.round(
			((sample.at - windowStart) / SESSION_SPEED_HISTORY_MS) *
				(dotWidth - 1),
		);
		const ratio = scale === 0 ? 0 : Math.min(1, value / scale);
		const y = Math.round((1 - ratio) * (dotHeight - 1));

		if (previous && sample.at - previous.at <= MAX_SAMPLE_GAP_MS) {
			drawLine(dots, width, previous.x, previous.y, x, y);
		} else {
			drawPoint(dots, width, x, y);
		}
		previous = { at: sample.at, x, y };
	}

	const lines = Array.from({ length: rows }, (_, row) => {
		let line = "";
		for (let column = 0; column < width; column += 1) {
			line += String.fromCharCode(
				0x2800 + (dots[row * width + column] ?? 0),
			);
		}
		return { line, row };
	});

	return lines;
}

function RatePlot({
	label,
	color,
	samples,
	valueFor,
	currentRate,
	width,
	rows,
	now,
}: {
	label: string;
	color: string;
	samples: SessionSpeedSample[];
	valueFor: (sample: SessionSpeedSample) => number;
	currentRate?: number;
	width: number;
	rows: number;
	now: number;
}) {
	const plot = renderPlot(samples, valueFor, width, rows, now);

	return (
		<box flexDirection="column" flexShrink={0}>
			<text fg={color} selectable={false} wrapMode="none">
				{`${label}${currentRate === undefined ? "" : ` ${formatRate(currentRate)}`}`}
			</text>
			{plot.map(({ line, row }) => (
				<text
					key={`${label}-${row}`}
					fg={color}
					selectable={false}
					wrapMode="none"
				>
					{line}
				</text>
			))}
		</box>
	);
}

export function SessionSpeedGraph({
	samples,
	stats,
	now,
	width: frameWidth,
	height,
}: SessionSpeedGraphProps) {
	const { height: terminalHeight } = useTerminalDimensions();
	if (terminalHeight < 16) return null;

	const width = Math.max(
		0,
		Math.min(MAX_SPEED_FRAME_WIDTH - 4, frameWidth - 6),
	);
	const plotRows = terminalHeight < 28 ? 2 : 4;

	return (
		<Frame
			borderColor={theme.borderSubtle}
			titleRight={
				<box paddingX={1} backgroundColor={theme.background}>
					<text fg={theme.textMuted} selectable={false}>
						Speed
					</text>
				</box>
			}
			style={{
				width: frameWidth,
				height,
				maxWidth: "100%",
				flexShrink: 0,
				paddingLeft: 1,
				paddingRight: 1,
				backgroundColor: theme.background,
			}}
		>
			<box flexShrink={0} flexDirection="column" gap={1}>
				<RatePlot
					label="↓ Download"
					color={theme.primary}
					samples={samples}
					valueFor={(sample) => sample.download}
					currentRate={stats?.download_speed}
					width={width}
					rows={plotRows}
					now={now}
				/>
				<RatePlot
					label="↑ Upload"
					color={theme.cyan}
					samples={samples}
					valueFor={(sample) => sample.upload}
					currentRate={stats?.upload_speed}
					width={width}
					rows={plotRows}
					now={now}
				/>
			</box>
		</Frame>
	);
}
