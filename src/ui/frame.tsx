import type { BoxProps } from "@opentui/react";
import { FullBorder } from "./borders";
import { theme } from "./theme";

type FrameProps = {
	children?: BoxProps["children"];
	titleRight?: BoxProps["children"];
	style?: BoxProps["style"];
};

export function Frame({ children, titleRight, style }: FrameProps) {
	return (
		<box
			border={FullBorder.border}
			customBorderChars={FullBorder.customBorderChars}
			borderColor={theme.border}
			style={style}
		>
			{children}
			{titleRight ? (
				<box
					style={{
						position: "absolute",
						top: -1,
						right: 2,
						paddingLeft: 1,
						paddingRight: 1,
						backgroundColor: theme.titleBackground,
					}}
				>
					{titleRight}
				</box>
			) : null}
		</box>
	);
}
