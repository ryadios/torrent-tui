import { useEffect, useState } from "react";
import type { TorrentOperations } from "../torrent/actions";
import type { TorrentSummary } from "../transmission/types/torrent";
import { Frame } from "./frame";
import { theme } from "./theme";
import { TorrentList } from "./torrent-list";

type AppInnerProps = {
	operations: TorrentOperations;
};

type ListState =
	| { status: "loading" }
	| { status: "loaded"; torrents: TorrentSummary[]; selectedHash?: string }
	| { status: "failed" };

export function AppInner({ operations }: AppInnerProps) {
	const [list, setList] = useState<ListState>({ status: "loading" });

	useEffect(() => {
		let active = true;

		void operations
			.listTorrents()
			.then(({ torrents }) => {
				if (!active) return;

				setList({
					status: "loaded",
					torrents,
					selectedHash: torrents[0]?.hash_string,
				});
			})
			.catch(() => {
				if (active) setList({ status: "failed" });
			});

		return () => {
			active = false;
		};
	}, [operations]);

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
				{list.status === "loading" ? (
					<box
						flexGrow={1}
						flexDirection="column"
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.primary} selectable={false}>
							{" /\\_/\\"}
						</text>
						<text fg={theme.primary} selectable={false}>
							( o.o )
						</text>
						<text fg={theme.primary} selectable={false}>
							{" > ^ <"}
						</text>
						<text fg={theme.textMuted} selectable={false}>
							Loading torrents...
						</text>
					</box>
				) : list.status === "failed" ? (
					<box
						flexGrow={1}
						alignItems="center"
						justifyContent="center"
					>
						<text fg={theme.textMuted} selectable={false}>
							Unable to load torrents
						</text>
					</box>
				) : (
					<TorrentList
						torrents={list.torrents}
						selectedHash={list.selectedHash}
					/>
				)}
			</Frame>
		</box>
	);
}
