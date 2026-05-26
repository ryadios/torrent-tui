import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { log } from "../metadata.ts";
import { MessageBuffer } from "./message-buffer.ts";
import {
	MSG,
	decode as decodeMsg,
	encode as encodeMsg,
	encodeHave,
	encodeRequest,
	encodeCancel,
	decodeHave,
	decodePiece,
	decodeRequest,
} from "./protocol.ts";
import { buildHandshake, parseHandshake, HANDSHAKE_LEN } from "./handshake.ts";
import { getPeerId } from "./peer-id.ts";

const KEEPALIVE_INTERVAL_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;

export class PeerConnection extends EventEmitter {
	readonly address: string;
	readonly port: number;
	peerId: string = "";

	amChoked = true;
	amInterested = false;
	peerChoked = true;
	peerInterested = false;
	piecesBitfield: Uint8Array = new Uint8Array(0);
	suppressDisconnect = false;

	// Per-peer rate tracking — reset every 10s by PeerManager
	downloadedThisInterval = 0;
	uploadedThisInterval = 0;
	downloadBytesPerSec = 0;
	uploadBytesPerSec = 0;

	private socket: Socket | null = null;
	private buf = new MessageBuffer();
	private handshakeDone = false;
	private handshakeBuffer = new Uint8Array(0);
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private infoHash: Uint8Array;
	private settle?: (err?: Error) => void;

	constructor(
		address: string,
		port: number,
		infoHash: Uint8Array,
	) {
		super();
		this.address = address;
		this.port = port;
		this.infoHash = infoHash;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			this.settle = (err?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout); // clear here so 10s guard stays active until handshake
				this.settle = undefined;
				if (err) reject(err);
				else resolve();
			};

			const sock = createConnection({ host: this.address, port: this.port });
			this.socket = sock;

			// 10s covers both TCP connect AND handshake completion.
			// Do NOT clear on TCP connect — only clear when promise settles.
			const timeout = setTimeout(() => {
				log("timeout", `${this.address}:${this.port}  after ${CONNECT_TIMEOUT_MS / 1000}s`);
				sock.destroy();
				this.settle?.(new Error("connect timeout"));
			}, CONNECT_TIMEOUT_MS);

			sock.once("connect", () => {
				sock.write(buildHandshake(this.infoHash, getPeerId()));
				this.resetIdleTimer();
				// Timeout continues running until handshake completes or times out
			});

			sock.on("data", (chunk: Buffer) => {
				this.resetIdleTimer();
				this.onData(new Uint8Array(chunk));
			});

			sock.once("error", (err) => {
				log("error", `${this.address}:${this.port}  ${err.message}`);
				this.settle?.(err); // settle() clears timeout
			});

