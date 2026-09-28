import type { InputRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";
import { keybinds } from "./keybinds";
import { theme } from "./theme";

type FooterProps = {
	canAdd?: boolean;
	hasSelection?: boolean;
	search?: {
		editing: boolean;
		draft: string;
		query: string;
		onInput: (value: string) => void;
	};
	status?:
		| { kind: "idle" }
		| { kind: "busy"; message: string }
		| { kind: "message"; message: string; tone: "error" | "warning" };
};

export function Footer({
	canAdd = false,
	hasSelection = false,
	search,
	status = { kind: "idle" },
}: FooterProps) {
	const { width } = useTerminalDimensions();
	const inputRef = useRef<InputRenderable | null>(null);

	useEffect(() => {
		if (search?.editing) inputRef.current?.focus();
	}, [search?.editing]);

	const compact = width < 30;
	const hints = compact
		? [keybinds.quit]
		: width < 54
			? [
					...(canAdd ? [keybinds.add] : []),
					...(search ? [keybinds.search] : []),
					keybinds.quit,
				]
			: [
					...(canAdd ? [keybinds.add] : []),
					...(hasSelection
						? [keybinds.start, keybinds.stop, keybinds.remove]
						: []),
					...(search ? [keybinds.search] : []),
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
			<box flexDirection="row" columnGap={2} flexGrow={1} minWidth={0}>
				{search?.editing ? (
					<box flexDirection="row" flexGrow={1} minWidth={0}>
						<text fg={theme.primary} selectable={false}>
							{"/ "}
						</text>
						<input
							ref={inputRef}
							flexGrow={1}
							minWidth={0}
							value={search.draft}
							onInput={search.onInput}
							placeholder="Search torrents"
							backgroundColor={theme.background}
							focusedBackgroundColor={theme.background}
							textColor={theme.text}
							cursorColor={theme.primary}
						/>
					</box>
				) : (
					<>
						{search?.query ? (
							<text
								fg={theme.primary}
								selectable={false}
								wrapMode="none"
								truncate
								style={{ flexShrink: 1, minWidth: 0 }}
							>
								{`/ ${search.query}`}
							</text>
						) : null}
						{hints.map((hint) => (
							<box
								key={hint.key}
								flexDirection="row"
								flexShrink={0}
							>
								<text fg={theme.primary} selectable={false}>
									{hint.key}
								</text>
								<text fg={theme.textMuted} selectable={false}>
									{` ${hint.label}`}
								</text>
							</box>
						))}
					</>
				)}
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
