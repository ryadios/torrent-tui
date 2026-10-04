import { dirname } from "node:path";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { DialogHints } from "./dialog";
import { theme } from "./theme";
import {
	compactTorrentPath,
	readTorrentDirectory,
	resolveBrowseDirectory,
	type TorrentPathEntry,
} from "./torrent-paths";

type TorrentBrowserProps = {
	source: string;
	mode: "source" | "destination";
	onSelect: (path: string) => void;
	onBack: () => void;
};

type BrowserState =
	| { status: "loading" }
	| { status: "loaded"; entries: TorrentPathEntry[] }
	| { status: "failed" };

export function TorrentBrowser({
	source,
	mode,
	onSelect,
	onBack,
}: TorrentBrowserProps) {
	const [directory, setDirectory] = useState<string>();
	const [browser, setBrowser] = useState<BrowserState>({ status: "loading" });
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selection = useRef(0);
	const returnToPath = useRef<string | undefined>(undefined);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);

	useEffect(() => {
		let active = true;
		void resolveBrowseDirectory(source).then((next) => {
			if (active) setDirectory(next);
		});
		return () => {
			active = false;
		};
	}, [source]);

	useEffect(() => {
		if (!directory) return;

		let active = true;
		selection.current = 0;
		setSelectedIndex(0);
		setBrowser({ status: "loading" });
		void readTorrentDirectory(directory)
			.then((entries) => {
				if (!active) return;
				const parent = dirname(directory);
				const visibleEntries =
					mode === "destination"
						? entries.filter((entry) => entry.kind === "directory")
						: entries;
				const nextEntries = [
					...(parent !== directory
						? [
								{
									name: "..",
									path: parent,
									kind: "directory" as const,
								},
							]
						: []),
					...visibleEntries,
				];
				const returnPath = returnToPath.current;
				const index = returnPath
					? nextEntries.findIndex(
							(entry) => entry.path === returnPath,
						)
					: 0;
				returnToPath.current = undefined;
				selection.current = Math.max(index, 0);
				setSelectedIndex(selection.current);
				setBrowser({ status: "loaded", entries: visibleEntries });
			})
			.catch(() => {
				if (!active) return;
				returnToPath.current = undefined;
				setBrowser({ status: "failed" });
			});

		return () => {
			active = false;
		};
	}, [directory, mode]);

	const parent = directory ? dirname(directory) : undefined;
	const entries =
		browser.status === "loaded"
			? [
					...(directory && parent && parent !== directory
						? [
								{
									name: "..",
									path: parent,
									kind: "directory" as const,
								},
							]
						: []),
					...browser.entries,
				]
			: [];

	useEffect(() => {
		scrollRef.current?.scrollChildIntoView(
			`browser-entry-${selectedIndex}`,
		);
	}, [selectedIndex]);

	function move(target: "next" | "previous" | "first" | "last"): void {
		if (entries.length === 0) return;

		const nextIndex =
			target === "first"
				? 0
				: target === "last"
					? entries.length - 1
					: Math.min(
							Math.max(
								selection.current +
									(target === "next" ? 1 : -1),
								0,
							),
							entries.length - 1,
						);

		if (nextIndex === selection.current) return;
		selection.current = nextIndex;
		setSelectedIndex(nextIndex);
	}

	function enterDirectory(entry: TorrentPathEntry | undefined): void {
		if (entry?.kind === "directory") setDirectory(entry.path);
	}

	function goToParent(): void {
		if (!directory || !parent || parent === directory) return;
		returnToPath.current = directory;
		setDirectory(parent);
	}

	function select(): void {
		if (!directory) return;
		if (mode === "destination") {
			onSelect(compactTorrentPath(directory));
			return;
		}

		const entry = entries[selection.current];
		if (entry?.kind === "file") onSelect(compactTorrentPath(entry.path));
	}

	useKeyboard((key) => {
		if (key.ctrl || key.meta || key.shift) return;

		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			onBack();
			return;
		}
		if (key.name === "h" || key.name === "left") {
			key.preventDefault();
			key.stopPropagation();
			goToParent();
			return;
		}
		if (key.name === "l" || key.name === "right") {
			key.preventDefault();
			key.stopPropagation();
			enterDirectory(entries[selection.current]);
			return;
		}
		if (key.name === "return" && !key.repeated) {
			key.preventDefault();
			key.stopPropagation();
			select();
			return;
		}
		if (key.name === "j" || key.name === "down") {
			key.preventDefault();
			key.stopPropagation();
			move("next");
			return;
		}
		if (key.name === "k" || key.name === "up") {
			key.preventDefault();
			key.stopPropagation();
			move("previous");
			return;
		}
		if (key.name === "home") {
			key.preventDefault();
			key.stopPropagation();
			move("first");
			return;
		}
		if (key.name === "end") {
			key.preventDefault();
			key.stopPropagation();
			move("last");
		}
	});

	return (
		<>
			<text
				fg={theme.textMuted}
				selectable={false}
				wrapMode="none"
				truncate
			>
				{directory ?? process.cwd()}
			</text>
			<scrollbox
				ref={scrollRef}
				focusable={false}
				scrollY
				style={{ flexGrow: 1, minHeight: 0 }}
			>
				{browser.status === "loading" ? (
					<text fg={theme.textMuted} selectable={false}>
						Loading directory...
					</text>
				) : browser.status === "failed" ? (
					<text fg={theme.error} selectable={false}>
						Unable to read directory
					</text>
				) : entries.length === 0 ? (
					<text fg={theme.textMuted} selectable={false}>
						{mode === "destination"
							? "No folders"
							: "No torrent files"}
					</text>
				) : (
					entries.map((entry, index) => (
						<box
							key={entry.path}
							id={`browser-entry-${index}`}
							style={{
								flexShrink: 0,
								paddingLeft: 1,
								backgroundColor:
									index === selectedIndex
										? theme.backgroundElement
										: theme.backgroundPanel,
							}}
						>
							<text
								fg={
									index === selectedIndex
										? theme.primary
										: theme.text
								}
								selectable={false}
								wrapMode="none"
								truncate
							>
								{entry.name +
									(entry.kind === "directory" ? "/" : "")}
							</text>
						</box>
					))
				)}
			</scrollbox>
			<DialogHints
				left={[
					{ key: "j/k", label: "move" },
					{ key: "h/←", label: "parent" },
					{ key: "l/→", label: "enter" },
					{
						key: "Enter",
						label:
							mode === "destination"
								? "use folder"
								: "select torrent",
					},
				]}
				right={[{ key: "Esc", label: "back" }]}
			/>
		</>
	);
}
