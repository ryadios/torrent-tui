// Config loader - reads from ~/.config/torrent-tui/settings.json

import { existsSync, readFileSync } from "node:fs";
import { getConfigPath } from "../utils/paths";
import { writeJsonAtomic } from "../utils/json";
import { log } from "../torrent/metadata";
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

		log("config", "invalid settings file — using defaults");
		return { ...DEFAULT_SETTINGS };
	} catch {
		log("config", "could not read settings file — using defaults");
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveConfig(settings: AppSettings): void {
	writeJsonAtomic(getConfigPath(SETTINGS_FILE), settings);
}
