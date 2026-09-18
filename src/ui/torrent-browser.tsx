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
	onSelect: (path: string) => void;
	onBack: () => void;
};

type BrowserState =
	| { status: "loading" }
	| { status: "loaded"; entries: TorrentPathEntry[] }
	| { status: "failed" };

export function TorrentBrowser({
	source,
	onSelect,
	onBack,
}: TorrentBrowserProps) {
	const [directory, setDirectory] = useState<string>();
	const [browser, setBrowser] = useState<BrowserState>({ status: "loading" });
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selection = useRef(0);
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
				if (active) setBrowser({ status: "loaded", entries });
			})
			.catch(() => {
				if (active) setBrowser({ status: "failed" });
			});

		return () => {
			active = false;
		};
	}, [directory]);

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

	function open(entry: TorrentPathEntry | undefined): void {
		if (!entry) return;
		if (entry.kind === "directory") setDirectory(entry.path);
		else onSelect(compactTorrentPath(entry.path));
	}

	useKeyboard((key) => {
		if (key.ctrl || key.meta || key.shift) return;

		if (key.name === "escape") {
			key.stopPropagation();
			onBack();
			return;
		}
		if (key.name === "backspace" && !key.repeated) {
			key.stopPropagation();
			if (directory && parent && parent !== directory)
				setDirectory(parent);
			return;
		}
		if (key.name === "return" && !key.repeated) {
			key.stopPropagation();
			open(entries[selection.current]);
			return;
		}
		if (key.name === "j" || key.name === "down") {
			key.stopPropagation();
			move("next");
			return;
		}
		if (key.name === "k" || key.name === "up") {
			key.stopPropagation();
			move("previous");
			return;
		}
		if (key.name === "home") {
			key.stopPropagation();
			move("first");
			return;
		}
		if (key.name === "end") {
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
						No torrent files
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
					{ key: "Enter", label: "open" },
					{ key: "Backspace", label: "parent" },
				]}
				right={[{ key: "Esc", label: "back" }]}
			/>
		</>
	);
}
