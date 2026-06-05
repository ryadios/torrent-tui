import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import { log } from "../metadata.ts";
import {
	buildExtensionReservedBytes,
	decodeExtendedMessage,
	decodeExtensionHandshake,
	decodeUtMetadataMessage,
	decodeUtPexMessage,
	EXT_HANDSHAKE_ID,
	encodeExtendedMessage,
	encodeExtensionHandshake,
	encodeUtMetadataData,
	encodeUtMetadataReject,
	encodeUtMetadataRequest,
	encodeUtPexMessage,
	LOCAL_UT_METADATA_ID,
	LOCAL_UT_PEX_ID,
	METADATA_BLOCK_SIZE,
	supportsExtensionProtocol,
	type UtPexMessage,
} from "./extension.ts";
import { buildHandshake, HANDSHAKE_LEN, parseHandshake } from "./handshake.ts";
import { MessageBuffer } from "./message-buffer.ts";
import {
	type EncryptionPolicy,
	initiateMseHandshake,
	type MseStream,
} from "./mse.ts";
import { getPeerId } from "./peer-id.ts";
import {
	decodeHave,
	decode as decodeMsg,
	decodePiece,
	decodePort,
	decodeRequest,
	encodeCancel,
	encodeHave,
	encode as encodeMsg,
	encodePort,
	encodeRequest,
	MSG,
} from "./protocol.ts";

const KEEPALIVE_INTERVAL_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;

