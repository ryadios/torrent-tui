import { runApp } from "./app/main";
import { runCli } from "./cli/main";
import { TransmissionClient } from "./transmission/client";

const args = process.argv.slice(2);

if (args.length === 0) {
	await runApp();
} else {
	process.exitCode = await runCli(args, new TransmissionClient());
}
