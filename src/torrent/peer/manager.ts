import { EventEmitter } from "node:events";
import { log } from "../metadata.ts";
import { PeerConnection } from "./connection.ts";
import { PeerListener } from "./listener.ts";
import { buildHandshake, parseHandshake, HANDSHAKE_LEN } from "./handshake.ts";
import { getPeerId } from "./peer-id.ts";
import type { TorrentMetadata } from "../metadata.ts";
import type { PeerInfo } from "../types.ts";

export class PeerManager extends EventEmitter {
	readonly connections: Map<string, PeerConnection> = new Map();
	private listener: PeerListener;
	private maxConnections: number;
	private infoHash: Uint8Array;
	private pieceCount: number;

	constructor(metadata: TorrentMetadata, maxConnections = 50) {
		super();
		this.infoHash = metadata.infoHash;
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
		if (this.connections.has(key)) return;

		const conn = new PeerConnection(ip, port, this.infoHash);

		conn.on("bitfield", () => {
			if (conn.countPiecesPublic() > 0 && !conn.amInterested) conn.sendInterested();
		});

		conn.on("disconnect", () => {
			this.connections.delete(key);
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
				socket.write(buildHandshake(this.infoHash, getPeerId()));

				const ip = socket.remoteAddress ?? "unknown";
				const port = socket.remotePort ?? 0;
				const key = `${ip}:${port}`;
				log("peer", `${key.padEnd(50)}  ok   ${result.peerId.slice(0, 8)}  (inbound)`);

				// Wrap the existing socket in a PeerConnection
				const conn = new PeerConnection(ip, port, this.infoHash);
				// Hand off the already-connected socket by replaying the remainder
				(conn as unknown as { socket: typeof socket }).socket = socket;
				(conn as unknown as { handshakeDone: boolean }).handshakeDone = true;
				(conn as unknown as { peerId: string }).peerId = result.peerId;

				const remainder = buf.slice(HANDSHAKE_LEN);
				if (remainder.length > 0) {
					socket.emit("data", Buffer.from(remainder));
				}

				socket.on("data", (c: Buffer) => socket.emit("data", c));
				this.connections.set(key, conn);
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

	private dedup(peers: PeerInfo[]): PeerInfo[] {
		const seen = new Set<string>();
		return peers.filter((p) => {
			const k = `${p.ip}:${p.port}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	}

	private countBits(buf: Uint8Array): number {
		let n = 0;
		for (const byte of buf) {
			let b = byte;
			while (b) { n += b & 1; b >>>= 1; }
		}
		return n;
	}

	close(): void {
		for (const conn of this.connections.values()) {
			conn.suppressDisconnect = true;
			conn.destroy();
		}
		this.connections.clear();
		this.listener.close();
	}
}
