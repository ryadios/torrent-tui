import { useKeyboard } from "@opentui/react";
import { AppInner } from "./app-inner";
import { Footer } from "./footer";
import { Header } from "./header";
import { keybinds } from "./keybinds";
import { theme } from "./theme";

type AppProps = {
	onQuit: () => void;
};

export function App({ onQuit }: AppProps) {
	useKeyboard((key) => {
		if (key.name === keybinds.quit.key && !key.ctrl) {
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
			<AppInner />
			<Footer />
		</box>
	);
}
