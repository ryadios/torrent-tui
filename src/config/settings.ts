import { z } from "zod";

export const settingsSchema = z.object({
	downloadPath: z.string().default("~/Downloads"),
	maxConnections: z.number().min(1).max(500).default(50),
	torrentFolder: z.string().default("~/Downloads"),
	downloadRateLimitBps: z.number().min(0).default(0),
	uploadRateLimitBps: z.number().min(0).default(0),
	enableWebSeeds: z.boolean().default(true),
	maxWebSeedConnections: z.number().min(0).max(20).default(3),
	webSeedMaxRequestBytes: z.number().min(16_384).default(16_777_216),
	blocklistEnabled: z.boolean().default(false),
	blocklistPaths: z.array(z.string()).default([]),
	blocklistUrl: z.string().default(""),
	blocklistRefreshHours: z.number().min(1).default(168),
	encryption: z.enum(["allowed", "preferred", "required"]).default("preferred"),
	enableLsd: z.boolean().default(true),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
	downloadPath: "~/Downloads",
	maxConnections: 50,
	torrentFolder: "~/Downloads",
	downloadRateLimitBps: 0,
	uploadRateLimitBps: 0,
	enableWebSeeds: true,
	maxWebSeedConnections: 3,
	webSeedMaxRequestBytes: 16_777_216,
	blocklistEnabled: false,
	blocklistPaths: [],
	blocklistUrl: "",
	blocklistRefreshHours: 168,
	encryption: "preferred",
	enableLsd: true,
};
