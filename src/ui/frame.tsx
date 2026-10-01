import type { BoxProps } from "@opentui/react";
import { FullBorder } from "./borders";
import { theme } from "./theme";

type FrameProps = {
	children?: BoxProps["children"];
	titleRight?: BoxProps["children"];
	style?: BoxProps["style"];
	borderColor?: string;
};

export function Frame({
	children,
	titleRight,
	style,
	borderColor = theme.borderSubtle,
}: FrameProps) {
	return (
		<box
			border={FullBorder.border}
			customBorderChars={FullBorder.customBorderChars}
			borderColor={borderColor}
			style={style}
		>
			{children}
			{titleRight ? (
				<box
					style={{
						position: "absolute",
						top: -1,
						right: 2,
					}}
				>
					{titleRight}
				</box>
			) : null}
		</box>
	);
}
