// Application constants

export const APP_NAME = "torrent-tui";
export const VERSION = "0.1.0";

export const SIDEBAR_WIDTH = 20;

export const SIDEBAR_ITEMS = {
	status: ["All", "Downloading", "Seeding", "Completed", "Stopped"],
	category: ["All", "Movies", "Music"],
} as const;

export type SidebarSection = keyof typeof SIDEBAR_ITEMS;

// Toast configuration
export const TOAST_WIDTH = 40;
export const TOAST_MARGIN = 1;
export const TOAST_DEFAULT_DURATION = 3000;
export const TOAST_MAX_COUNT = 3;
