import { EventEmitter } from "node:events";
import type { TorrentMetadata } from "../metadata.ts";
import { log } from "../metadata.ts";
import type { PeerInfo } from "../types.ts";
import { PeerConnection } from "./connection.ts";
import { buildExtensionReservedBytes } from "./extension.ts";
import { buildHandshake, HANDSHAKE_LEN, parseHandshake } from "./handshake.ts";
import { PeerListener } from "./listener.ts";
import { getPeerId } from "./peer-id.ts";

export class PeerManager extends EventEmitter {
	readonly connections: Map<string, PeerConnection> = new Map();
	private listener: PeerListener;
	private maxConnections: number;
	private infoHash: Uint8Array;
	private infoBytes: Uint8Array;
	private pieceCount: number;
	private chokeTimer: ReturnType<typeof setInterval> | null = null;
	private optimisticTimer: ReturnType<typeof setInterval> | null = null;
	private optimisticKey: string | null = null;
	private unchokedKeys = new Set<string>();
	private bannedPeers = new Set<string>();

	constructor(metadata: TorrentMetadata, maxConnections = 50) {
		super();
		this.infoHash = metadata.infoHash;
		this.infoBytes = metadata.infoBytes;
		this.pieceCount = metadata.pieceCount;
		this.maxConnections = maxConnections;
		this.listener = new PeerListener();
	}

	async start(): Promise<void> {
		await this.listener.listen();
		this.listener.onConnection((socket) => this.handleInbound(socket));
	}

	async connect(peers: PeerInfo[]): Promise<void> {
		const unique = this.dedup(peers);
		const toConnect = unique.slice(
			0,
			Math.max(0, this.maxConnections - this.connections.size),
		);

		await Promise.allSettled(
			toConnect.map((p) => this.connectOne(p.ip, p.port)),
		);
	}

	private async connectOne(ip: string, port: number): Promise<void> {
		const key = `${ip}:${port}`;
		if (this.bannedPeers.has(key)) return;
		if (this.connections.has(key)) return;

		const conn = new PeerConnection(ip, port, this.infoHash, {
			localMetadata: this.infoBytes,
		});

		conn.on("bitfield", () => {
			if (conn.countPiecesPublic() > 0 && !conn.amInterested)
				conn.sendInterested();
		});

		conn.on("disconnect", () => {
			this.connections.delete(key);
			this.emit("peerRemoved", conn);
		});
		conn.on("dhtPort", (dhtPort: number) => {
			this.emit("dhtPort", { ip: conn.address, port: dhtPort });
		});

		try {
			await conn.connect();
			this.connections.set(key, conn);
			this.emit("peerAdded", conn);
		} catch {
			// timeout/error already logged by connection.ts
		}
	}

	private handleInbound(socket: import("node:net").Socket): void {
		let buf = new Uint8Array(0);

		const onData = (chunk: Buffer) => {
			const merged = new Uint8Array(buf.length + chunk.length);
			merged.set(buf);
			merged.set(new Uint8Array(chunk), buf.length);
			buf = merged;

			if (buf.length < HANDSHAKE_LEN) return;

			socket.removeListener("data", onData);

			try {
				const result = parseHandshake(buf, this.infoHash);
				socket.write(
					buildHandshake(
						this.infoHash,
						getPeerId(),
						buildExtensionReservedBytes(),
					),
				);

				const ip = socket.remoteAddress ?? "unknown";
				const port = socket.remotePort ?? 0;
				const key = `${ip}:${port}`;
				if (this.bannedPeers.has(key) || this.connections.has(key)) {
					socket.destroy();
					return;
				}
				log(
					"peer",
					`${key.padEnd(50)}  ok   ${result.peerId.slice(0, 8)}  (inbound)`,
				);

				const conn = new PeerConnection(ip, port, this.infoHash);
				const remainder = buf.slice(HANDSHAKE_LEN);
				conn.on("bitfield", () => {
					if (conn.countPiecesPublic() > 0 && !conn.amInterested) {
						conn.sendInterested();
					}
				});
				conn.on("disconnect", () => {
					this.connections.delete(key);
					this.emit("peerRemoved", conn);
				});
				conn.on("dhtPort", (dhtPort: number) => {
					this.emit("dhtPort", { ip: conn.address, port: dhtPort });
				});
				this.connections.set(key, conn);
				conn.adoptConnectedSocket(socket, remainder, {
					peerId: result.peerId,
					reserved: result.reserved,
					localMetadata: this.infoBytes,
				});
				this.emit("peerAdded", conn);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log("handshake", `FAIL (inbound)  ${msg}`);
				socket.destroy();
			}
		};

		socket.on("data", onData);
	}

