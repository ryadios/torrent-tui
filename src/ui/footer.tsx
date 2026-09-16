import { useTerminalDimensions } from "@opentui/react";
import { keybinds } from "./keybinds";
import { theme } from "./theme";

type FooterProps = {
	canAdd?: boolean;
	hasSelection?: boolean;
	status?:
		| { kind: "idle" }
		| { kind: "busy"; message: string }
		| { kind: "message"; message: string; tone: "error" | "warning" };
};

export function Footer({
	canAdd = false,
	hasSelection = false,
	status = { kind: "idle" },
}: FooterProps) {
	const { width } = useTerminalDimensions();
	const compact = width < 30;
	const hints = compact
		? [keybinds.quit]
		: [
				...(canAdd ? [keybinds.add] : []),
				...(hasSelection
					? [keybinds.start, keybinds.stop, keybinds.remove]
					: []),
				keybinds.refresh,
				keybinds.quit,
			];

	return (
		<box
			flexDirection="row"
			flexShrink={0}
			justifyContent="space-between"
			backgroundColor={theme.background}
			paddingX={1}
		>
			<box flexDirection="row" columnGap={2}>
				{hints.map((hint) => (
					<box key={hint.key} flexDirection="row">
						<text fg={theme.primary} selectable={false}>
							{hint.key}
						</text>
						<text fg={theme.textMuted} selectable={false}>
							{` ${hint.label}`}
						</text>
					</box>
				))}
			</box>
			{status.kind !== "idle" ? (
				<text
					fg={
						status.kind === "busy"
							? theme.textMuted
							: theme[status.tone]
					}
					selectable={false}
				>
					{status.message}
				</text>
			) : null}
		</box>
	);
}
