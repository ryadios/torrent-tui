import { RGBA } from "@opentui/core";
import { createPortal, useRenderer } from "@opentui/react";
import type { ReactNode } from "react";
import { FullBorder } from "./borders";
import { theme } from "./theme";

type DialogProps = {
	title: string;
	children: ReactNode;
	height?: number | "auto" | "70%";
};

type DialogHint = {
	key: string;
	label: string;
};

type DialogHintsProps = {
	left: readonly DialogHint[];
	right: readonly DialogHint[];
};

function Hint({ hint }: { hint: DialogHint }) {
	return (
		<box flexDirection="row">
			<text fg={theme.primary} selectable={false}>
				{hint.key}
			</text>
			<text fg={theme.textMuted} selectable={false}>
				{` ${hint.label}`}
			</text>
		</box>
	);
}

export function DialogHints({ left, right }: DialogHintsProps) {
	return (
		<box flexDirection="row" flexShrink={0} justifyContent="space-between">
			<box flexDirection="row" columnGap={2}>
				{left.map((hint) => (
					<Hint key={`${hint.key}-${hint.label}`} hint={hint} />
				))}
			</box>
			<box flexDirection="row" columnGap={2}>
				{right.map((hint) => (
					<Hint key={`${hint.key}-${hint.label}`} hint={hint} />
				))}
			</box>
		</box>
	);
}

export function Dialog({ title, children, height = "auto" }: DialogProps) {
	const renderer = useRenderer();

	return createPortal(
		<box
			style={{
				position: "absolute",
				left: 0,
				top: 0,
				width: "100%",
				height: "100%",
				zIndex: 10_000,
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: RGBA.fromInts(0, 0, 0, 89),
			}}
		>
			<box
				border={FullBorder.border}
				customBorderChars={FullBorder.customBorderChars}
				borderColor={theme.borderSubtle}
				style={{
					width: "80%",
					maxWidth: 72,
					height,
					flexShrink: 0,
					flexDirection: "column",
					backgroundColor: theme.backgroundPanel,
					paddingX: 2,
					paddingY: 1,
					rowGap: 1,
				}}
			>
				<box
					style={{
						position: "absolute",
						top: -1,
						left: 2,
						paddingLeft: 1,
						paddingRight: 1,
						flexShrink: 0,
						backgroundColor: theme.backgroundPanel,
					}}
				>
					<text fg={theme.primary} selectable={false}>
						{title}
					</text>
				</box>
				{children}
			</box>
		</box>,
		renderer.root,
		null,
	);
}
