// Settings schema with Zod validation

import { z } from "zod";

export const settingsSchema = z.object({
	theme: z.enum(["default", "dark", "light"]).default("default"),
	refreshInterval: z.number().min(1000).max(60000).default(5000),
	downloadPath: z.string().default("~/Downloads"),
	maxConnections: z.number().min(1).max(500).default(50),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
	theme: "default",
	refreshInterval: 5000,
	downloadPath: "~/Downloads",
	maxConnections: 50,
};
