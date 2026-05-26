import { randomBytes } from "node:crypto";

const PEER_ID_PREFIX = "-TT0001-";

let _peerId: Uint8Array | null = null;

export function getPeerId(): Uint8Array {
	if (!_peerId) {
		const prefix = Buffer.from(PEER_ID_PREFIX);
		const random = randomBytes(20 - prefix.length);
		_peerId = new Uint8Array(Buffer.concat([prefix, random]));
	}
	return _peerId;
}

export function peerIdToString(id: Uint8Array): string {
	// Show ASCII prefix + hex for the random portion
	const prefix = Buffer.from(id.slice(0, 8)).toString("ascii");
	const hex = Buffer.from(id.slice(8)).toString("hex").slice(0, 12);
	return `${prefix}${hex}...`;
}
