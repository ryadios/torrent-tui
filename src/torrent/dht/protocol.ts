import type { BencodeValue } from "../parser.ts";
import { decode, encode } from "../parser.ts";
import type { PeerInfo } from "../types.ts";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export const DHT_K = 8;
export const DHT_NODE_ID_LENGTH = 20;
export const DEFAULT_BOOTSTRAP_NODES: PeerInfo[] = [
	{ ip: "router.bittorrent.com", port: 6881 },
	{ ip: "router.utorrent.com", port: 6881 },
	{ ip: "dht.transmissionbt.com", port: 6881 },
];

export interface DhtNode extends PeerInfo {
	id: Uint8Array;
}

export type DhtQueryName = "ping" | "find_node" | "get_peers" | "announce_peer";

export interface DhtMessage {
	transactionId: Uint8Array;
	type: "query" | "response" | "error";
	query?: DhtQueryName;
	args?: Record<string, BencodeValue>;
	response?: Record<string, BencodeValue>;
	error?: { code: number; message: string };
}

export function randomNodeId(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(DHT_NODE_ID_LENGTH));
}

export function nodeIdHex(id: Uint8Array): string {
	return [...id].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function nodeIdFromHex(hex: string): Uint8Array {
	if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error("Invalid DHT node id");
	const out = new Uint8Array(20);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export function transactionId(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(2));
}

export function transactionKey(id: Uint8Array): string {
	return TEXT_DECODER.decode(id);
}

export function compactPeers(peers: PeerInfo[]): Uint8Array {
	const out = new Uint8Array(peers.length * 6);
	let offset = 0;
	for (const peer of peers) {
		const parts = peer.ip.split(".").map((part) => Number(part));
		if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
			throw new Error(`Cannot compact non-IPv4 peer: ${peer.ip}`);
		}
		out.set(parts, offset);
		out[offset + 4] = (peer.port >>> 8) & 0xff;
		out[offset + 5] = peer.port & 0xff;
		offset += 6;
	}
	return out;
}

export function parseCompactPeers(data: Uint8Array): PeerInfo[] {
	const peers: PeerInfo[] = [];
	for (let offset = 0; offset + 6 <= data.length; offset += 6) {
		const ip = `${data[offset] ?? 0}.${data[offset + 1] ?? 0}.${data[offset + 2] ?? 0}.${data[offset + 3] ?? 0}`;
		const port = ((data[offset + 4] ?? 0) << 8) | (data[offset + 5] ?? 0);
		if (port > 0) peers.push({ ip, port });
	}
	return peers;
}

export function compactNodes(nodes: DhtNode[]): Uint8Array {
	const out = new Uint8Array(nodes.length * 26);
	let offset = 0;
	for (const node of nodes) {
		if (node.id.length !== DHT_NODE_ID_LENGTH) {
			throw new Error("DHT node id must be 20 bytes");
		}
		out.set(node.id, offset);
		out.set(compactPeers([{ ip: node.ip, port: node.port }]), offset + 20);
		offset += 26;
	}
	return out;
}

export function parseCompactNodes(data: Uint8Array): DhtNode[] {
	const nodes: DhtNode[] = [];
	for (let offset = 0; offset + 26 <= data.length; offset += 26) {
		const id = data.slice(offset, offset + 20);
		const [peer] = parseCompactPeers(data.slice(offset + 20, offset + 26));
		if (peer) nodes.push({ ...peer, id });
	}
	return nodes;
}

export function encodeDhtQuery(
	query: DhtQueryName,
	args: Record<string, BencodeValue>,
	id = transactionId(),
): Uint8Array {
	return encode({
		t: id,
		y: "q",
		q: query,
		a: args,
	});
}

export function encodeDhtResponse(
	id: Uint8Array,
	response: Record<string, BencodeValue>,
): Uint8Array {
	return encode({ t: id, y: "r", r: response });
}

export function decodeDhtMessage(data: Uint8Array): DhtMessage {
	const decoded = decode(data);
	if (!isDict(decoded)) throw new Error("Invalid DHT message");
	const transactionRaw = decoded.t;
	const typeRaw = decoded.y;
	if (!(transactionRaw instanceof Uint8Array)) {
		throw new Error("DHT message missing transaction id");
	}
	const type = bytesToString(typeRaw);
	if (type === "q") {
		const query = bytesToString(decoded.q);
		if (!isDhtQuery(query) || !isDict(decoded.a)) {
			throw new Error("Invalid DHT query");
		}
		return {
			transactionId: transactionRaw,
			type: "query",
			query,
			args: decoded.a,
		};
	}
	if (type === "r") {
		if (!isDict(decoded.r)) throw new Error("Invalid DHT response");
		return {
			transactionId: transactionRaw,
			type: "response",
			response: decoded.r,
		};
	}
	if (type === "e") {
		const error = Array.isArray(decoded.e) ? decoded.e : [];
		const code = typeof error[0] === "number" ? error[0] : 0;
		return {
			transactionId: transactionRaw,
			type: "error",
			error: { code, message: bytesToString(error[1]) ?? "DHT error" },
		};
	}
	throw new Error("Unknown DHT message type");
}

export function getResponseId(
	response: Record<string, BencodeValue>,
): Uint8Array | null {
	return response.id instanceof Uint8Array ? response.id : null;
}

export function getResponseToken(
	response: Record<string, BencodeValue>,
): Uint8Array | null {
	return response.token instanceof Uint8Array ? response.token : null;
}

export function getResponsePeers(
	response: Record<string, BencodeValue>,
): PeerInfo[] {
	const values = response.values;
	if (!Array.isArray(values)) return [];
	return values.flatMap((value) =>
		value instanceof Uint8Array ? parseCompactPeers(value) : [],
	);
}

export function getResponseNodes(
	response: Record<string, BencodeValue>,
): DhtNode[] {
	return response.nodes instanceof Uint8Array
		? parseCompactNodes(response.nodes)
		: [];
}

export function stringBytes(value: string): Uint8Array {
	return TEXT_ENCODER.encode(value);
}

function isDict(
	value: BencodeValue | undefined,
): value is Record<string, BencodeValue> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array)
	);
}

function bytesToString(value: BencodeValue | undefined): string | undefined {
	if (value instanceof Uint8Array) return TEXT_DECODER.decode(value);
	if (typeof value === "string") return value;
	return undefined;
}

function isDhtQuery(value: string | undefined): value is DhtQueryName {
	return (
		value === "ping" ||
		value === "find_node" ||
		value === "get_peers" ||
		value === "announce_peer"
	);
}
