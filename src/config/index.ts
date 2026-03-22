// Config loader - reads from ~/.config/torrent-tui/settings.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getConfigDir, getConfigPath } from "../utils/paths";
import { type AppSettings, DEFAULT_SETTINGS, settingsSchema } from "./settings";

const SETTINGS_FILE = "settings.json";

export function loadConfig(): AppSettings {
	const configPath = getConfigPath(SETTINGS_FILE);

	if (!existsSync(configPath)) {
		// Create config dir and save default settings on first run
		saveConfig(DEFAULT_SETTINGS);
		return { ...DEFAULT_SETTINGS };
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const raw = JSON.parse(content);
		const result = settingsSchema.safeParse(raw);

		if (result.success) {
			return result.data;
		}

		return { ...DEFAULT_SETTINGS };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveConfig(settings: AppSettings): void {
	try {
		mkdirSync(getConfigDir(), { recursive: true });
		const configPath = getConfigPath(SETTINGS_FILE);
		writeFileSync(configPath, JSON.stringify(settings, null, 2), "utf-8");
	} catch {
		// Silently fail
	}
}
