import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../../utils/paths.ts";
import type { BencodeValue } from "../parser.ts";
import type { PeerInfo } from "../types.ts";
import {
	compactNodes,
	DEFAULT_BOOTSTRAP_NODES,
	type DhtMessage,
	type DhtNode,
	decodeDhtMessage,
	encodeDhtQuery,
	encodeDhtResponse,
	getResponseId,
	getResponseNodes,
	getResponsePeers,
	getResponseToken,
	nodeIdFromHex,
	nodeIdHex,
	randomNodeId,
	stringBytes,
	transactionId,
	transactionKey,
} from "./protocol.ts";
import { DhtRoutingTable, isUsablePeer, peerKey } from "./routing.ts";

const DHT_TIMEOUT_MS = 5_000;
const DHT_LOOKUP_ROUNDS = 4;
const DHT_ALPHA = 8;
const DHT_STATE_FILE = "dht.json";

interface PendingQuery {
	resolve: (message: DhtMessage) => void;
	reject: (error: Error) => void;
	timer: unknown;
}

interface UdpTransport {
	send(data: Uint8Array, port: number, host: string): Promise<void>;
	onMessage(cb: (data: Uint8Array, rinfo: RemoteInfo) => void): void;
	bind(port: number): Promise<number>;
	close(): void;
}

