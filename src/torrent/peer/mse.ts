import {
	createCipheriv,
	createDecipheriv,
	createDiffieHellman,
	createHash,
	createSecretKey,
	type DiffieHellman,
	randomBytes,
} from "node:crypto";
import type { Socket } from "node:net";

export type EncryptionPolicy = "allowed" | "preferred" | "required";

export const MSE_CRYPTO_PLAINTEXT = 1;
export const MSE_CRYPTO_RC4 = 2;

const MSE_PRIME_HEX =
	"FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
	"020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
	"4FE1356D6D51C245E485B576625E7EC6F44C42E9A63A36210000000000090563";

const MSE_PRIME = Buffer.from(MSE_PRIME_HEX, "hex");
const MSE_GENERATOR = Buffer.from([2]);
const DISCARD_BYTES = 1024;
const PUBLIC_KEY_BYTES = 96;
const MAX_PAD_BYTES = 512;
const VC = Buffer.alloc(8);

export interface MseSecrets {
	decryptKey: Buffer;
	encryptKey: Buffer;
	sharedSecret: Buffer;
}

export interface MseStream {
	update: (data: Uint8Array) => Buffer;
}

export interface MseHandshakeResult {
	decrypt: MseStream | null;
	encrypt: MseStream | null;
	initialData: Buffer;
	method: number;
}

export function createMseDiffieHellman(): DiffieHellman {
	const dh = createDiffieHellman(MSE_PRIME, MSE_GENERATOR);
	dh.generateKeys();
	return dh;
}

