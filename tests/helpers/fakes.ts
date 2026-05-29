import { EventEmitter } from "node:events";
import type { PeerConnection } from "../../src/torrent/peer/connection.ts";
import type { PeerManager } from "../../src/torrent/peer/manager.ts";

export interface RecordedRequest {
	index: number;
	begin: number;
	length: number;
}

export class FakePeer extends EventEmitter {
	readonly address: string;
	readonly port: number;
	peerId = "-FAKE000-abcdefgh1234";
	amChoked = false;
	amInterested = false;
	peerChoked = false;
	peerInterested = false;
	piecesBitfield = new Uint8Array(0);
	suppressDisconnect = false;
	downloadedThisInterval = 0;
	uploadedThisInterval = 0;
	downloadBytesPerSec = 0;
	uploadBytesPerSec = 0;
	uploadedTotal = 0;
	readonly requests: RecordedRequest[] = [];
	readonly cancels: RecordedRequest[] = [];
	readonly haves: number[] = [];
	readonly bitfields: Uint8Array[] = [];
	destroyed = false;

	constructor(
		address: string,
		port: number,
		private readonly pieces: Set<number>,
	) {
		super();
		this.address = address;
		this.port = port;
	}

	hasPiece(index: number): boolean {
		return this.pieces.has(index);
	}

	countPiecesPublic(): number {
		return this.pieces.size;
	}

	sendInterested(): void {
		this.amInterested = true;
	}

	sendNotInterested(): void {
		this.amInterested = false;
	}

	sendRequest(index: number, begin: number, length: number): void {
		this.requests.push({ index, begin, length });
	}

	sendCancel(index: number, begin: number, length: number): void {
		this.cancels.push({ index, begin, length });
	}

	sendHave(index: number): void {
		this.haves.push(index);
	}

	sendBitfield(bitfield: Uint8Array): void {
		this.bitfields.push(bitfield);
	}

	sendChoke(): void {
		this.peerChoked = true;
	}

	sendUnchoke(): void {
		this.peerChoked = false;
	}

	sendPiece(): void {
		this.uploadedThisInterval += 1;
		this.uploadedTotal += 1;
	}

	destroy(): void {
		this.destroyed = true;
		this.emit("disconnect");
	}

	asConnection(): PeerConnection {
		return this as unknown as PeerConnection;
	}
}

export class FakePeerManager extends EventEmitter {
	readonly connections: Map<string, PeerConnection> = new Map();

	constructor(peers: FakePeer[] = []) {
		super();
		for (const peer of peers) {
			this.connections.set(`${peer.address}:${peer.port}`, peer.asConnection());
		}
	}

	addPeer(peer: FakePeer): void {
		this.connections.set(`${peer.address}:${peer.port}`, peer.asConnection());
		this.emit("peerAdded", peer.asConnection());
	}

	asManager(): PeerManager {
		return this as unknown as PeerManager;
	}
}