			sock.once("close", () => {
				this.cleanup();
				this.settle?.(new Error("closed before handshake"));
				this.emit("disconnect");
			});
		});
	}

	private onData(chunk: Uint8Array): void {
		if (!this.handshakeDone) {
			// Accumulate until we have 68 bytes
			const merged = new Uint8Array(this.handshakeBuffer.length + chunk.length);
			merged.set(this.handshakeBuffer);
			merged.set(chunk, this.handshakeBuffer.length);
			this.handshakeBuffer = merged;

			if (this.handshakeBuffer.length < HANDSHAKE_LEN) return;

			try {
				const result = parseHandshake(this.handshakeBuffer, this.infoHash);
				this.peerId = result.peerId;
				this.handshakeDone = true;
				this.startKeepalive();
				log("handshake", `${this.address}:${this.port}   ${this.peerId.slice(0, 8)}`);
				this.settle?.(); // resolve the connect() promise
				const remainder = this.handshakeBuffer.slice(HANDSHAKE_LEN);
				this.handshakeBuffer = new Uint8Array(0);
				if (remainder.length > 0) this.onMessages(this.buf.push(remainder));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log("handshake", `${this.address}:${this.port}   fail  ${msg}`);
				this.settle?.(new Error(msg));
				this.socket?.destroy();
			}
			return;
		}

		this.onMessages(this.buf.push(chunk));
	}

	private onMessages(messages: Uint8Array[]): void {
		for (const raw of messages) {
			const msg = decodeMsg(raw);
			switch (msg.type) {
				case MSG.CHOKE:
					this.amChoked = true;
					this.emit("choke");
					break;
				case MSG.UNCHOKE:
					this.amChoked = false;
					this.emit("unchoke");
					break;
				case MSG.INTERESTED:
					this.peerInterested = true;
					break;
				case MSG.NOT_INTERESTED:
					this.peerInterested = false;
					break;
				case MSG.HAVE:
					if (msg.payload) {
						const idx = decodeHave(msg.payload);
						this.emit("have", idx);
					}
					break;
				case MSG.BITFIELD:
					if (msg.payload) {
						this.piecesBitfield = msg.payload;
						this.emit("bitfield", msg.payload);
					}
					break;
				case MSG.PIECE:
					if (msg.payload) {
						const { index, begin, block } = decodePiece(msg.payload);
						this.downloadedThisInterval += block.length;
						this.emit("piece", index, begin, block);
					}
					break;
				case MSG.REQUEST:
					if (msg.payload) {
						const req = decodeRequest(msg.payload);
						this.emit("request", req.index, req.begin, req.length);
					}
					break;
				case MSG.KEEPALIVE:
					break;
			}
		}
	}

	countPiecesPublic(): number {
		let n = 0;
		for (const byte of this.piecesBitfield) {
			let b = byte;
			while (b) { n += b & 1; b >>>= 1; }
		}
		return n;
	}

	hasPiece(index: number): boolean {
		const byte = Math.floor(index / 8);
		const bit = 7 - (index % 8);
		return ((this.piecesBitfield[byte] ?? 0) & (1 << bit)) !== 0;
	}

	sendInterested(): void {
		this.amInterested = true;
		this.write(encodeMsg({ type: MSG.INTERESTED }));
	}

	sendNotInterested(): void {
		this.amInterested = false;
		this.write(encodeMsg({ type: MSG.NOT_INTERESTED }));
	}

	sendRequest(index: number, begin: number, length: number): void {
		this.write(encodeRequest(index, begin, length));
	}

	sendCancel(index: number, begin: number, length: number): void {
		this.write(encodeCancel(index, begin, length));
	}

	sendHave(index: number): void {
		this.write(encodeHave(index));
	}

	sendBitfield(bitfield: Uint8Array): void {
		this.write(encodeMsg({ type: MSG.BITFIELD, payload: bitfield }));
	}

	sendChoke(): void {
		this.peerChoked = true;
		this.write(encodeMsg({ type: MSG.CHOKE }));
	}

	sendUnchoke(): void {
		this.peerChoked = false;
		this.write(encodeMsg({ type: MSG.UNCHOKE }));
	}

	sendPiece(index: number, begin: number, block: Uint8Array): void {
		const payload = new Uint8Array(8 + block.length);
		const view = new DataView(payload.buffer);
		view.setUint32(0, index);
		view.setUint32(4, begin);
		payload.set(block, 8);
		this.write(encodeMsg({ type: MSG.PIECE, payload }));
		this.uploadedThisInterval += block.length;
	}

	private startKeepalive(): void {
		this.keepaliveTimer = setInterval(() => {
			this.write(encodeMsg({ type: MSG.KEEPALIVE }));
		}, KEEPALIVE_INTERVAL_MS);
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			log("timeout", `${this.address}:${this.port}  idle`);
			this.socket?.destroy();
		}, IDLE_TIMEOUT_MS);
	}

	private write(data: Uint8Array): void {
		this.socket?.write(data);
	}

	private cleanup(): void {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		if (this.idleTimer) clearTimeout(this.idleTimer);
	}

	destroy(): void {
		this.cleanup();
		this.socket?.destroy();
	}
}