interface AdoptConnectedSocketOptions {
	decrypt?: MseStream | null;
	encrypt?: MseStream | null;
	localMetadata?: Uint8Array | null;
	peerId: string;
	remainderDecrypted?: boolean;
	reserved: Uint8Array;
	sendLocalHandshake?: boolean;
}

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
	uploadedTotal = 0;

	private socket: Socket | null = null;
	private buf = new MessageBuffer();
	private handshakeDone = false;
	private handshakeBuffer = new Uint8Array(0);
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private infoHash: Uint8Array;
	private localMetadata: Uint8Array | null = null;
	private settle?: (err?: Error) => void;
	private decryptStream: MseStream | null = null;
	private encryptStream: MseStream | null = null;
	extensionCapable = false;
	peerExtensions: Map<string, number> = new Map();
	peerMetadataSize: number | null = null;
	private encryptionPolicy: EncryptionPolicy;

	constructor(
		address: string,
		port: number,
		infoHash: Uint8Array,
		options: {
			encryptionPolicy?: EncryptionPolicy;
			localMetadata?: Uint8Array | null;
		} = {},
	) {
		super();
		this.address = address;
		this.port = port;
		this.infoHash = infoHash;
		this.encryptionPolicy = options.encryptionPolicy ?? "preferred";
		this.localMetadata = options.localMetadata ?? null;
	}

	connect(): Promise<void> {
		return this.connectWithPolicy();
	}

	private async connectWithPolicy(): Promise<void> {
		if (this.encryptionPolicy === "required") {
			await this.connectAttempt(true);
			return;
		}
		if (this.encryptionPolicy === "preferred") {
			try {
				await this.connectAttempt(true);
				return;
			} catch {
				this.cleanup();
				this.socket?.destroy();
				this.socket = null;
				this.handshakeDone = false;
				this.handshakeBuffer = new Uint8Array(0);
				this.decryptStream = null;
				this.encryptStream = null;
				await this.connectAttempt(false);
				return;
			}
		}
		await this.connectAttempt(false);
	}

	private connectAttempt(encrypted: boolean): Promise<void> {
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
				log(
					"timeout",
					`${this.address}:${this.port}  after ${CONNECT_TIMEOUT_MS / 1000}s`,
				);
				sock.destroy();
				this.settle?.(new Error("connect timeout"));
			}, CONNECT_TIMEOUT_MS);

			sock.once("connect", () => {
				this.resetIdleTimer();
				if (!encrypted) {
					this.installSocketHandlers(sock);
					sock.write(
						buildHandshake(
							this.infoHash,
							getPeerId(),
							buildExtensionReservedBytes(),
						),
					);
					return;
				}
				void this.finishEncryptedConnect(sock).catch((err: unknown) => {
					this.settle?.(err instanceof Error ? err : new Error(String(err)));
					sock.destroy();
				});
			});

			sock.once("error", (err) => {
				log("error", `${this.address}:${this.port}  ${err.message}`);
				this.settle?.(err); // settle() clears timeout
			});

			sock.once("close", this.onSocketClose);
		});
	}

	private async finishEncryptedConnect(sock: Socket): Promise<void> {
		const result = await initiateMseHandshake(
			sock,
			this.infoHash,
			this.encryptionPolicy,
			buildHandshake(this.infoHash, getPeerId(), buildExtensionReservedBytes()),
		);
		this.decryptStream = result.decrypt;
		this.encryptStream = result.encrypt;
		this.installSocketHandlers(sock);
		if (result.initialData.length > 0) this.onPlainData(result.initialData);
	}

	adoptConnectedSocket(
		socket: Socket,
		remainder: Uint8Array,
		options: AdoptConnectedSocketOptions,
	): void {
		this.socket = socket;
		this.peerId = options.peerId;
		this.decryptStream = options.decrypt ?? null;
		this.encryptStream = options.encrypt ?? null;
		this.extensionCapable = supportsExtensionProtocol(options.reserved);
		this.handshakeDone = true;
		this.handshakeBuffer = new Uint8Array(0);
		this.localMetadata = options.localMetadata ?? null;
		this.startKeepalive();
		this.resetIdleTimer();

		this.installSocketHandlers(socket);

		if (options.sendLocalHandshake) {
			this.write(
				buildHandshake(
					this.infoHash,
					getPeerId(),
					buildExtensionReservedBytes(),
				),
			);
		}

		if (this.extensionCapable) this.sendExtensionHandshake();
		if (remainder.length > 0) {
			if (options.remainderDecrypted) this.onPlainData(remainder);
			else this.onData(remainder);
		}
	}

	private onData(chunk: Uint8Array): void {
		const data = this.decryptStream ? this.decryptStream.update(chunk) : chunk;
		this.onPlainData(data);
	}

	private onPlainData(data: Uint8Array): void {
		if (!this.handshakeDone) {
			// Accumulate until we have 68 bytes
			const merged = new Uint8Array(this.handshakeBuffer.length + data.length);
			merged.set(this.handshakeBuffer);
			merged.set(new Uint8Array(data), this.handshakeBuffer.length);
			this.handshakeBuffer = merged;

			if (this.handshakeBuffer.length < HANDSHAKE_LEN) return;

			try {
				const result = parseHandshake(this.handshakeBuffer, this.infoHash);
				this.peerId = result.peerId;
				this.extensionCapable = supportsExtensionProtocol(result.reserved);
				this.handshakeDone = true;
				this.startKeepalive();
				log(
					"handshake",
					`${this.address}:${this.port}   ${this.peerId.slice(0, 8)}`,
				);
				this.settle?.(); // resolve the connect() promise
				if (this.extensionCapable) this.sendExtensionHandshake();
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

		this.onMessages(this.buf.push(new Uint8Array(data)));
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
				case MSG.PORT:
					if (msg.payload) this.emit("dhtPort", decodePort(msg.payload));
					break;
				case MSG.EXTENDED:
					if (msg.payload) this.onExtendedMessage(msg.payload);
					break;
				case MSG.KEEPALIVE:
					break;
			}
		}
	}

	private onExtendedMessage(payload: Uint8Array): void {
		try {
			const extended = decodeExtendedMessage(payload);
			if (extended.extensionId === EXT_HANDSHAKE_ID) {
				const handshake = decodeExtensionHandshake(extended.payload);
				this.peerExtensions = handshake.extensions;
				this.peerMetadataSize = handshake.metadataSize ?? null;
				this.emit("extensionHandshake", handshake);
				return;
			}
			if (extended.extensionId === LOCAL_UT_METADATA_ID) {
				const msg = decodeUtMetadataMessage(extended.payload);
				if (msg.msgType === 0) {
					this.handleMetadataRequest(msg.piece);
				} else {
					this.emit("utMetadata", msg);
				}
				return;
			}
			if (extended.extensionId === LOCAL_UT_PEX_ID) {
				this.emit("utPex", decodeUtPexMessage(extended.payload));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log("extension", `${this.address}:${this.port}   ignored  ${msg}`);
		}
	}

	private handleMetadataRequest(piece: number): void {
		if (!this.localMetadata) {
			this.sendUtMetadataReject(piece);
			return;
		}
		const start = piece * METADATA_BLOCK_SIZE;
		const end = Math.min(
			start + METADATA_BLOCK_SIZE,
			this.localMetadata.length,
		);
		if (start < 0 || start >= this.localMetadata.length) {
			this.sendUtMetadataReject(piece);
			return;
		}
		this.write(
			encodeMsg({
				type: MSG.EXTENDED,
				payload: encodeExtendedMessage(
					this.peerExtensions.get("ut_metadata") ?? LOCAL_UT_METADATA_ID,
					encodeUtMetadataData(
						piece,
						this.localMetadata.length,
						this.localMetadata.slice(start, end),
					),
				),
			}),
		);
	}

	countPiecesPublic(): number {
		let n = 0;
		for (const byte of this.piecesBitfield) {
			let b = byte;
			while (b) {
				n += b & 1;
				b >>>= 1;
			}
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

	setLocalMetadata(infoBytes: Uint8Array): void {
		this.localMetadata = infoBytes;
	}

	sendExtensionHandshake(): void {
		this.write(
			encodeMsg({
				type: MSG.EXTENDED,
				payload: encodeExtensionHandshake({
					metadataSize: this.localMetadata?.length,
				}),
			}),
		);
	}

	sendDhtPort(port: number): void {
		this.write(encodePort(port));
	}

	sendUtPex(message: UtPexMessage): void {
		const id = this.peerExtensions.get("ut_pex");
		if (!id) return;
		this.write(
			encodeMsg({
				type: MSG.EXTENDED,
				payload: encodeExtendedMessage(id, encodeUtPexMessage(message)),
			}),
		);
	}

	requestMetadataPiece(piece: number): void {
		const id = this.peerExtensions.get("ut_metadata");
		if (!id) return;
		this.write(
			encodeMsg({
				type: MSG.EXTENDED,
				payload: encodeExtendedMessage(id, encodeUtMetadataRequest(piece)),
			}),
		);
	}

	sendUtMetadataReject(piece: number): void {
		const id = this.peerExtensions.get("ut_metadata") ?? LOCAL_UT_METADATA_ID;
		this.write(
			encodeMsg({
				type: MSG.EXTENDED,
				payload: encodeExtendedMessage(id, encodeUtMetadataReject(piece)),
			}),
		);
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
		this.uploadedTotal += block.length;
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
		this.socket?.write(
			this.encryptStream ? this.encryptStream.update(data) : data,
		);
	}

	private cleanup(): void {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		if (this.idleTimer) clearTimeout(this.idleTimer);
	}

	destroy(): void {
		this.cleanup();
		this.socket?.destroy();
	}

	private installSocketHandlers(socket: Socket): void {
		socket.on("data", (chunk: Buffer) => {
			this.resetIdleTimer();
			this.onData(new Uint8Array(chunk));
		});
		socket.once("error", (err) => {
			log("error", `${this.address}:${this.port}  ${err.message}`);
		});
	}

	private readonly onSocketClose = (): void => {
		this.cleanup();
		this.settle?.(new Error("closed before handshake"));
		this.emit("disconnect");
	};
}
