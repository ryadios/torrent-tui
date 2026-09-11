import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { TransmissionClient } from "../transmission/client";
import { App } from "../ui/app";

export async function runApp(): Promise<void> {
	const renderer = await createCliRenderer();
	const client = new TransmissionClient();

	try {
		createRoot(renderer).render(
			<App operations={client} onQuit={() => renderer.destroy()} />,
		);
	} catch (error) {
		renderer.destroy();
		throw error;
	}
}
