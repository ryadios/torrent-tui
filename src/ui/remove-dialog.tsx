import { useKeyboard } from "@opentui/react";
import { Dialog, DialogHints } from "./dialog";
import { theme } from "./theme";

type RemoveDialogProps = {
	name: string;
	pending: boolean;
	onConfirm: () => void;
	onClose: () => void;
};

export function RemoveDialog({
	name,
	pending,
	onConfirm,
	onClose,
}: RemoveDialogProps) {
	useKeyboard((key) => {
		if (key.ctrl || key.meta || key.shift || key.repeated) return;

		if (pending) {
			if (key.name === "return" || key.name === "escape") {
				key.preventDefault();
				key.stopPropagation();
			}
			return;
		}

		if (key.name === "return") {
			key.preventDefault();
			key.stopPropagation();
			onConfirm();
			return;
		}

		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			onClose();
		}
	});

	return (
		<Dialog title="Remove torrent">
			<text fg={theme.text} selectable={false} wrapMode="none" truncate>
				{name}
			</text>
			<text fg={theme.textMuted} selectable={false}>
				Local data will be kept.
			</text>
			{pending ? (
				<text fg={theme.textMuted} selectable={false}>
					Removing...
				</text>
			) : (
				<DialogHints
					left={[{ key: "Enter", label: "remove" }]}
					right={[{ key: "Esc", label: "cancel" }]}
				/>
			)}
		</Dialog>
	);
}
