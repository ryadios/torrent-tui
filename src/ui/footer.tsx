import { useTerminalDimensions } from "@opentui/react";
import { keybinds } from "./keybinds";
import { theme } from "./theme";

export function Footer() {
	const { width } = useTerminalDimensions();
	const compact = width < 30;

	return (
		<box
			flexDirection="row"
			flexShrink={0}
			backgroundColor={theme.backgroundPanel}
			paddingX={1}
		>
			<text fg={theme.primary} selectable={false}>
				{keybinds.quit.key}
			</text>
			<text fg={theme.textMuted} selectable={false}>
				{` ${keybinds.quit.label}`}
			</text>

			{compact ? null : (
				<>
					<text fg={theme.textMuted} selectable={false}>
						{"  "}
					</text>
					<text fg={theme.primary} selectable={false}>
						{keybinds.interrupt.key}
					</text>
					<text fg={theme.textMuted} selectable={false}>
						{` ${keybinds.interrupt.label}`}
					</text>
				</>
			)}
		</box>
	);
}
