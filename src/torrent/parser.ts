export type BencodeValue =
	| string
	| number
	| BencodeValue[]
	| { [key: string]: BencodeValue };

const TEXT_DECODER = new TextDecoder(); // bytes -> string
const TEXT_ENCODER = new TextEncoder(); // string -> bytes

/**
 * i<num>e -> number
 */
export function parseIntB(data: Uint8Array, i: number): [number, number] {
	if (data[i] !== 105) throw new Error("Invalid integer"); // check for "i"
	i++;
	const start = i;
	while (i < data.length && data[i] !== 101) i++; // loop until "e"
	if (i >= data.length) throw new Error("Unterminated integer");
	const value = Number.parseInt(TEXT_DECODER.decode(data.slice(start, i)), 10);
	return [value, i + 1];
}

/**
 * <len>:<str> -> string
 */
export function parseStringB(data: Uint8Array, i: number): [string, number] {
	let j = i;
	while (j < data.length && data[j] !== 58) j++; // check for ":" separator
	if (j >= data.length) throw new Error("Invalid string: missing separator");
	const len = Number.parseInt(TEXT_DECODER.decode(data.slice(i, j)), 10);
	if (len < 0) throw new Error("Invalid string: negative length");
	j++;
	if (j + len > data.length)
		throw new Error("Invalid string: length exceeds data");
	const str = TEXT_DECODER.decode(data.slice(j, j + len));
	return [str, j + len];
}

/**
 * l<items>e -> BencodeValue[]
 */
export function parseListB(
	data: Uint8Array,
	i: number,
): [BencodeValue[], number] {
	if (data[i] !== 108) throw new Error("Invalid list"); // check for "l"
	i++;
	const arr: BencodeValue[] = [];
	while (i < data.length && data[i] !== 101) {
		const [val, newI] = parseAny(data, i);
		arr.push(val);
		i = newI;
	}
	if (i >= data.length) throw new Error("Unterminated list");
	return [arr, i + 1];
}

/**
 * d<key-value>e -> { [key: string]: BencodeValue }
 */
export function parseDictB(
	data: Uint8Array,
	i: number,
): [{ [key: string]: BencodeValue }, number] {
	if (data[i] !== 100) throw new Error("Invalid dictionary"); // check for "d"
	i++;
	const dict: { [key: string]: BencodeValue } = {};
	while (i < data.length && data[i] !== 101) {
		const [key, newI] = parseStringB(data, i);
		const keyStr = key;
		const [val, nextI] = parseAny(data, newI);
		dict[keyStr] = val;
		i = nextI;
	}
	if (i >= data.length) throw new Error("Unterminated dictionary");
	return [dict, i + 1];
}

/**
 * Parse any bencode value
 */
export function parseAny(data: Uint8Array, i: number): [BencodeValue, number] {
	const byte = data[i];
	if (byte === undefined) throw new Error(`Invalid bencode type at index ${i}`);
	if (byte === 105) return parseIntB(data, i);
	if (byte === 108) return parseListB(data, i);
	if (byte === 100) return parseDictB(data, i);
	if (byte >= 48 && byte <= 57) return parseStringB(data, i);
	throw new Error(`Invalid bencode type at index ${i}: ${byte}`);
}

/**
 * Decodes bencode data to BencodeValue
 */
export function decode(data: Uint8Array): BencodeValue {
	const [result, index] = parseAny(data, 0);
	if (index < data.length) throw new Error(`Extra data at index ${index}`);
	return result;
}

/**
 * Encodes BencodeValue to bencode bytes
 */
export function encode(value: BencodeValue): Uint8Array {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(
				"Cannot encode non-finite numbers (NaN, Infinity, -Infinity)",
			);
		}
		return TEXT_ENCODER.encode(`i${value}e`);
	}
	if (typeof value === "string") {
		const bytes = TEXT_ENCODER.encode(value);
		const len = TEXT_ENCODER.encode(String(bytes.length));
		return Uint8Array.from([...len, 58, ...bytes]);
	}
	if (Array.isArray(value)) {
		const parts: Uint8Array[] = [TEXT_ENCODER.encode("l")];
		for (const item of value) parts.push(encode(item));
		parts.push(TEXT_ENCODER.encode("e"));
		return concat(parts);
	}
	if (typeof value === "object" && value !== null) {
		const parts: Uint8Array[] = [TEXT_ENCODER.encode("d")];
		const keys = Object.keys(value).sort();
		for (const key of keys) {
			const val = value[key];
			if (val === undefined) continue;
			parts.push(encode(key));
			parts.push(encode(val));
		}
		parts.push(TEXT_ENCODER.encode("e"));
		return concat(parts);
	}
	throw new Error(`Unsupported type: ${typeof value}`);
}

function concat(arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, a) => sum + a.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
