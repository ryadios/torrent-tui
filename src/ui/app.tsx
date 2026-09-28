import { useKeyboard } from "@opentui/react";
import { useCallback, useRef } from "react";
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
	const quitBlocked = useRef(false);
	const handleQuitBlockedChange = useCallback((blocked: boolean) => {
		quitBlocked.current = blocked;
	}, []);

	useKeyboard((key) => {
		if (
			key.name === keybinds.quit.key &&
			!quitBlocked.current &&
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
			<AppInner
				operations={operations}
				onQuitBlockedChange={handleQuitBlockedChange}
			/>
		</box>
	);
}
