// XDG path utilities

const APP_NAME = "torrent-tui";

export function getConfigDir(): string {
	return `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/${APP_NAME}`;
}

export function getConfigPath(filename: string): string {
	return `${getConfigDir()}/${filename}`;
}

export function getDataDir(): string {
	return `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/${APP_NAME}`;
}
