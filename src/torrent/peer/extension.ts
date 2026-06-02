import type { BencodeValue } from "../parser.ts";
import { decode, encode } from "../parser.ts";

export const EXTENDED_MESSAGE_ID = 20;
export const EXT_HANDSHAKE_ID = 0;
export const LOCAL_UT_METADATA_ID = 1;
export const LOCAL_UT_PEX_ID = 2;
export const EXTENSION_PROTOCOL_RESERVED_BYTE = 5;
export const EXTENSION_PROTOCOL_RESERVED_MASK = 0x10;
export const METADATA_BLOCK_SIZE = 16 * 1024;

const TEXT_DECODER = new TextDecoder();

export interface ExtensionHandshake {
	extensions: Map<string, number>;
	metadataSize?: number;
}

export type UtMetadataMessage =
	| { msgType: 0; piece: number }
	| { msgType: 1; piece: number; totalSize: number; data: Uint8Array }
	| { msgType: 2; piece: number };

export interface UtPexMessage {
	added: Array<{ ip: string; port: number }>;
	dropped: Array<{ ip: string; port: number }>;
}

export function supportsExtensionProtocol(reserved: Uint8Array): boolean {
	return (
		((reserved[EXTENSION_PROTOCOL_RESERVED_BYTE] ?? 0) &
			EXTENSION_PROTOCOL_RESERVED_MASK) !==
		0
	);
}

export function buildExtensionReservedBytes(): Uint8Array {
	const reserved = new Uint8Array(8);
	reserved[EXTENSION_PROTOCOL_RESERVED_BYTE] = EXTENSION_PROTOCOL_RESERVED_MASK;
	return reserved;
}

export function encodeExtendedMessage(
	extensionId: number,
	payload: Uint8Array,
): Uint8Array {
	return Uint8Array.from([extensionId, ...payload]);
}

export function decodeExtendedMessage(payload: Uint8Array): {
	extensionId: number;
	payload: Uint8Array;
} {
	if (payload.length < 1) throw new Error("Extended message missing ID");
	return { extensionId: payload[0] ?? 0, payload: payload.slice(1) };
}

export function encodeExtensionHandshake(
	options: {
		metadataSize?: number;
		utMetadataId?: number;
		utPexId?: number;
		pex?: boolean;
	} = {},
): Uint8Array {
	const body: { [key: string]: BencodeValue } = {
		m: {
			ut_metadata: options.utMetadataId ?? LOCAL_UT_METADATA_ID,
		},
	};
	if (options.pex ?? true) {
		(body.m as { [key: string]: BencodeValue }).ut_pex =
			options.utPexId ?? LOCAL_UT_PEX_ID;
	}
	if (options.metadataSize !== undefined)
		body.metadata_size = options.metadataSize;
	return encodeExtendedMessage(EXT_HANDSHAKE_ID, encode(body));
}

export function decodeExtensionHandshake(
	payload: Uint8Array,
): ExtensionHandshake {
	const decoded = decode(payload);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Invalid extension handshake");
	}
	const extensions = new Map<string, number>();
	const rawExtensions = decoded.m;
	if (
		typeof rawExtensions === "object" &&
		rawExtensions !== null &&
		!Array.isArray(rawExtensions) &&
		!(rawExtensions instanceof Uint8Array)
	) {
		for (const [name, id] of Object.entries(rawExtensions)) {
			if (typeof id === "number" && id > 0) extensions.set(name, id);
		}
	}
	return {
		extensions,
		metadataSize:
			typeof decoded.metadata_size === "number"
				? decoded.metadata_size
				: undefined,
	};
}

export function encodeUtMetadataRequest(piece: number): Uint8Array {
	return encode({ msg_type: 0, piece });
}

export function encodeUtMetadataData(
	piece: number,
	totalSize: number,
	data: Uint8Array,
): Uint8Array {
	return concat([encode({ msg_type: 1, piece, total_size: totalSize }), data]);
}

export function encodeUtMetadataReject(piece: number): Uint8Array {
	return encode({ msg_type: 2, piece });
}