	getUnchoked(): PeerConnection[] {
		return [...this.connections.values()].filter((c) => !c.amChoked);
	}

	startChoking(): void {
		// BEP 3: recalculate every 10s, optimistic rotates every 30s
		this.chokeTimer = setInterval(() => this.recalculateChokes(), 10_000);
		this.optimisticTimer = setInterval(
			() => this.rotateOptimisticUnchoke(),
			30_000,
		);
		// Run immediately so peers are unchoked on download start
		this.recalculateChokes();
	}

	stopChoking(): void {
		if (this.chokeTimer) clearInterval(this.chokeTimer);
		if (this.optimisticTimer) clearInterval(this.optimisticTimer);
		this.chokeTimer = null;
		this.optimisticTimer = null;
	}

	private recalculateChokes(): void {
		const peers = [...this.connections.values()];

		// Snapshot rates and reset interval counters
		for (const p of peers) {
			p.downloadBytesPerSec = p.downloadedThisInterval;
			p.uploadBytesPerSec = p.uploadedThisInterval;
			p.downloadedThisInterval = 0;
			p.uploadedThisInterval = 0;
		}

		// BEP 3: unchoke top 4 by download rate from them (reciprocation)
		const interested = peers.filter((p) => p.peerInterested);
		const sorted = [...interested].sort(
			(a, b) => b.downloadBytesPerSec - a.downloadBytesPerSec,
		);
		const toUnchoke = new Set<string>();

		for (let i = 0; i < Math.min(4, sorted.length); i++) {
			const p = sorted[i];
			if (p) toUnchoke.add(`${p.address}:${p.port}`);
		}
		if (this.optimisticKey) toUnchoke.add(this.optimisticKey);

		// Apply choke/unchoke changes
		for (const p of peers) {
			const key = `${p.address}:${p.port}`;
			const shouldUnchoke = toUnchoke.has(key);
			const wasUnchoked = this.unchokedKeys.has(key);
			if (shouldUnchoke && !wasUnchoked) p.sendUnchoke();
			else if (!shouldUnchoke && wasUnchoked) p.sendChoke();
		}
		this.unchokedKeys = toUnchoke;

		if (toUnchoke.size > 0) {
			const labels = [...toUnchoke]
				.slice(0, 4)
				.map((k) => {
					const c = this.connections.get(k);
					const mbps = ((c?.downloadBytesPerSec ?? 0) / (1024 * 1024)).toFixed(
						1,
					);
					return `${c?.peerId.slice(0, 8) ?? k}(${mbps})`;
				})
				.join("  ");
			const optLabel = this.optimisticKey
				? `  opt: ${this.connections.get(this.optimisticKey)?.peerId.slice(0, 8) ?? this.optimisticKey}`
				: "";
			log("unchoke", `${labels}${optLabel}`);
		}
	}

	private rotateOptimisticUnchoke(): void {
		const choked = [...this.connections.values()].filter(
			(p) =>
				!this.unchokedKeys.has(`${p.address}:${p.port}`) && p.peerInterested,
		);
		if (choked.length === 0) return;

		// BEP 3: new connections are 3× as likely — simplified: just pick random
		const pick = choked[Math.floor(Math.random() * choked.length)];
		if (!pick) return;

		const key = `${pick.address}:${pick.port}`;
		if (this.optimisticKey && this.optimisticKey !== key) {
			// Choke the previous optimistic peer if not in regular slots
			if (!this.unchokedKeys.has(this.optimisticKey)) {
				this.connections.get(this.optimisticKey)?.sendChoke();
			}
		}
		this.optimisticKey = key;
		pick.sendUnchoke();
		this.unchokedKeys.add(key);
		log("unchoke-opt", `${pick.peerId.slice(0, 8)}  (optimistic slot)`);
	}

	private dedup(peers: PeerInfo[]): PeerInfo[] {
		const seen = new Set<string>();
		return peers.filter((p) => {
			const k = `${p.ip}:${p.port}`;
			if (this.bannedPeers.has(k) || this.connections.has(k)) return false;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	}

	ban(peer: PeerInfo): void {
		const key = `${peer.ip}:${peer.port}`;
		this.bannedPeers.add(key);
		this.connections.get(key)?.destroy();
	}

	hasPeer(peer: PeerInfo): boolean {
		const key = `${peer.ip}:${peer.port}`;
		return this.connections.has(key) || this.bannedPeers.has(key);
	}

	availableSlots(): number {
		return Math.max(0, this.maxConnections - this.connections.size);
	}

	listenPort(): number {
		return this.listener.port;
	}

	close(): void {
		this.stopChoking();
		for (const conn of this.connections.values()) {
			conn.suppressDisconnect = true;
			conn.destroy();
		}
		this.connections.clear();
		this.listener.close();
	}
}
