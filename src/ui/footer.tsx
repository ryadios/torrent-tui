import type { InputRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";
import { keybinds } from "./keybinds";
import { theme } from "./theme";

type FooterProps = {
	canAdd?: boolean;
	hasSelection?: boolean;
	focusedPane?: "list" | "details";
	detailsTab?: "overview" | "files";
	filesAvailable?: boolean;
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
	focusedPane = "list",
	detailsTab = "overview",
	filesAvailable = false,
	search,
	status = { kind: "idle" },
}: FooterProps) {
	const { width } = useTerminalDimensions();
	const inputRef = useRef<InputRenderable | null>(null);

	useEffect(() => {
		if (search?.editing) inputRef.current?.focus();
	}, [search?.editing]);

	const compact = width < 30;
	const paneHint = { key: "Tab", label: "pane" };
	const contextHints =
		focusedPane === "details"
			? [
					...(detailsTab === "files"
						? [{ key: "j/k", label: "move" }]
						: []),
					...(filesAvailable ? [{ key: "←/→", label: "tabs" }] : []),
					...(detailsTab === "files"
						? [{ key: "Enter", label: "Expand" }]
						: []),
				]
			: [{ key: "j/k", label: "select" }];
	const hints = compact
		? [keybinds.quit]
		: width < 40
			? [...(canAdd ? [keybinds.add] : []), paneHint, keybinds.quit]
			: width < 64
				? [
						...(canAdd ? [keybinds.add] : []),
						...(search ? [keybinds.search] : []),
						paneHint,
						keybinds.quit,
					]
				: [
						...(canAdd ? [keybinds.add] : []),
						...(hasSelection
							? [keybinds.start, keybinds.stop, keybinds.remove]
							: []),
						...(search ? [keybinds.search] : []),
						paneHint,
						...(width >= 100
							? contextHints
							: width >= 72
								? contextHints.slice(0, 1)
								: []),
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
