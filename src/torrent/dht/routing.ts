import type { PeerInfo } from "../types.ts";
import {
	DHT_K,
	DHT_NODE_ID_LENGTH,
	type DhtNode,
	nodeIdHex,
} from "./protocol.ts";

export class DhtRoutingTable {
	private readonly nodes = new Map<string, DhtNode>();

	constructor(private readonly ownId: Uint8Array) {
		if (ownId.length !== DHT_NODE_ID_LENGTH) {
			throw new Error("DHT node id must be 20 bytes");
		}
	}

	add(node: DhtNode): void {
		if (node.id.length !== DHT_NODE_ID_LENGTH) return;
		if (sameBytes(node.id, this.ownId)) return;
		if (!isUsablePeer(node)) return;
		const key = peerKey(node);
		if (this.nodes.has(key)) {
			this.nodes.set(key, node);
			return;
		}
		if (this.nodes.size < DHT_K * 32) {
			this.nodes.set(key, node);
			return;
		}
		const farthest = this.closest(this.ownId).at(-1);
		if (!farthest) return;
		if (compareDistance(node.id, farthest.id, this.ownId) < 0) {
			this.nodes.delete(peerKey(farthest));
			this.nodes.set(key, node);
		}
	}

	addMany(nodes: DhtNode[]): void {
		for (const node of nodes) this.add(node);
	}

	closest(target: Uint8Array, count = DHT_K): DhtNode[] {
		return [...this.nodes.values()]
			.sort((a, b) => compareDistance(a.id, b.id, target))
			.slice(0, count);
	}

	peers(): PeerInfo[] {
		return [...this.nodes.values()].map(({ ip, port }) => ({ ip, port }));
	}

	snapshot(): DhtNode[] {
		return [...this.nodes.values()];
	}

	get size(): number {
		return this.nodes.size;
	}
}

export function compareDistance(
	left: Uint8Array,
	right: Uint8Array,
	target: Uint8Array,
): number {
	for (let i = 0; i < DHT_NODE_ID_LENGTH; i++) {
		const leftDistance = (left[i] ?? 0) ^ (target[i] ?? 0);
		const rightDistance = (right[i] ?? 0) ^ (target[i] ?? 0);
		if (leftDistance !== rightDistance) return leftDistance - rightDistance;
	}
	return 0;
}

export function peerKey(peer: PeerInfo): string {
	return `${peer.ip}:${peer.port}`;
}

export function nodeKey(node: DhtNode): string {
	return `${nodeIdHex(node.id)}@${peerKey(node)}`;
}

export function isUsablePeer(peer: PeerInfo): boolean {
	return (
		peer.port > 0 &&
		peer.port <= 65535 &&
		peer.ip.length > 0 &&
		peer.ip !== "0.0.0.0"
	);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}
