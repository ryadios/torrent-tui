import { DhtClient } from "../dht/node.ts";
import { DEFAULT_BOOTSTRAP_NODES } from "../dht/protocol.ts";
import type { TorrentMetadata } from "../metadata.ts";
import type { PeerConnection } from "../peer/connection.ts";
import type { UtPexMessage } from "../peer/extension.ts";
import type { PeerManager } from "../peer/manager.ts";
import { TrackerCoordinator } from "../tracker/coordinator.ts";
import type {
	PeerInfo,
	TrackerAnnounceRequest,
	TrackerResponse,
} from "../types.ts";

const PEX_INTERVAL_MS = 60_000;

interface DiscoverySnapshot {
	downloaded: number;
	uploaded: number;
	left: number;
}

interface DiscoveryScheduler {
	setInterval(fn: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface DiscoveryCoordinatorOptions {
	port?: number;
	numwant?: number;
	getSnapshot: () => DiscoverySnapshot;
	onPeers: (peers: PeerInfo[], source: "tracker" | "dht" | "pex") => void;
	announceTracker?: (
		url: string,
		metadata: TorrentMetadata,
		request: TrackerAnnounceRequest,
	) => Promise<TrackerResponse>;
	dht?: DhtClient | null;
	scheduler?: DiscoveryScheduler;
}

export class DiscoveryCoordinator {
	private readonly tracker: TrackerCoordinator;
	private readonly dht: DhtClient | null;
	private readonly pex: PexCoordinator | null;
	private readonly scheduler: DiscoveryScheduler;
	private dhtRefreshTimer: unknown | null = null;
	private dhtStarted = false;
	private stopped = false;

	constructor(
		private readonly metadata: TorrentMetadata,
		private readonly manager: PeerManager,
		private readonly options: DiscoveryCoordinatorOptions,
	) {
		this.tracker = new TrackerCoordinator(metadata, {
			port: options.port,
			numwant: options.numwant,
			getSnapshot: options.getSnapshot,
			announceTracker: options.announceTracker,
			onPeers: (peers) => options.onPeers(peers, "tracker"),
		});
		this.dht = metadata.private
			? null
			: (options.dht ??
				new DhtClient({
					bootstrapNodes: [...metadata.nodes, ...DEFAULT_BOOTSTRAP_NODES],
				}));
		this.pex = metadata.private
			? null
			: new PexCoordinator(manager, (peers) => options.onPeers(peers, "pex"));
		this.scheduler = options.scheduler ?? {
			setInterval: (fn, delayMs) => setInterval(fn, delayMs),
			clearInterval: (handle) =>
				clearInterval(handle as ReturnType<typeof setInterval>),
		};
	}

	async start(): Promise<void> {
		if (this.stopped) return;
		this.tracker.start();
		await this.startDht();
		this.pex?.start();
	}

	refreshNow(): void {
		if (this.stopped) return;
		this.tracker.refreshNow();
		void this.refreshDht();
	}

	markCompleted(): void {
		this.tracker.markCompleted();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.pex?.stop();
		if (this.dhtRefreshTimer) {
			this.scheduler.clearInterval(this.dhtRefreshTimer);
			this.dhtRefreshTimer = null;
		}
		this.dht?.close();
		await this.tracker.stop();
	}

	private async startDht(): Promise<void> {
		if (!this.dht) return;
		try {
			await this.dht.start(this.manager.listenPort());
			this.dhtStarted = true;
		} catch {
			return;
		}
		this.manager.on("dhtPort", (peer: PeerInfo) => {
			this.dht?.routingTable.add({ ...peer, id: new Uint8Array(20) });
		});
		for (const conn of this.manager.connections.values()) {
			conn.sendDhtPort(this.manager.listenPort());
		}
		await this.refreshDht();
		this.dhtRefreshTimer = this.scheduler.setInterval(() => {
			void this.refreshDht();
		}, 15 * 60_000);
	}

	private async refreshDht(): Promise<void> {
		if (!this.dht || !this.dhtStarted || this.stopped) return;
		const peers = await this.dht
			.getPeers(this.metadata.infoHash)
			.catch(() => []);
		if (peers.length > 0) this.options.onPeers(peers, "dht");
		if (this.options.getSnapshot().left === 0) {
			await this.dht
				.announcePeer(this.metadata.infoHash, this.manager.listenPort())
				.catch(() => undefined);
		}
	}
}

class PexCoordinator {
	private added = new Map<string, PeerInfo>();
	private dropped = new Map<string, PeerInfo>();
	private timer: unknown | null = null;
	private stopped = false;

	constructor(
		private readonly manager: PeerManager,
		private readonly onPeers: (peers: PeerInfo[]) => void,
		private readonly scheduler: DiscoveryScheduler = {
			setInterval: (fn, delayMs) => setInterval(fn, delayMs),
			clearInterval: (handle) =>
				clearInterval(handle as ReturnType<typeof setInterval>),
		},
	) {}

	start(): void {
		this.manager.on("peerAdded", this.onPeerAdded);
		this.manager.on("peerRemoved", this.onPeerRemoved);
		for (const conn of this.manager.connections.values()) this.wirePeer(conn);
		this.timer = this.scheduler.setInterval(
			() => this.flush(),
			PEX_INTERVAL_MS,
		);
	}

	stop(): void {
		this.stopped = true;
		this.manager.off("peerAdded", this.onPeerAdded);
		this.manager.off("peerRemoved", this.onPeerRemoved);
		if (this.timer) this.scheduler.clearInterval(this.timer);
		this.timer = null;
	}

	private readonly onPeerAdded = (conn: PeerConnection): void => {
		const peer = { ip: conn.address, port: conn.port };
		this.added.set(peerKey(peer), peer);
		this.dropped.delete(peerKey(peer));
		this.wirePeer(conn);
	};

	private readonly onPeerRemoved = (conn: PeerConnection): void => {
		const peer = { ip: conn.address, port: conn.port };
		this.added.delete(peerKey(peer));
		this.dropped.set(peerKey(peer), peer);
	};

	private wirePeer(conn: PeerConnection): void {
		conn.on("extensionHandshake", () => {
			if (this.stopped) return;
			if (!conn.peerExtensions.has("ut_pex")) return;
			conn.sendUtPex({
				added: [...this.manager.connections.values()]
					.filter((peer) => peer !== conn)
					.map((peer) => ({ ip: peer.address, port: peer.port })),
				dropped: [],
			});
		});
		conn.on("utPex", (message: UtPexMessage) => {
			const peers = message.added.filter(
				(peer) => !this.manager.hasPeer(peer) && isIPv4Peer(peer),
			);
			if (peers.length > 0) this.onPeers(peers);
		});
	}

	private flush(): void {
		const message: UtPexMessage = {
			added: [...this.added.values()],
			dropped: [...this.dropped.values()],
		};
		if (message.added.length === 0 && message.dropped.length === 0) return;
		for (const conn of this.manager.connections.values()) {
			if (conn.peerExtensions.has("ut_pex")) conn.sendUtPex(message);
		}
		this.added.clear();
		this.dropped.clear();
	}
}

function peerKey(peer: PeerInfo): string {
	return `${peer.ip}:${peer.port}`;
}

function isIPv4Peer(peer: PeerInfo): boolean {
	return (
		/^\d{1,3}(\.\d{1,3}){3}$/.test(peer.ip) &&
		peer.port > 0 &&
		peer.port <= 65535
	);
}
