import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import packageJson from "../../package.json" with { type: "json" };
import { theme } from "./theme";

export function Header() {
	const { width } = useTerminalDimensions();
	const showVersion = width >= 60;

	return (
		<box
			flexDirection="row"
			flexShrink={0}
			backgroundColor={theme.backgroundPanel}
			paddingX={1}
		>
			<text
				fg={theme.primary}
				attributes={TextAttributes.BOLD}
				selectable={false}
			>
				torrent-tui
			</text>

			{showVersion ? (
				<text fg={theme.textMuted} selectable={false}>
					{` v${packageJson.version}`}
				</text>
			) : null}
		</box>
	);
}
