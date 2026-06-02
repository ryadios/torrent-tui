export const MSG = {
	KEEPALIVE: -1,
	CHOKE: 0,
	UNCHOKE: 1,
	INTERESTED: 2,
	NOT_INTERESTED: 3,
	HAVE: 4,
	BITFIELD: 5,
	REQUEST: 6,
	PIECE: 7,
	CANCEL: 8,
	EXTENDED: 20,
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface PeerMessage {
	type: MessageType;
	payload?: Uint8Array;
}

export function encode(msg: PeerMessage): Uint8Array {
	if (msg.type === MSG.KEEPALIVE) {
		return new Uint8Array(4); // 4 zero bytes
	}
	const payload = msg.payload ?? new Uint8Array(0);
	const buf = new Uint8Array(4 + 1 + payload.length);
	const len = 1 + payload.length;
	buf[0] = (len >>> 24) & 0xff;
	buf[1] = (len >>> 16) & 0xff;
	buf[2] = (len >>> 8) & 0xff;
	buf[3] = len & 0xff;
	buf[4] = msg.type as number;
	buf.set(payload, 5);
	return buf;
}

export function decode(raw: Uint8Array): PeerMessage {
	const length =
		((raw[0] ?? 0) << 24) |
		((raw[1] ?? 0) << 16) |
		((raw[2] ?? 0) << 8) |
		(raw[3] ?? 0);

	if (length === 0) return { type: MSG.KEEPALIVE };

	const id = raw[4] as MessageType;
	const payload = raw.length > 5 ? raw.slice(5) : undefined;
	return { type: id, payload };
}

// Helpers to build specific message payloads

export function encodeHave(pieceIndex: number): Uint8Array {
	const payload = new Uint8Array(4);
	payload[0] = (pieceIndex >>> 24) & 0xff;
	payload[1] = (pieceIndex >>> 16) & 0xff;
	payload[2] = (pieceIndex >>> 8) & 0xff;
	payload[3] = pieceIndex & 0xff;
	return encode({ type: MSG.HAVE, payload });
}

export function encodeRequest(
	index: number,
	begin: number,
	length: number,
): Uint8Array {
	const payload = new Uint8Array(12);
	const view = new DataView(payload.buffer);
	view.setUint32(0, index);
	view.setUint32(4, begin);
	view.setUint32(8, length);
	return encode({ type: MSG.REQUEST, payload });
}

export function encodeCancel(
	index: number,
	begin: number,
	length: number,
): Uint8Array {
	const payload = new Uint8Array(12);
	const view = new DataView(payload.buffer);
	view.setUint32(0, index);
	view.setUint32(4, begin);
	view.setUint32(8, length);
	return encode({ type: MSG.CANCEL, payload });
}

export function decodeHave(payload: Uint8Array): number {
	return new DataView(payload.buffer, payload.byteOffset).getUint32(0);
}

export function decodeRequest(payload: Uint8Array): {
	index: number;
	begin: number;
	length: number;
} {
	const view = new DataView(payload.buffer, payload.byteOffset);
	return {
		index: view.getUint32(0),
		begin: view.getUint32(4),
		length: view.getUint32(8),
	};
}

export function decodePiece(payload: Uint8Array): {
	index: number;
	begin: number;
	block: Uint8Array;
} {
	const view = new DataView(payload.buffer, payload.byteOffset);
	return {
		index: view.getUint32(0),
		begin: view.getUint32(4),
		block: payload.slice(8),
	};
}

export function msgName(type: MessageType): string {
	for (const [k, v] of Object.entries(MSG)) {
		if (v === type) return k;
	}
	return `UNKNOWN(${type})`;
}