export function decodeUtMetadataMessage(
	payload: Uint8Array,
): UtMetadataMessage {
	const headerEnd = findBencodeEnd(payload, 0);
	const headerRaw = payload.slice(0, headerEnd);
	const decoded = decode(headerRaw);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Invalid ut_metadata header");
	}
	const msgType = decoded.msg_type;
	const piece = decoded.piece;
	if (typeof msgType !== "number" || typeof piece !== "number") {
		throw new Error("Invalid ut_metadata message");
	}
	if (msgType === 0) return { msgType: 0, piece };
	if (msgType === 2) return { msgType: 2, piece };
	if (msgType === 1) {
		const totalSize = decoded.total_size;
		if (typeof totalSize !== "number") {
			throw new Error("ut_metadata data message missing total_size");
		}
		return {
			msgType: 1,
			piece,
			totalSize,
			data: payload.slice(headerEnd),
		};
	}
	throw new Error(`Unsupported ut_metadata msg_type: ${msgType}`);
}

export function encodeUtPexMessage(message: UtPexMessage): Uint8Array {
	return encode({
		added: encodeCompactPeers(message.added),
		dropped: encodeCompactPeers(message.dropped),
	});
}

export function decodeUtPexMessage(payload: Uint8Array): UtPexMessage {
	const decoded = decode(payload);
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		throw new Error("Invalid ut_pex message");
	}
	return {
		added:
			decoded.added instanceof Uint8Array
				? decodeCompactPeers(decoded.added)
				: [],
		dropped:
			decoded.dropped instanceof Uint8Array
				? decodeCompactPeers(decoded.dropped)
				: [],
	};
}

function encodeCompactPeers(
	peers: Array<{ ip: string; port: number }>,
): Uint8Array {
	const bytes = new Uint8Array(peers.length * 6);
	let offset = 0;
	for (const peer of peers) {
		const octets = peer.ip.split(".").map((part) => Number(part));
		if (
			octets.length !== 4 ||
			octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
		) {
			throw new Error(`Cannot encode non-IPv4 PEX peer: ${peer.ip}`);
		}
		bytes.set(octets, offset);
		bytes[offset + 4] = (peer.port >>> 8) & 0xff;
		bytes[offset + 5] = peer.port & 0xff;
		offset += 6;
	}
	return bytes;
}

function decodeCompactPeers(
	data: Uint8Array,
): Array<{ ip: string; port: number }> {
	const peers: Array<{ ip: string; port: number }> = [];
	for (let offset = 0; offset + 6 <= data.length; offset += 6) {
		const ip = `${data[offset] ?? 0}.${data[offset + 1] ?? 0}.${data[offset + 2] ?? 0}.${data[offset + 3] ?? 0}`;
		const port = ((data[offset + 4] ?? 0) << 8) | (data[offset + 5] ?? 0);
		if (port > 0) peers.push({ ip, port });
	}
	return peers;
}

function findBencodeEnd(data: Uint8Array, index: number): number {
	const byte = data[index];
	if (byte === undefined) throw new Error(`Unexpected end at ${index}`);
	if (byte === 105) {
		let i = index + 1;
		while (i < data.length && data[i] !== 101) i++;
		if (i >= data.length) throw new Error("Unterminated integer");
		return i + 1;
	}
	if (byte === 108) {
		let i = index + 1;
		while (i < data.length && data[i] !== 101) i = findBencodeEnd(data, i);
		if (i >= data.length) throw new Error("Unterminated list");
		return i + 1;
	}
	if (byte === 100) {
		let i = index + 1;
		while (i < data.length && data[i] !== 101) {
			i = findBencodeEnd(data, i);
			i = findBencodeEnd(data, i);
		}
		if (i >= data.length) throw new Error("Unterminated dictionary");
		return i + 1;
	}
	if (byte >= 48 && byte <= 57) {
		let i = index;
		while (i < data.length && data[i] !== 58) i++;
		if (i >= data.length) throw new Error("Invalid string");
		const len = Number.parseInt(TEXT_DECODER.decode(data.slice(index, i)), 10);
		return i + 1 + len;
	}
	throw new Error(`Invalid bencode type at index ${index}: ${byte}`);
}

function concat(arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, array) => sum + array.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.length;
	}
	return result;
}
