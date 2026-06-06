export type CliAction =
	| "tui"
	| "help"
	| "version"
	| "verify"
	| "handshake"
	| "download"
	| "info";

export interface CliCommand {
	action: CliAction;
	input?: string;
	json: boolean;
}

const ACTION_FLAGS = new Map<string, CliAction>([
	["--verify", "verify"],
	["--handshake", "handshake"],
	["--download", "download"],
	["--info", "info"],
]);

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
const VALUELESS_FLAGS = new Set([
	...HELP_FLAGS,
	...VERSION_FLAGS,
	...ACTION_FLAGS.keys(),
	"--json",
]);

export function parseCliArgs(args: string[]): CliCommand {
	if (args.some((arg) => HELP_FLAGS.has(arg))) {
		ensureOnlyKnownFlags(args);
		return { action: "help", json: false };
	}
	if (args.some((arg) => VERSION_FLAGS.has(arg))) {
		ensureOnlyKnownFlags(args);
		return { action: "version", json: false };
	}

	ensureOnlyKnownFlags(args);

	const json = args.includes("--json");
	const actions = args
		.filter((arg) => ACTION_FLAGS.has(arg))
		.map((arg) => ACTION_FLAGS.get(arg) as CliAction);
	if (actions.length > 1) {
		throw new Error(`Choose only one action flag: ${actions.join(", ")}`);
	}
	if (json && actions[0] !== "info") {
		throw new Error("--json can only be used with --info");
	}

	const inputs = args.filter((arg) => !VALUELESS_FLAGS.has(arg));
	if (inputs.length > 1) {
		throw new Error(`Expected one torrent or magnet argument, got ${inputs.length}`);
	}

	const input = inputs[0];
	const action = actions[0] ?? "tui";
	if (action !== "tui" && !input) {
		throw new Error(`Missing torrent or magnet argument for ${flagForAction(action)}`);
	}

	return { action, input, json };
}

function ensureOnlyKnownFlags(args: string[]): void {
	for (const arg of args) {
		if (arg.startsWith("-") && !VALUELESS_FLAGS.has(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
}

function flagForAction(action: CliAction): string {
	for (const [flag, flagAction] of ACTION_FLAGS) {
		if (flagAction === action) return flag;
	}
	return action;
}
