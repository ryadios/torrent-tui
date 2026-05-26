import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { log } from "../metadata.ts";
import { getPeerId } from "../peer/peer-id.ts";
import type { TorrentMetadata } from "../metadata.ts";
import type { PeerInfo } from "../types.ts";

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
	metadata: TorrentMetadata,
	listenPort: number,
): { buf: Buffer; txId: number } {
	const buf = Buffer.alloc(98);
	const view = new DataView(buf.buffer);
	let offset = 0;

	view.setBigUint64(offset, connId); offset += 8;
	view.setInt32(offset, ANNOUNCE_ACTION); offset += 4;
	const txId = randomTransactionId();
	view.setUint32(offset, txId); offset += 4;
	buf.set(metadata.infoHash, offset); offset += 20;
	buf.set(getPeerId(), offset); offset += 20;
	view.setBigInt64(offset, 0n); offset += 8;            // downloaded
	view.setBigInt64(offset, BigInt(metadata.totalSize)); offset += 8; // left
	view.setBigInt64(offset, 0n); offset += 8;            // uploaded
	view.setInt32(offset, 2); offset += 4;                // event: started
	view.setUint32(offset, 0); offset += 4;               // ip: default
	view.setUint32(offset, 0); offset += 4;               // key
	view.setInt32(offset, 50); offset += 4;               // num_want
	view.setUint16(offset, listenPort);                    // port

	return { buf, txId };
}

function parseCompactPeers(buf: Buffer, offset: number): PeerInfo[] {
	const peers: PeerInfo[] = [];
	while (offset + 6 <= buf.length) {
		const ip = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
		const port = buf.readUInt16BE(offset + 4);
		peers.push({ ip, port });
		offset += 6;
	}
	return peers;
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
			if (err) { clearTimeout(timer); reject(err); }
		});
	});
}

export async function announceUDP(
	url: string,
	metadata: TorrentMetadata,
	listenPort = 6881,
): Promise<PeerInfo[]> {
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
			if (view.getInt32(0) !== CONNECT_ACTION) throw new Error("bad connect action");
			if (view.getUint32(4) !== connectTx) throw new Error("connect txId mismatch");
			const connId = view.getBigUint64(8);

			// Step 2: announce
			const { buf: annBuf, txId: annTx } = buildAnnounceRequest(connId, metadata, listenPort);
			const annResp = await sendAndReceive(socket, annBuf, host, port);

			const annView = new DataView(annResp.buffer, annResp.byteOffset);
			if (annView.getInt32(0) !== ANNOUNCE_ACTION) throw new Error("bad announce action");
			if (annView.getUint32(4) !== annTx) throw new Error("announce txId mismatch");

			const peers = parseCompactPeers(annResp, 20);
			log("tracker", `udp://${label}   ${peers.length} peers`);
			return peers;
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
