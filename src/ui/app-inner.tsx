import { Frame } from "./frame";
import { theme } from "./theme";

export function AppInner() {
	return (
		<box
			flexGrow={1}
			paddingX={1}
			paddingY={0}
			backgroundColor={theme.background}
		>
			<Frame
				titleRight={
					<text fg={theme.primary} selectable={false}>
						List
					</text>
				}
				style={{
					flexGrow: 1,
					backgroundColor: theme.background,
				}}
			>
				<box flexGrow={1} alignItems="center" justifyContent="center">
					<text fg={theme.textMuted} selectable={false}>
						No torrents
					</text>
				</box>
			</Frame>
		</box>
	);
}
