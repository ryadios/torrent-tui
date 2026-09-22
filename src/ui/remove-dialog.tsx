import { useKeyboard } from "@opentui/react";
import { Dialog, DialogHints } from "./dialog";
import { theme } from "./theme";

type RemoveDialogProps = {
	name: string;
	pending: boolean;
	onConfirm: (deleteLocalData: boolean) => void;
	onClose: () => void;
};

export function RemoveDialog({
	name,
	pending,
	onConfirm,
	onClose,
}: RemoveDialogProps) {
	useKeyboard((key) => {
		if (key.ctrl || key.meta || key.repeated) return;
		if (key.shift && key.name !== "return") return;

		if (key.name === "return") {
			key.preventDefault();
			key.stopPropagation();
			if (!pending) onConfirm(key.shift);
			return;
		}

		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			if (!pending) onClose();
		}
	});

	return (
		<Dialog title="Remove torrent">
			<text fg={theme.text} selectable={false} wrapMode="none" truncate>
				{name}
			</text>
			{pending ? (
				<text fg={theme.textMuted} selectable={false}>
					Removing...
				</text>
			) : (
				<DialogHints
					left={[
						{ key: "Enter", label: "remove" },
						{ key: "Shift+Enter", label: "delete data" },
					]}
					right={[{ key: "Esc", label: "cancel" }]}
				/>
			)}
		</Dialog>
	);
}
