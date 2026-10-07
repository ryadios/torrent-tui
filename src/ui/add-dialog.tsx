import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { expandTorrentPath, isRemoteTorrentSource } from "../torrent/source";
import { Dialog, DialogHints } from "./dialog";
import { theme } from "./theme";
import { TorrentBrowser } from "./torrent-browser";
import {
	compactTorrentPath,
	listTorrentPathSuggestions,
	type TorrentPathSuggestion,
} from "./torrent-paths";

const MAX_SUGGESTIONS = 6;

type AddDialogProps = {
	pending: boolean;
	error?: string;
	onLoadDefaultLocation: () => Promise<{ path: string; warning?: string }>;
	onSubmit: (source: string, downloadDirectory: string) => void;
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
	onLoadDefaultLocation,
	onSubmit,
	onClose,
	onClearError,
}: AddDialogProps) {
	const [step, setStep] = useState<"source" | "location" | "review">(
		"source",
	);
	const [browser, setBrowser] = useState<"source" | "location">();
	const [source, setSource] = useState("");
	const [downloadDirectory, setDownloadDirectory] = useState("");
	const [focus, setFocus] = useState<"input" | "browse">("input");
	const [loadingLocation, setLoadingLocation] = useState(false);
	const [locationWarning, setLocationWarning] = useState<string>();
	const [validationError, setValidationError] = useState<string>();
	const [dismissedSource, setDismissedSource] = useState<string>();
	const [completion, setCompletion] = useState<CompletionState>({
		status: "idle",
		items: [],
	});
	const [suggestionIndex, setSuggestionIndex] = useState(0);
	const suggestionSelection = useRef(0);
	const locationLoaded = useRef(false);
	const locationLoadPending = useRef(false);
	const mounted = useRef(true);
	const inputRef = useRef<InputRenderable | null>(null);

	const completionActive =
		step === "source" &&
		browser === undefined &&
		focus === "input" &&
		!pending &&
		Boolean(source) &&
		!isRemoteTorrentSource(source) &&
		dismissedSource !== source;
	const suggestions = completion.items.slice(0, MAX_SUGGESTIONS);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		if (
			!browser &&
			step !== "review" &&
			focus === "input" &&
			!pending &&
			(!loadingLocation || step === "source")
		) {
			inputRef.current?.focus();
		} else {
			inputRef.current?.blur();
		}
	}, [browser, focus, loadingLocation, pending, step]);

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

	function updateDownloadDirectory(value: string): void {
		setDownloadDirectory(value);
		setLocationWarning(undefined);
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

	function continueFromSource(): void {
		if (locationLoadPending.current) return;
		if (!source.trim()) {
			setValidationError("Torrent source is required");
			return;
		}
		setValidationError(undefined);
		onClearError();
		if (locationLoaded.current) {
			setFocus("input");
			setStep("location");
			return;
		}

		locationLoadPending.current = true;
		setLoadingLocation(true);
		setFocus("input");
		setStep("location");
		void onLoadDefaultLocation()
			.then(({ path, warning }) => {
				if (!mounted.current) return;
				setDownloadDirectory(compactTorrentPath(path));
				setLocationWarning(warning);
				locationLoaded.current = true;
			})
			.catch(() => {
				if (!mounted.current) return;
				setValidationError("Unable to load the download location");
			})
			.finally(() => {
				locationLoadPending.current = false;
				if (mounted.current) setLoadingLocation(false);
			});
	}

	function continueToReview(): void {
		if (!downloadDirectory.trim()) {
			setValidationError("Download location is required");
			return;
		}
		setValidationError(undefined);
		setFocus("input");
		setStep("review");
	}

	function submit(): void {
		const sourceValue = source.trim();
		if (!sourceValue) {
			setStep("source");
			setValidationError("Torrent source is required");
			return;
		}
		if (!downloadDirectory.trim()) {
			setStep("location");
			setValidationError("Download location is required");
			return;
		}
		setValidationError(undefined);
		onSubmit(sourceValue, downloadDirectory);
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
		if (browser) return;
		if (loadingLocation && step === "location") {
			consume(key);
			if (key.name === "escape") {
				setStep("source");
				setFocus("input");
			}
			return;
		}
		if (step === "review") {
			if (key.name === "escape") {
				consume(key);
				setStep("location");
				setFocus("input");
			} else if (key.name === "return" && !key.repeated) {
				consume(key);
				submit();
			}
			return;
		}

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
			if (step === "location") {
				setStep("source");
				setFocus("input");
			} else onClose();
			return;
		}
		if (key.name === "tab") {
			consume(key);
			setFocus((current) => (current === "input" ? "browse" : "input"));
			return;
		}
		if (key.name === "return" && focus === "browse" && !key.repeated) {
			consume(key);
			setBrowser(step);
		}
	});

	if (browser) {
		return (
			<Dialog
				title={
					browser === "source"
						? "Select torrent"
						: "Select download location"
				}
				height="70%"
			>
				<TorrentBrowser
					source={browser === "source" ? source : downloadDirectory}
					mode={browser === "source" ? "source" : "destination"}
					onSelect={(path) => {
						if (browser === "source") {
							setSource(path);
							setDismissedSource(path);
							setStep("source");
							setValidationError(undefined);
						} else {
							setDownloadDirectory(path);
							setLocationWarning(undefined);
							setValidationError(undefined);
							setStep("location");
						}
						onClearError();
						setBrowser(undefined);
						setFocus("input");
					}}
					onBack={() => {
						setBrowser(undefined);
						setFocus("input");
					}}
				/>
			</Dialog>
		);
	}

	const message =
		validationError ??
		error ??
		(loadingLocation && step === "source"
			? "Loading default location…"
			: step === "source" &&
					completionActive &&
					completion.status === "loading"
				? "Loading paths..."
				: step === "source" &&
						completionActive &&
						completion.status === "failed"
					? "Unable to read directory"
					: step === "source" &&
							completionActive &&
							completion.status === "loaded" &&
							suggestions.length === 0
						? "No matching paths"
						: undefined);

	return (
		<Dialog
			title={
				step === "source"
					? "Torrent source · 1/3"
					: step === "location"
						? "Download location · 2/3"
						: "Confirm torrent · 3/3"
			}
		>
			{step === "source" ? (
				<>
					<box flexDirection="column">
						<text fg={theme.textMuted} selectable={false}>
							Source
						</text>
						<input
							ref={inputRef}
							width="100%"
							value={source}
							focused={focus === "input" && !pending}
							placeholder="Magnet, URL, or .torrent path"
							backgroundColor={theme.backgroundElement}
							focusedBackgroundColor={theme.backgroundElement}
							textColor={theme.text}
							cursorColor={theme.primary}
							onInput={updateSource}
							onSubmit={continueFromSource}
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
				</>
			) : step === "location" ? (
				<box flexDirection="column">
					<text
						fg={theme.textMuted}
						selectable={false}
						wrapMode="none"
						truncate
					>
						{`Torrent: ${source}`}
					</text>
					<text fg={theme.textMuted} selectable={false}>
						Save to
					</text>
					<input
						ref={inputRef}
						width="100%"
						value={downloadDirectory}
						focused={
							focus === "input" && !pending && !loadingLocation
						}
						placeholder={
							loadingLocation
								? "Loading default location…"
								: "Download directory"
						}
						placeholderColor={theme.textMuted}
						backgroundColor={theme.backgroundElement}
						focusedBackgroundColor={theme.backgroundElement}
						textColor={theme.text}
						cursorColor={theme.primary}
						onInput={updateDownloadDirectory}
						onSubmit={continueToReview}
					/>
				</box>
			) : (
				<>
					<text fg={theme.textMuted} selectable={false}>
						Source
					</text>
					<text fg={theme.text} selectable={false} wrapMode="char">
						{source}
					</text>
					<text fg={theme.textMuted} selectable={false}>
						Download location
					</text>
					<text fg={theme.text} selectable={false} wrapMode="char">
						{expandTorrentPath(downloadDirectory)}
					</text>
				</>
			)}
			{step !== "review" ? (
				<box
					style={{
						alignSelf: "flex-end",
						paddingLeft: 1,
						paddingRight: 1,
						backgroundColor:
							focus === "browse" &&
							!(loadingLocation && step === "location")
								? theme.backgroundElement
								: theme.backgroundPanel,
					}}
				>
					<text
						fg={
							focus === "browse" &&
							!(loadingLocation && step === "location")
								? theme.primary
								: theme.textMuted
						}
						selectable={false}
					>
						Browse
					</text>
				</box>
			) : null}
			{locationWarning && step !== "source" ? (
				<text fg={theme.warning} selectable={false} wrapMode="word">
					{locationWarning}
				</text>
			) : null}
			{pending ? (
				<text fg={theme.textMuted} selectable={false}>
					Adding...
				</text>
			) : loadingLocation && step === "location" ? null : message ? (
				<text
					fg={
						validationError ||
						error ||
						(completion.status === "failed" && !loadingLocation)
							? theme.error
							: theme.textMuted
					}
					selectable={false}
				>
					{message}
				</text>
			) : null}
			<DialogHints
				left={
					step === "review"
						? [{ key: "Enter", label: "add" }]
						: [
								...(!loadingLocation || step === "source"
									? [{ key: "Tab", label: "browse" }]
									: []),
								...(!loadingLocation
									? [
											{
												key: "Enter",
												label:
													step === "source"
														? "continue"
														: "review",
											},
										]
									: []),
							]
				}
				right={[
					{
						key: "Esc",
						label:
							step === "source"
								? completionActive
									? "dismiss"
									: "close"
								: "back",
					},
				]}
			/>
		</Dialog>
	);
}
