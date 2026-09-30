import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type {
	TorrentDetails as TorrentDetailsData,
	TorrentFile,
} from "../transmission/types/torrent";
import { formatSize } from "./format-size";
import { Frame } from "./frame";
import { ProgressBar } from "./progress-bar";
import { theme } from "./theme";
import { compactTorrentPath } from "./torrent-paths";
import { truncateEnd } from "./truncate-text";

export type TorrentDetailsState = {
	hash: string;
	data?: TorrentDetailsData;
	unavailable: boolean;
	stale: boolean;
};

export type DetailsTab = "overview" | "files";

type TorrentDetailsProps = {
	state?: TorrentDetailsState;
	selectedHash?: string;
	tab: DetailsTab;
	focused: boolean;
	width: number;
	height: number;
	onTabChange: (tab: DetailsTab) => void;
};

type FileFolder = {
	kind: "folder";
	name: string;
	path: string;
	children: FileTreeNode[];
};

type FileLeaf = {
	kind: "file";
	name: string;
	path: string;
	file: TorrentFile;
};

type FileTreeNode = FileFolder | FileLeaf;

type VisibleFileRow = {
	node: FileTreeNode;
	depth: number;
};

function buildFileTree(files: TorrentFile[]): FileTreeNode[] {
	const roots: FileTreeNode[] = [];
	const folders = new Map<string, FileFolder>();

	for (const file of files) {
		const parts = file.name.split("/").filter(Boolean);
		let children = roots;
		let path = "";

		for (const part of parts.slice(0, -1)) {
			path = path ? `${path}/${part}` : part;
			let folder = folders.get(path);
			if (!folder) {
				folder = { kind: "folder", name: part, path, children: [] };
				folders.set(path, folder);
				children.push(folder);
			}
			children = folder.children;
		}

		const name = parts.at(-1) ?? file.name;
		const filePath = path ? `${path}/${name}` : name;
		children.push({ kind: "file", name, path: filePath, file });
	}

	return roots;
}

function visibleFileRows(
	nodes: FileTreeNode[],
	expanded: Set<string>,
	depth = 0,
): VisibleFileRow[] {
	return nodes.flatMap((node) => [
		{ node, depth },
		...(node.kind === "folder" && expanded.has(node.path)
			? visibleFileRows(node.children, expanded, depth + 1)
			: []),
	]);
}

function InfoValue({ label, value }: { label: string; value: string }) {
	return (
		<box flexDirection="row" columnGap={1} minWidth={0}>
			<text fg={theme.textMuted} selectable={false} wrapMode="none">
				{label}
			</text>
			<text
				fg={theme.text}
				selectable={false}
				wrapMode="none"
				truncate
				style={{ flexGrow: 1, minWidth: 0 }}
			>
				{value}
			</text>
		</box>
	);
}

function TorrentOverview({ details }: { details: TorrentDetailsData }) {
	return (
		<box flexGrow={1} minHeight={0} flexDirection="column">
			<InfoValue
				label="Location"
				value={compactTorrentPath(details.download_dir)}
			/>
			<InfoValue
				label="Privacy"
				value={details.is_private ? "Private" : "Public"}
			/>
			<InfoValue
				label="Downloaded"
				value={formatSize(details.downloaded_ever)}
			/>
			<InfoValue
				label="Uploaded"
				value={formatSize(details.uploaded_ever)}
			/>
			<InfoValue
				label="Ratio"
				value={`${details.upload_ratio.toFixed(1)}x`}
			/>
			<InfoValue label="Peers" value={String(details.peers_connected)} />
		</box>
	);
}

function FileRow({
	row,
	selected,
	expanded,
	width,
}: {
	row: VisibleFileRow;
	selected: boolean;
	expanded: boolean;
	width: number;
}) {
	const { node, depth } = row;
	const indent = "  ".repeat(depth);
	const marker = node.kind === "folder" ? (expanded ? "▾ " : "▸ ") : "  ";
	const progressWidth = Math.min(24, Math.floor(width * 0.32));
	const nameWidth = Math.max(0, width - 12 - progressWidth);

	return (
		<box
			id={`detail-file-${encodeURIComponent(node.path)}`}
			border={["left"]}
			borderColor={selected ? theme.primary : theme.background}
			backgroundColor={
				selected ? theme.backgroundElement : theme.background
			}
			style={{
				flexDirection: "row",
				width: "100%",
				height: 1,
				flexShrink: 0,
				paddingLeft: 1,
				paddingRight: 1,
				columnGap: 1,
			}}
		>
			{node.kind === "folder" ? (
				<text
					fg={selected ? theme.text : theme.textMuted}
					selectable={false}
					wrapMode="none"
					style={{ width, flexGrow: 1, minWidth: 0 }}
				>
					{truncateEnd(`${indent}${marker}${node.name}`, width)}
				</text>
			) : (
				<>
					<text
						fg={theme.text}
						selectable={false}
						wrapMode="none"
						style={{
							width: nameWidth,
							minWidth: 0,
							flexShrink: 1,
						}}
					>
						{truncateEnd(`${indent}${node.name}`, nameWidth)}
					</text>
					<text
						fg={theme.textMuted}
						selectable={false}
						wrapMode="none"
						style={{ width: 10, flexShrink: 0 }}
					>
						{formatSize(node.file.length)}
					</text>
					<ProgressBar
						percentDone={
							node.file.length === 0
								? 1
								: node.file.bytes_completed / node.file.length
						}
						width={progressWidth}
					/>
				</>
			)}
		</box>
	);
}

