import { EventEmitter } from "node:events";
import { TorrentMetadata, log } from "./metadata.ts";
import { StorageManager } from "./storage.ts";
import { Downloader } from "./downloader.ts";
import type { TorrentStatus } from "./types.ts";
import type { PeerManager } from "./peer/manager.ts";

export class TorrentSession extends EventEmitter {
	readonly metadata: TorrentMetadata;
	readonly storage: StorageManager;
	readonly downloadPath: string;
	status: TorrentStatus = "created";

	constructor(metadata: TorrentMetadata, downloadPath: string) {
		super();
		this.metadata = metadata;
		this.downloadPath = downloadPath;
		this.storage = new StorageManager(metadata, downloadPath);
	}

	private transition(next: TorrentStatus): void {
		const prev = this.status;
		this.status = next;
		this.emit("status", next, prev);
	}

	async start(): Promise<void> {
		this.transition("verifying");
		await this.storage.setup();
		await this.storage.verifyAll();
		this.transition("ready");
	}

	download(manager: PeerManager): Downloader {
		this.transition("downloading");
		const downloader = new Downloader(
			this.metadata,
			this.storage,
			manager,
			this.downloadPath,
		);

		downloader.on("piece:verified", (i: number) => this.emit("piece:verified", i));
		downloader.on("piece:failed", (i: number, peer: string) => this.emit("piece:failed", i, peer));
		downloader.on("progress", (dl: number, total: number, speed: number) =>
			this.emit("progress", dl, total, speed),
		);
		downloader.on("complete", () => {
			this.transition("seeding");
			this.emit("complete");
		});

		downloader.start();
		return downloader;
	}
}
