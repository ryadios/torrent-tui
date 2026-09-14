import { useKeyboard } from "@opentui/react";
import type { TorrentOperations } from "../torrent/actions";
import { AppInner } from "./app-inner";
import { Header } from "./header";
import { keybinds } from "./keybinds";
import { theme } from "./theme";

type AppProps = {
	operations: TorrentOperations;
	onQuit: () => void;
};

export function App({ operations, onQuit }: AppProps) {
	useKeyboard((key) => {
		if (
			key.name === keybinds.quit.key &&
			!key.ctrl &&
			!key.meta &&
			!key.shift
		) {
			onQuit();
		}
	});

	return (
		<box
			flexGrow={1}
			flexDirection="column"
			backgroundColor={theme.background}
		>
			<Header />
			<AppInner operations={operations} />
		</box>
	);
}
