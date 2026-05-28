import { SHA1 } from "bun";

const TEXT_ENCODER = new TextEncoder();

export function bytes(value: string): Uint8Array {
	return TEXT_ENCODER.encode(value);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function sha1(data: Uint8Array): Uint8Array {
	return new SHA1().update(data).digest() as unknown as Uint8Array;
}

export function hex(data: Uint8Array): string {
	return Buffer.from(data).toString("hex");
}

export function splitPieces(
	content: Uint8Array,
	pieceLength: number,
): Uint8Array[] {
	const pieces: Uint8Array[] = [];
	for (let offset = 0; offset < content.length; offset += pieceLength) {
		pieces.push(content.slice(offset, offset + pieceLength));
	}
	return pieces;
}

export function pieceHashBytes(
	content: Uint8Array,
	pieceLength: number,
): Uint8Array {
	return concatBytes(
		splitPieces(content, pieceLength).map((piece) => sha1(piece)),
	);
}
