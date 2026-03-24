import { existsSync } from "node:fs";
import { getPeers } from "./torrent/get_peers";

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function validateTorrentArg(arg: string): string {
	if (!arg.toLowerCase().endsWith(".torrent")) {
		fail(`Error: '${arg}' is not a .torrent file`);
	}
	if (!existsSync(arg)) {
		fail(`Error: File not found: '${arg}'`);
	}
	return arg;
}

async function main() {
	const [arg] = process.argv.slice(2);

	if (arg) {
		const torrentPath = validateTorrentArg(arg);

		try {
			await getPeers(torrentPath, 6881, 50);
		} catch (e) {
			fail(`Error: ${e instanceof Error ? e.message : e}`);
		}

		return;
	}

	const { App } = await import("./app");
	const app = new App();
	app.start();
}

main();
