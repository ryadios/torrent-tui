import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { isRemoteTorrentSource } from "../torrent/source";
import { Dialog, DialogHints } from "./dialog";
import { theme } from "./theme";
import { TorrentBrowser } from "./torrent-browser";
import {
	listTorrentPathSuggestions,
	type TorrentPathSuggestion,
} from "./torrent-paths";

const MAX_SUGGESTIONS = 6;

type AddDialogProps = {
	pending: boolean;
	error?: string;
	onSubmit: (source: string) => void;
	onClose: () => void;
	onClearError: () => void;
};

type CompletionState =
	| { status: "idle"; items: TorrentPathSuggestion[] }
	| { status: "loading"; items: TorrentPathSuggestion[] }
	| { status: "loaded"; items: TorrentPathSuggestion[] }
	| { status: "failed"; items: TorrentPathSuggestion[] };

export function AddDialog({
	pending,
	error,
	onSubmit,
	onClose,
	onClearError,
}: AddDialogProps) {
	const [source, setSource] = useState("");
	const [focus, setFocus] = useState<"source" | "browse">("source");
	const [view, setView] = useState<"add" | "browse">("add");
	const [validationError, setValidationError] = useState<string>();
	const [dismissedSource, setDismissedSource] = useState<string>();
	const [completion, setCompletion] = useState<CompletionState>({
		status: "idle",
		items: [],
	});
	const [suggestionIndex, setSuggestionIndex] = useState(0);
	const suggestionSelection = useRef(0);
	const inputRef = useRef<InputRenderable | null>(null);

	const completionActive =
		view === "add" &&
		focus === "source" &&
		!pending &&
		Boolean(source) &&
		!isRemoteTorrentSource(source) &&
		dismissedSource !== source;
	const suggestions = completion.items.slice(0, MAX_SUGGESTIONS);

	useEffect(() => {
		if (view === "add" && focus === "source" && !pending) {
			inputRef.current?.focus();
		} else {
			inputRef.current?.blur();
		}
	}, [focus, pending, view]);

	useEffect(() => {
		if (!completionActive) {
			setCompletion({ status: "idle", items: [] });
			return;
		}

		let active = true;
		suggestionSelection.current = 0;
		setSuggestionIndex(0);
		setCompletion({ status: "loading", items: [] });
		void listTorrentPathSuggestions(source)
			.then((items) => {
				if (active) setCompletion({ status: "loaded", items });
			})
			.catch(() => {
				if (active) setCompletion({ status: "failed", items: [] });
			});

		return () => {
			active = false;
		};
	}, [completionActive, source]);

	function updateSource(value: string): void {
		setSource(value);
		setDismissedSource(undefined);
		setValidationError(undefined);
		onClearError();
	}

	function acceptSuggestion(item: TorrentPathSuggestion): void {
		setSource(item.value);
		setValidationError(undefined);
		onClearError();
		suggestionSelection.current = 0;
		setSuggestionIndex(0);
		if (item.kind === "file") setDismissedSource(item.value);
	}

	function submit(): void {
		const value = source.trim();
		if (!value) {
			setValidationError("Torrent source is required");
			return;
		}
		setValidationError(undefined);
		onSubmit(value);
	}

	function consume(key: {
		preventDefault: () => void;
		stopPropagation: () => void;
	}): void {
		key.preventDefault();
		key.stopPropagation();
	}

	useKeyboard((key) => {
		if (key.ctrl || key.meta || (key.shift && key.name !== "tab")) return;

		if (pending) {
			consume(key);
			return;
		}
		if (view === "browse") return;

		if (completionActive) {
			if (key.name === "escape") {
				consume(key);
				setDismissedSource(source);
				return;
			}
			if (key.name === "up" || key.name === "down") {
				consume(key);
				if (suggestions.length === 0) return;
				const offset = key.name === "up" ? -1 : 1;
				const next =
					(suggestionSelection.current +
						offset +
						suggestions.length) %
					suggestions.length;
				suggestionSelection.current = next;
				setSuggestionIndex(next);
				return;
			}
			if (key.name === "tab" || key.name === "return") {
				const suggestion = suggestions[suggestionSelection.current];
				if (suggestion) {
					consume(key);
					acceptSuggestion(suggestion);
					return;
				}
			}
		}

		if (key.name === "escape") {
			consume(key);
			onClose();
			return;
		}
		if (key.name === "tab") {
			consume(key);
			setFocus((current) => (current === "source" ? "browse" : "source"));
			return;
		}
		if (key.name === "return" && focus === "browse") {
			consume(key);
			setView("browse");
		}
	});

	if (view === "browse") {
		return (
			<Dialog title="Select torrent" height="70%">
				<TorrentBrowser
					source={source}
					onSelect={(path) => {
						setSource(path);
						setValidationError(undefined);
						onClearError();
						setDismissedSource(path);
						setView("add");
						setFocus("source");
					}}
					onBack={() => {
						setView("add");
						setFocus("source");
					}}
				/>
			</Dialog>
		);
	}

	const message =
		validationError ??
		error ??
		(completionActive && completion.status === "loading"
			? "Loading paths..."
			: completionActive && completion.status === "failed"
				? "Unable to read directory"
				: completionActive &&
						completion.status === "loaded" &&
						suggestions.length === 0
					? "No matching paths"
					: undefined);

	return (
		<Dialog title="Add torrent">
			<box flexDirection="column">
				<text fg={theme.textMuted} selectable={false}>
					Source
				</text>
				<input
					ref={inputRef}
					width="100%"
					value={source}
					focused={focus === "source" && !pending}
					placeholder="Magnet, URL, or .torrent path"
					backgroundColor={theme.backgroundElement}
					focusedBackgroundColor={theme.backgroundElement}
					textColor={theme.text}
					cursorColor={theme.primary}
					onInput={updateSource}
					onSubmit={submit}
				/>
			</box>
			{completionActive && suggestions.length > 0 ? (
				<box flexDirection="column">
					{suggestions.map((suggestion, index) => (
						<box
							key={suggestion.path}
							style={{
								paddingLeft: 1,
								backgroundColor:
									index === suggestionIndex
										? theme.backgroundElement
										: theme.backgroundPanel,
							}}
						>
							<text
								fg={
									index === suggestionIndex
										? theme.primary
										: theme.textMuted
								}
								selectable={false}
								wrapMode="none"
								truncate
							>
								{suggestion.name +
									(suggestion.kind === "directory"
										? "/"
										: "")}
							</text>
						</box>
					))}
				</box>
			) : null}
			<box
				style={{
					alignSelf: "flex-end",
					paddingLeft: 1,
					paddingRight: 1,
					backgroundColor:
						focus === "browse"
							? theme.backgroundElement
							: theme.backgroundPanel,
				}}
			>
				<text
					fg={focus === "browse" ? theme.primary : theme.textMuted}
					selectable={false}
				>
					Browse
				</text>
			</box>
			{pending ? (
				<text fg={theme.textMuted} selectable={false}>
					Adding...
				</text>
			) : message ? (
				<text
					fg={
						validationError ||
						error ||
						completion.status === "failed"
							? theme.error
							: theme.textMuted
					}
					selectable={false}
				>
					{message}
				</text>
			) : null}
			{completionActive ? (
				<DialogHints
					left={[
						{ key: "↑/↓", label: "select" },
						{ key: "Tab/Enter", label: "complete" },
					]}
					right={[{ key: "Esc", label: "dismiss" }]}
				/>
			) : (
				<DialogHints
					left={[
						{ key: "Tab", label: "browse" },
						{ key: "Enter", label: "add" },
					]}
					right={[{ key: "Esc", label: "close" }]}
				/>
			)}
		</Dialog>
	);
}
