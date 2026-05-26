import { APP_NAME } from "../constants";

export function getConfigDir(): string {
	return `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/${APP_NAME}`;
}

export function getConfigPath(filename: string): string {
	return `${getConfigDir()}/${filename}`;
}

export function getDataDir(): string {
	return `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/${APP_NAME}`;
}

export function resolvePath(p: string): string {
	return p.replace(/^~/, process.env.HOME ?? ".");
}