interface Scheduler {
	setTimeout(fn: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface DhtNodeOptions {
	nodeId?: Uint8Array;
	port?: number;
	bootstrapNodes?: PeerInfo[];
	transport?: UdpTransport;
	scheduler?: Scheduler;
	persist?: boolean;
}

export class DhtClient {
	readonly nodeId: Uint8Array;
	readonly routingTable: DhtRoutingTable;
	private readonly bootstrapNodes: PeerInfo[];
	private readonly transport: UdpTransport;
	private readonly scheduler: Scheduler;
	private readonly persist: boolean;
	private readonly pending = new Map<string, PendingQuery>();
	private started = false;
	private port = 0;

	constructor(options: DhtNodeOptions = {}) {
		const persisted = options.persist === false ? null : readDhtState();
		this.nodeId = options.nodeId ?? persisted?.nodeId ?? randomNodeId();
		this.routingTable = new DhtRoutingTable(this.nodeId);
		if (persisted) this.routingTable.addMany(persisted.nodes);
		this.bootstrapNodes = options.bootstrapNodes ?? [
			...DEFAULT_BOOTSTRAP_NODES,
			...this.routingTable.peers(),
		];
		this.transport = options.transport ?? new DgramTransport();
		this.scheduler = options.scheduler ?? {
			setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
			clearTimeout: (handle) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.persist = options.persist ?? true;
	}

	async start(port = 6881): Promise<void> {
		if (this.started) return;
		this.port = await this.transport.bind(port);
		this.transport.onMessage((data, rinfo) => this.onMessage(data, rinfo));
		this.started = true;
		await this.bootstrap();
	}

	async bootstrap(): Promise<void> {
		await Promise.allSettled(
			this.bootstrapNodes.map((peer) =>
				this.findNode(peer, this.nodeId).catch(() => undefined),
			),
		);
		this.save();
	}

	async getPeers(infoHash: Uint8Array): Promise<PeerInfo[]> {
		const peers = new Map<string, PeerInfo>();
		const queried = new Set<string>();
		let frontier = this.routingTable.closest(infoHash, DHT_ALPHA);
		if (frontier.length === 0) {
			frontier = this.bootstrapNodes.map((peer) => ({
				...peer,
				id: randomNodeId(),
			}));
		}

		for (let round = 0; round < DHT_LOOKUP_ROUNDS; round++) {
			const batch = frontier
				.filter((node) => !queried.has(peerKey(node)))
				.slice(0, DHT_ALPHA);
			if (batch.length === 0) break;
			for (const node of batch) queried.add(peerKey(node));
			const responses = await Promise.allSettled(
				batch.map((node) => this.getPeersFromNode(node, infoHash)),
			);
			for (const response of responses) {
				if (response.status !== "fulfilled") continue;
				for (const peer of response.value.peers) {
					if (isUsablePeer(peer)) peers.set(peerKey(peer), peer);
				}
				this.routingTable.addMany(response.value.nodes);
			}
			frontier = this.routingTable.closest(infoHash, DHT_ALPHA);
			if (peers.size > 0) break;
		}
		this.save();
		return [...peers.values()];
	}

	async announcePeer(infoHash: Uint8Array, port: number): Promise<void> {
		const closest = this.routingTable.closest(infoHash, DHT_ALPHA);
		await Promise.allSettled(
			closest.map(async (node) => {
				const result = await this.getPeersFromNode(node, infoHash);
				this.routingTable.addMany(result.nodes);
				if (!result.token) return;
				await this.query(node, "announce_peer", {
					id: this.nodeId,
					info_hash: infoHash,
					port,
					token: result.token,
					implied_port: 0,
				});
			}),
		);
		this.save();
	}

	close(): void {
		for (const pending of this.pending.values()) {
			this.scheduler.clearTimeout(pending.timer);
			pending.reject(new Error("DHT stopped"));
		}
		this.pending.clear();
		this.save();
		this.transport.close();
	}

	private async findNode(peer: PeerInfo, target: Uint8Array): Promise<void> {
		const message = await this.query(peer, "find_node", {
			id: this.nodeId,
			target,
		});
		if (message.type !== "response" || !message.response) return;
		const id = getResponseId(message.response);
		if (id) this.routingTable.add({ ...peer, id });
		this.routingTable.addMany(getResponseNodes(message.response));
	}

	private async getPeersFromNode(
		node: PeerInfo,
		infoHash: Uint8Array,
	): Promise<{
		peers: PeerInfo[];
		nodes: DhtNode[];
		token: Uint8Array | null;
	}> {
		const message = await this.query(node, "get_peers", {
			id: this.nodeId,
			info_hash: infoHash,
		});
		if (message.type !== "response" || !message.response) {
			return { peers: [], nodes: [], token: null };
		}
		const id = getResponseId(message.response);
		if (id) this.routingTable.add({ ...node, id });
		return {
			peers: getResponsePeers(message.response),
			nodes: getResponseNodes(message.response),
			token: getResponseToken(message.response),
		};
	}

	private query(
		peer: PeerInfo,
		query: "find_node" | "get_peers" | "announce_peer" | "ping",
		args: Record<string, BencodeValue>,
	): Promise<DhtMessage> {
		const tid = transactionId();
		const key = transactionKey(tid);
		const data = encodeDhtQuery(query, args, tid);
		return new Promise((resolve, reject) => {
			const timer = this.scheduler.setTimeout(() => {
				this.pending.delete(key);
				reject(new Error("DHT query timeout"));
			}, DHT_TIMEOUT_MS);
			this.pending.set(key, { resolve, reject, timer });
			void this.transport
				.send(data, peer.port, peer.ip)
				.catch((err: unknown) => {
					this.pending.delete(key);
					this.scheduler.clearTimeout(timer);
					reject(err instanceof Error ? err : new Error(String(err)));
				});
		});
	}

	private onMessage(data: Uint8Array, rinfo: RemoteInfo): void {
		let message: DhtMessage;
		try {
			message = decodeDhtMessage(data);
		} catch {
			return;
		}
		if (message.type === "query") {
			void this.handleQuery(message, rinfo);
			return;
		}
		const key = transactionKey(message.transactionId);
		const pending = this.pending.get(key);
		if (!pending) return;
		this.pending.delete(key);
		this.scheduler.clearTimeout(pending.timer);
		pending.resolve(message);
	}

	private async handleQuery(
		message: DhtMessage,
		rinfo: RemoteInfo,
	): Promise<void> {
		if (!message.query) return;
		const id = message.args?.id;
		if (id instanceof Uint8Array) {
			this.routingTable.add({ id, ip: rinfo.address, port: rinfo.port });
		}
		if (message.query === "ping") {
			await this.transport.send(
				encodeDhtResponse(message.transactionId, { id: this.nodeId }),
				rinfo.port,
				rinfo.address,
			);
			return;
		}
		if (message.query === "find_node" || message.query === "get_peers") {
			const target =
				message.query === "find_node" &&
				message.args?.target instanceof Uint8Array
					? message.args.target
					: message.args?.info_hash instanceof Uint8Array
						? message.args.info_hash
						: this.nodeId;
			await this.transport.send(
				encodeDhtResponse(message.transactionId, {
					id: this.nodeId,
					nodes: compactNodes(this.routingTable.closest(target)),
					token: stringBytes("tt"),
				}),
				rinfo.port,
				rinfo.address,
			);
		}
	}

	private save(): void {
		if (!this.persist) return;
		writeDhtState(this.nodeId, this.routingTable.snapshot());
	}
}

class DgramTransport implements UdpTransport {
	private socket: Socket | null = null;

	async bind(port: number): Promise<number> {
		this.socket = createSocket("udp4");
		return new Promise((resolve, reject) => {
			const socket = this.socket;
			if (!socket) {
				reject(new Error("DHT socket missing"));
				return;
			}
			socket.once("error", reject);
			socket.once("listening", () => {
				socket.removeListener("error", reject);
				const address = socket.address();
				resolve(typeof address === "object" ? address.port : port);
			});
			socket.bind(port);
		});
	}

	onMessage(cb: (data: Uint8Array, rinfo: RemoteInfo) => void): void {
		this.socket?.on("message", (data, rinfo) =>
			cb(new Uint8Array(data), rinfo),
		);
	}

	send(data: Uint8Array, port: number, host: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket?.send(data, port, host, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	close(): void {
		this.socket?.close();
		this.socket = null;
	}
}

interface PersistedDhtState {
	nodeId: Uint8Array;
	nodes: DhtNode[];
}

function readDhtState(): PersistedDhtState | null {
	try {
		const path = dhtStatePath();
		if (!existsSync(path)) return null;
		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			nodeId?: string;
			nodes?: Array<{ id?: string; ip?: string; port?: number }>;
		};
		if (!raw.nodeId) return null;
		return {
			nodeId: nodeIdFromHex(raw.nodeId),
			nodes: (raw.nodes ?? []).flatMap((node) => {
				if (!node.id || !node.ip || typeof node.port !== "number") return [];
				return [{ id: nodeIdFromHex(node.id), ip: node.ip, port: node.port }];
			}),
		};
	} catch {
		return null;
	}
}

function writeDhtState(nodeId: Uint8Array, nodes: DhtNode[]): void {
	const path = dhtStatePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{
				nodeId: nodeIdHex(nodeId),
				nodes: nodes.map((node) => ({
					id: nodeIdHex(node.id),
					ip: node.ip,
					port: node.port,
				})),
			},
			null,
			2,
		),
	);
}

function dhtStatePath(): string {
	return join(getDataDir(), DHT_STATE_FILE);
}
