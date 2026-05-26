import { EventEmitter } from "node:events";
import { TorrentMetadata, log } from "./metadata.ts";
import { StorageManager } from "./storage.ts";
import type { TorrentStatus } from "./types.ts";

export class TorrentSession extends EventEmitter {
	readonly metadata: TorrentMetadata;
	readonly storage: StorageManager;
	status: TorrentStatus = "created";

	constructor(metadata: TorrentMetadata, downloadPath: string) {
		super();
		this.metadata = metadata;
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
}
