import { EventEmitter } from "node:events";
import { Downloader } from "./downloader.ts";
import type { TorrentMetadata } from "./metadata.ts";
import type { PeerManager } from "./peer/manager.ts";
import { StorageManager } from "./storage.ts";
import type { TorrentStatus } from "./types.ts";

export interface SessionStartOptions {
	skipVerify?: boolean;
	verifyYieldEveryPieces?: number;
	verifyYieldEveryMs?: number;
}

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
		return this.startWithOptions();
	}

	async startWithOptions(options: SessionStartOptions = {}): Promise<void> {
		this.transition("checking");
		const setup = await this.storage.setup();
		if (!options.skipVerify && !setup.allFilesCreated) {
			await this.storage.verifyAll({
				yieldEveryPieces: options.verifyYieldEveryPieces,
				yieldEveryMs: options.verifyYieldEveryMs,
				onProgress: (checked: number, valid: number) => {
					this.emit("checking", checked, this.metadata.pieceCount, valid);
				},
			});
		}
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

		downloader.on("piece:verified", (i: number) =>
			this.emit("piece:verified", i),
		);
		downloader.on("piece:failed", (i: number, peer: string) =>
			this.emit("piece:failed", i, peer),
		);
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
