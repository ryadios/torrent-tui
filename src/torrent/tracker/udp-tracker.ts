import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { log } from "../metadata.ts";
import { getPeerId } from "../peer/peer-id.ts";
import type {
	PeerInfo,
	TrackerAnnounceRequest,
	TrackerAnnounceTarget,
	TrackerEvent,
	TrackerResponse,
} from "../types.ts";

const CONNECT_MAGIC = 0x41727101980n; // BEP 15 magic connection ID
const CONNECT_ACTION = 0;
const ANNOUNCE_ACTION = 1;
const TIMEOUT_MS = 5_000;
const MAX_RETRIES = 1; // no retries on initial announce — re-announces can retry later

function randomTransactionId(): number {
	return randomBytes(4).readUInt32BE(0);
}

function buildConnectRequest(): { buf: Buffer; txId: number } {
	const buf = Buffer.alloc(16);
	const view = new DataView(buf.buffer);
	view.setBigInt64(0, CONNECT_MAGIC);
	view.setInt32(8, CONNECT_ACTION);
	const txId = randomTransactionId();
	view.setUint32(12, txId);
	return { buf, txId };
}

function buildAnnounceRequest(
	connId: bigint, // treated as unsigned
	metadata: TrackerAnnounceTarget,
	request: TrackerAnnounceRequest,
): { buf: Buffer; txId: number } {
	const buf = Buffer.alloc(98);
	const view = new DataView(buf.buffer);
	let offset = 0;
	const peerId = request.peerId ?? getPeerId();

	view.setBigUint64(offset, connId);
	offset += 8;
	view.setInt32(offset, ANNOUNCE_ACTION);
	offset += 4;
	const txId = randomTransactionId();
	view.setUint32(offset, txId);
	offset += 4;
	buf.set(metadata.infoHash, offset);
	offset += 20;
	buf.set(peerId, offset);
	offset += 20;
	view.setBigInt64(offset, BigInt(request.downloaded));
	offset += 8; // downloaded
	view.setBigInt64(offset, BigInt(request.left));
	offset += 8; // left
	view.setBigInt64(offset, BigInt(request.uploaded));
	offset += 8; // uploaded
	view.setInt32(offset, trackerEventCode(request.event));
	offset += 4;
	view.setUint32(offset, 0);
	offset += 4; // ip: default
	view.setUint32(offset, 0);
	offset += 4; // key
	view.setInt32(offset, request.numwant);
	offset += 4; // num_want
	view.setUint16(offset, request.port); // port

	return { buf, txId };
}

export function trackerEventCode(event: TrackerEvent | undefined): number {
	switch (event) {
		case "completed":
			return 1;
		case "started":
			return 2;
		case "stopped":
			return 3;
		default:
			return 0;
	}
}

export function parseUDPCompactPeers(
	buf: Uint8Array,
	offset: number,
): PeerInfo[] {
	const peers: PeerInfo[] = [];
	if ((buf.length - offset) % 6 !== 0) {
		throw new Error("Invalid UDP compact peer data");
	}
	while (offset + 6 <= buf.length) {
		const ip = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
		const port = ((buf[offset + 4] ?? 0) << 8) | (buf[offset + 5] ?? 0);
		peers.push({ ip, port });
		offset += 6;
	}
	return peers;
}

export function parseUDPAnnounceResponse(
	buf: Uint8Array,
	expectedTxId: number,
): TrackerResponse {
	if (buf.length < 20) throw new Error("UDP announce response too short");
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (view.getInt32(0) !== ANNOUNCE_ACTION)
		throw new Error("bad announce action");
	if (view.getUint32(4) !== expectedTxId)
		throw new Error("announce txId mismatch");

	return {
		interval: view.getInt32(8),
		incomplete: view.getInt32(12),
		complete: view.getInt32(16),
		peers: parseUDPCompactPeers(buf, 20),
	};
}

function sendAndReceive(
	socket: ReturnType<typeof createSocket>,
	buf: Buffer,
	host: string,
	port: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("timeout"));
		}, TIMEOUT_MS);

		socket.once("message", (msg) => {
			clearTimeout(timer);
			resolve(msg as Buffer);
		});

		socket.send(buf, port, host, (err) => {
			if (err) {
				clearTimeout(timer);
				reject(err);
			}
		});
	});
}

export async function announceUDP(
	url: string,
	metadata: TrackerAnnounceTarget,
	request: TrackerAnnounceRequest,
): Promise<TrackerResponse> {
	const parsed = new URL(url);
	const host = parsed.hostname;
	const port = Number(parsed.port) || 80;
	const label = `${host}:${port}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const socket = createSocket("udp4");

		try {
			// Step 1: connect
			const { buf: connectBuf, txId: connectTx } = buildConnectRequest();
			const connectResp = await sendAndReceive(socket, connectBuf, host, port);

			const view = new DataView(connectResp.buffer, connectResp.byteOffset);
			if (view.getInt32(0) !== CONNECT_ACTION)
				throw new Error("bad connect action");
			if (view.getUint32(4) !== connectTx)
				throw new Error("connect txId mismatch");
			const connId = view.getBigUint64(8);

			// Step 2: announce
			const { buf: annBuf, txId: annTx } = buildAnnounceRequest(
				connId,
				metadata,
				request,
			);
			const annResp = await sendAndReceive(socket, annBuf, host, port);

			const response = parseUDPAnnounceResponse(annResp, annTx);
			log("tracker", `udp://${label}   ${response.peers.length} peers`);
			return response;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt < MAX_RETRIES) {
				// silent retry
			} else {
				log("tracker", `udp://${label}   failed  ${msg}`);
				throw err;
			}
		} finally {
			socket.close();
		}
	}

	throw new Error("max retries exceeded");
}
