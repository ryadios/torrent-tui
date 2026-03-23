import { existsSync, readFileSync } from "node:fs";
import { decode } from "./torrent/parser";

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

if (arg) {
	const torrentPath = validateTorrentArg(arg);
	const fileContent = readFileSync(torrentPath);
	const decoded = decode(fileContent);
	console.log(JSON.stringify(decoded, null, 2));
	process.exit(0);
}

import { App } from "./app";

const app = new App(null);
app.start();
