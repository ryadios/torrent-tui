import { existsSync } from "node:fs";
import { App } from "./app";

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

const [arg] = process.argv.slice(2);
let torrentPath: string | null = null; // check for torrrent file in args
if (arg) torrentPath = validateTorrentArg(arg);

const app = new App(torrentPath);
app.start();
