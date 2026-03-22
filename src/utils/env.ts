// Typed environment variable accessors

export const env = {
	OTUI_SHOW_STATS: process.env.OTUI_SHOW_STATS === "true",
	SHOW_CONSOLE: process.env.SHOW_CONSOLE === "true",
	CONFIG_PATH: process.env.CONFIG_PATH,
	DEV: process.env.DEV === "true",
} as const;