export function TorrentDetailsPane({
	state,
	selectedHash,
	tab,
	focused,
	width,
	height,
	onTabChange,
}: TorrentDetailsProps) {
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const initializedFiles = useRef(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [cursorPath, setCursorPath] = useState<string>();
	const currentState = state?.hash === selectedHash ? state : undefined;
	const details = currentState?.data;
	const metadataReady = (details?.metadata_percent_complete ?? 0) >= 1;
	const tree = buildFileTree(details?.files ?? []);
	const rows = visibleFileRows(tree, expanded);
	const contentWidth = Math.max(0, width - 4);
	const stale = currentState?.stale ?? false;

	useEffect(() => {
		if (!details?.files || initializedFiles.current) return;
		initializedFiles.current = true;
		const nextExpanded = new Set(
			tree.flatMap((node) => (node.kind === "folder" ? [node.path] : [])),
		);
		setExpanded(nextExpanded);
		setCursorPath(visibleFileRows(tree, nextExpanded)[0]?.node.path);
	}, [details?.files, tree]);

	useEffect(() => {
		if (cursorPath) {
			scrollRef.current?.scrollChildIntoView(
				`detail-file-${encodeURIComponent(cursorPath)}`,
			);
		}
	}, [cursorPath]);

	useKeyboard((key) => {
		if (!focused || key.ctrl || key.meta || key.shift) return;

		if (key.name === "left" || key.name === "right") {
			if (metadataReady) {
				onTabChange(key.name === "right" ? "files" : "overview");
			}
			key.preventDefault();
			key.stopPropagation();
			return;
		}

		if (tab !== "files" || !metadataReady || rows.length === 0) return;
		const index = Math.max(
			0,
			rows.findIndex((row) => row.node.path === cursorPath),
		);
		let nextIndex = index;

		if (key.name === "j" || key.name === "down") nextIndex += 1;
		else if (key.name === "k" || key.name === "up") nextIndex -= 1;
		else if (key.name === "home") nextIndex = 0;
		else if (key.name === "end") nextIndex = rows.length - 1;
		else if (key.name === "return") {
			const current = rows[index]?.node;
			if (current?.kind === "folder") {
				setExpanded((currentExpanded) => {
					const next = new Set(currentExpanded);
					if (next.has(current.path)) next.delete(current.path);
					else next.add(current.path);
					return next;
				});
			}
			key.preventDefault();
			key.stopPropagation();
			return;
		} else return;

		const nextRow = rows[Math.max(0, Math.min(nextIndex, rows.length - 1))];
		if (nextRow) setCursorPath(nextRow.node.path);
		key.preventDefault();
		key.stopPropagation();
	});

	const tabLabels: Record<DetailsTab, string> = {
		overview: "Overview",
		files: "Files",
	};
	const activeLabel = tabLabels[tab];
	const underlineOffset = tab === "files" ? tabLabels.overview.length + 2 : 0;
	const underlineWidth = activeLabel.length;
	const ruleWidth = Math.max(
		0,
		contentWidth - underlineOffset - underlineWidth,
	);

	return (
		<Frame
			borderColor={focused ? theme.primary : theme.borderSubtle}
			titleRight={
				<box
					flexDirection="row"
					columnGap={1}
					paddingX={1}
					backgroundColor={theme.background}
				>
					<text
						fg={focused ? theme.primary : theme.textMuted}
						selectable={false}
					>
						Details
					</text>
					{stale ? (
						<text fg={theme.textMuted} selectable={false}>
							stale
						</text>
					) : null}
				</box>
			}
			style={{
				width,
				height,
				minWidth: 0,
				flexShrink: 0,
				paddingLeft: 1,
				paddingRight: 1,
				backgroundColor: theme.background,
			}}
		>
			<box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
				<box flexDirection="row" flexShrink={0} columnGap={2}>
					{(["overview", "files"] as const).map((item) => (
						<text
							key={item}
							fg={
								tab === item
									? theme.primary
									: item === "files" && !metadataReady
										? theme.borderSubtle
										: theme.textMuted
							}
							selectable={false}
							wrapMode="none"
						>
							{tabLabels[item]}
						</text>
					))}
				</box>
				<box flexDirection="row" flexShrink={0}>
					{underlineOffset > 0 ? (
						<text
							fg={theme.borderSubtle}
							selectable={false}
							wrapMode="none"
						>
							{"─".repeat(underlineOffset)}
						</text>
					) : null}
					<text fg={theme.primary} selectable={false} wrapMode="none">
						{"━".repeat(underlineWidth)}
					</text>
					<text
						fg={theme.borderSubtle}
						selectable={false}
						wrapMode="none"
					>
						{"─".repeat(ruleWidth)}
					</text>
				</box>
				{!selectedHash ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							No torrent selected
						</text>
					</box>
				) : !details ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							{currentState?.unavailable
								? "Details unavailable"
								: "Loading details…"}
						</text>
					</box>
				) : tab === "overview" ? (
					<TorrentOverview details={details} />
				) : !metadataReady ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							Files metadata is not ready
						</text>
					</box>
				) : !details.files ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							{currentState?.stale
								? "Files unavailable"
								: "Loading files…"}
						</text>
					</box>
				) : details.files.length === 0 ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							No files
						</text>
					</box>
				) : (
					<scrollbox
						ref={scrollRef}
						focusable={false}
						scrollY
						style={{ flexGrow: 1, minHeight: 0 }}
					>
						{rows.map((row) => (
							<FileRow
								key={row.node.path}
								row={row}
								selected={cursorPath === row.node.path}
								expanded={expanded.has(row.node.path)}
								width={Math.max(
									0,
									contentWidth - 3 - row.depth * 2,
								)}
							/>
						))}
					</scrollbox>
				)}
			</box>
		</Frame>
	);
}
