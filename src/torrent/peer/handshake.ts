const PROTOCOL = "BitTorrent protocol";
const PROTOCOL_BYTES = new TextEncoder().encode(PROTOCOL);
const HANDSHAKE_LEN = 68;

export function buildHandshake(
	infoHash: Uint8Array,
	peerId: Uint8Array,
	reservedBytes?: Uint8Array,
): Uint8Array {
	const buf = new Uint8Array(HANDSHAKE_LEN);
	buf[0] = 19; // pstrlen
	buf.set(PROTOCOL_BYTES, 1); // pstr (19 bytes)
	// bytes 20–27: reserved (zeros, already set)
	if (reservedBytes) buf.set(reservedBytes.slice(0, 8), 20);
	buf.set(infoHash, 28); // info_hash
	buf.set(peerId, 48); // peer_id
	return buf;
}

export function parseHandshake(
	data: Uint8Array,
	expectedInfoHash: Uint8Array,
): { peerId: string; reserved: Uint8Array } {
	if (data.length < HANDSHAKE_LEN) {
		throw new Error(`Handshake too short: ${data.length} bytes`);
	}
	if (data[0] !== 19) {
		throw new Error(`Invalid pstrlen: ${data[0]}`);
	}
	const pstr = new TextDecoder().decode(data.slice(1, 20));
	if (pstr !== PROTOCOL) {
		throw new Error(`Unknown protocol: ${pstr}`);
	}
	const reserved = data.slice(20, 28);
	const infoHash = data.slice(28, 48);
	const peerId = data.slice(48, 68);

	for (let i = 0; i < 20; i++) {
		if (infoHash[i] !== expectedInfoHash[i]) {
			throw new Error("info_hash mismatch");
		}
	}

	return {
		peerId: Buffer.from(peerId).toString("latin1"),
		reserved,
	};
}

export { HANDSHAKE_LEN };
