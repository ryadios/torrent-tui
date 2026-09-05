import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "../ui/app";

export async function runApp(): Promise<void> {
	const renderer = await createCliRenderer();

	try {
		createRoot(renderer).render(<App onQuit={() => renderer.destroy()} />);
	} catch (error) {
		renderer.destroy();
		throw error;
	}
}
