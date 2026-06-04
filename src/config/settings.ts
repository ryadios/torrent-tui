import { z } from "zod";

export const settingsSchema = z.object({
	downloadPath: z.string().default("~/Downloads"),
	maxConnections: z.number().min(1).max(500).default(50),
	torrentFolder: z.string().default("~/Downloads"),
	downloadRateLimitBps: z.number().min(0).default(0),
	uploadRateLimitBps: z.number().min(0).default(0),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
	downloadPath: "~/Downloads",
	maxConnections: 50,
	torrentFolder: "~/Downloads",
	downloadRateLimitBps: 0,
	uploadRateLimitBps: 0,
};