export function mseHash(label: string, data: Uint8Array): Buffer {
	return createHash("sha1").update(label).update(data).digest();
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Buffer {
	const length = Math.min(a.length, b.length);
	const out = Buffer.alloc(length);
	for (let i = 0; i < length; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
	return out;
}

export function selectCryptoMethod(
	provided: number,
	policy: EncryptionPolicy,
): number {
	if (policy === "required") {
		return (provided & MSE_CRYPTO_RC4) !== 0 ? MSE_CRYPTO_RC4 : 0;
	}
	if ((provided & MSE_CRYPTO_RC4) !== 0 && policy === "preferred") {
		return MSE_CRYPTO_RC4;
	}
	if ((provided & MSE_CRYPTO_PLAINTEXT) !== 0) return MSE_CRYPTO_PLAINTEXT;
	if ((provided & MSE_CRYPTO_RC4) !== 0) return MSE_CRYPTO_RC4;
	return 0;
}

export function createRc4Pair(
	sharedSecret: Uint8Array,
	infoHash: Uint8Array,
	initiator: boolean,
): MseSecrets {
	const secret = Buffer.from(sharedSecret);
	const outgoingLabel = initiator ? "keyA" : "keyB";
	const incomingLabel = initiator ? "keyB" : "keyA";
	return {
		sharedSecret: secret,
		encryptKey: createStreamKey(outgoingLabel, secret, infoHash),
		decryptKey: createStreamKey(incomingLabel, secret, infoHash),
	};
}

export function createRc4Cipher(key: Uint8Array): {
	update: (data: Uint8Array) => Buffer;
} {
	const cipher = createCipheriv("rc4", createSecretKey(key), null);
	cipher.update(Buffer.alloc(DISCARD_BYTES));
	return {
		update: (data: Uint8Array) => cipher.update(data),
	};
}

export function createRc4Decipher(key: Uint8Array): {
	update: (data: Uint8Array) => Buffer;
} {
	const decipher = createDecipheriv("rc4", createSecretKey(key), null);
	decipher.update(Buffer.alloc(DISCARD_BYTES));
	return {
		update: (data: Uint8Array) => decipher.update(data),
	};
}

export async function initiateMseHandshake(
	socket: Socket,
	infoHash: Uint8Array,
	policy: EncryptionPolicy,
	initialPayload: Uint8Array,
	timeoutMs = 10_000,
): Promise<MseHandshakeResult> {
	const reader = new SocketReader(socket);
	const dh = createMseDiffieHellman();
	socket.write(Buffer.concat([padPublicKey(dh.getPublicKey()), randomPad()]));

	const peerPublic = await reader.read(PUBLIC_KEY_BYTES, timeoutMs);
	await reader.drainQuiet(25, 250);
	const sharedSecret = padPublicKey(dh.computeSecret(peerPublic));
	const secrets = createRc4Pair(sharedSecret, infoHash, true);
	const encrypt = createRc4Cipher(secrets.encryptKey);
	const decrypt = createRc4Decipher(secrets.decryptKey);
	const cryptoProvide =
		policy === "required"
			? MSE_CRYPTO_RC4
			: MSE_CRYPTO_PLAINTEXT | MSE_CRYPTO_RC4;
	socket.write(
		Buffer.concat([
			mseHash("req1", sharedSecret),
			xorBytes(mseHash("req2", infoHash), mseHash("req3", sharedSecret)),
			encrypt.update(
				Buffer.concat([
					VC,
					uint32(cryptoProvide),
					uint16(0),
					uint16(initialPayload.length),
					Buffer.from(initialPayload),
				]),
			),
		]),
	);

	const vc = decrypt.update(await reader.read(8, timeoutMs));
	if (!vc.equals(VC)) throw new Error("MSE verification failed");
	const selected = decrypt
		.update(await reader.read(4, timeoutMs))
		.readUInt32BE(0);
	if (!validateSelectedCrypto(selected, cryptoProvide, policy)) {
		throw new Error("MSE crypto selection rejected");
	}
	const padLength = decrypt
		.update(await reader.read(2, timeoutMs))
		.readUInt16BE(0);
	if (padLength > MAX_PAD_BYTES) throw new Error("Invalid MSE PadD length");
	if (padLength > 0) decrypt.update(await reader.read(padLength, timeoutMs));
	const extra = reader.drain();
	return {
		decrypt: selected === MSE_CRYPTO_RC4 ? decrypt : null,
		encrypt: selected === MSE_CRYPTO_RC4 ? encrypt : null,
		initialData: selected === MSE_CRYPTO_RC4 ? decrypt.update(extra) : extra,
		method: selected,
	};
}

function validateSelectedCrypto(
	selected: number,
	cryptoProvide: number,
	policy: EncryptionPolicy,
): boolean {
	if (selected !== MSE_CRYPTO_PLAINTEXT && selected !== MSE_CRYPTO_RC4) {
		return false;
	}
	if ((selected & cryptoProvide) !== selected) return false;
	if (policy === "required") return selected === MSE_CRYPTO_RC4;
	return true;
}

export async function respondMseHandshake(
	socket: Socket,
	infoHash: Uint8Array,
	policy: EncryptionPolicy,
	initialData: Uint8Array,
	timeoutMs = 10_000,
): Promise<MseHandshakeResult> {
	const reader = new SocketReader(socket, initialData);
	const dh = createMseDiffieHellman();
	const peerPublic = await reader.read(PUBLIC_KEY_BYTES, timeoutMs);
	socket.write(Buffer.concat([padPublicKey(dh.getPublicKey()), randomPad()]));
	const sharedSecret = padPublicKey(dh.computeSecret(peerPublic));
	const req1 = mseHash("req1", sharedSecret);
	await reader.readUntil(req1, MAX_PAD_BYTES + req1.length, timeoutMs);
	const req2Masked = await reader.read(20, timeoutMs);
	const req2 = xorBytes(req2Masked, mseHash("req3", sharedSecret));
	if (!req2.equals(mseHash("req2", infoHash))) {
		throw new Error("MSE info hash mismatch");
	}

	const secrets = createRc4Pair(sharedSecret, infoHash, false);
	const encrypt = createRc4Cipher(secrets.encryptKey);
	const decrypt = createRc4Decipher(secrets.decryptKey);
	const vc = decrypt.update(await reader.read(8, timeoutMs));
	if (!vc.equals(VC)) throw new Error("MSE verification failed");
	const provided = decrypt
		.update(await reader.read(4, timeoutMs))
		.readUInt32BE(0);
	const selected = selectCryptoMethod(provided, policy);
	if (selected === 0) throw new Error("No compatible MSE crypto method");
	const padLength = decrypt
		.update(await reader.read(2, timeoutMs))
		.readUInt16BE(0);
	if (padLength > MAX_PAD_BYTES) throw new Error("Invalid MSE PadC length");
	if (padLength > 0) decrypt.update(await reader.read(padLength, timeoutMs));
	const iaLength = decrypt
		.update(await reader.read(2, timeoutMs))
		.readUInt16BE(0);
	const ia =
		iaLength > 0
			? decrypt.update(await reader.read(iaLength, timeoutMs))
			: Buffer.alloc(0);

	socket.write(
		encrypt.update(Buffer.concat([VC, uint32(selected), uint16(0)])),
	);
	const extra = reader.drain();
	const decryptedExtra =
		selected === MSE_CRYPTO_RC4 ? decrypt.update(extra) : extra;
	return {
		decrypt: selected === MSE_CRYPTO_RC4 ? decrypt : null,
		encrypt: selected === MSE_CRYPTO_RC4 ? encrypt : null,
		initialData: Buffer.concat([ia, decryptedExtra]),
		method: selected,
	};
}

function createStreamKey(
	label: string,
	sharedSecret: Uint8Array,
	infoHash: Uint8Array,
): Buffer {
	return createHash("sha1")
		.update(label)
		.update(sharedSecret)
		.update(infoHash)
		.digest();
}

function padPublicKey(value: Uint8Array): Buffer {
	const buf = Buffer.from(value);
	if (buf.length === PUBLIC_KEY_BYTES) return buf;
	if (buf.length > PUBLIC_KEY_BYTES)
		return buf.subarray(buf.length - PUBLIC_KEY_BYTES);
	return Buffer.concat([Buffer.alloc(PUBLIC_KEY_BYTES - buf.length), buf]);
}

function randomPad(): Buffer {
	return randomBytes(Math.floor(Math.random() * 33));
}

function uint16(value: number): Buffer {
	const buf = Buffer.alloc(2);
	buf.writeUInt16BE(value);
	return buf;
}

function uint32(value: number): Buffer {
	const buf = Buffer.alloc(4);
	buf.writeUInt32BE(value);
	return buf;
}

class SocketReader {
	private buffer: Buffer;
	private waiters: Array<() => void> = [];
	private error: Error | null = null;

	constructor(
		private readonly socket: Socket,
		initialData: Uint8Array = new Uint8Array(),
	) {
		this.buffer = Buffer.from(initialData);
		this.socket.on("data", this.onData);
		this.socket.once("error", this.onError);
		this.socket.once("close", this.onClose);
	}

	async read(length: number, timeoutMs: number): Promise<Buffer> {
		await this.waitFor(() => this.buffer.length >= length, timeoutMs);
		const out = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return out;
	}

	async readUntil(
		pattern: Buffer,
		maxBuffered: number,
		timeoutMs: number,
	): Promise<void> {
		await this.waitFor(() => {
			if (this.buffer.indexOf(pattern) >= 0) return true;
			if (this.buffer.length > maxBuffered)
				throw new Error("MSE sync marker not found");
			return false;
		}, timeoutMs);
		const offset = this.buffer.indexOf(pattern);
		this.buffer = this.buffer.subarray(offset + pattern.length);
	}

	async drainQuiet(quietMs: number, timeoutMs: number): Promise<Buffer> {
		const started = Date.now();
		let lastLength = this.buffer.length;
		while (Date.now() - started < timeoutMs) {
			await delay(quietMs);
			if (this.buffer.length === lastLength) break;
			lastLength = this.buffer.length;
		}
		return this.drainBuffered();
	}

	drain(): Buffer {
		const out = this.drainBuffered();
		this.cleanup();
		return out;
	}

	private drainBuffered(): Buffer {
		const out = this.buffer;
		this.buffer = Buffer.alloc(0);
		return out;
	}

	private async waitFor(
		predicate: () => boolean,
		timeoutMs: number,
	): Promise<void> {
		const started = Date.now();
		while (!predicate()) {
			if (this.error) throw this.error;
			if (Date.now() - started > timeoutMs) throw new Error("MSE timeout");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 10);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	private readonly onData = (chunk: Buffer): void => {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		this.flushWaiters();
	};

	private readonly onError = (err: Error): void => {
		this.error = err;
		this.flushWaiters();
	};

	private readonly onClose = (): void => {
		this.error = new Error("socket closed");
		this.flushWaiters();
	};

	private flushWaiters(): void {
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) waiter();
	}

	private cleanup(): void {
		this.socket.off("data", this.onData);
		this.socket.off("error", this.onError);
		this.socket.off("close", this.onClose);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
