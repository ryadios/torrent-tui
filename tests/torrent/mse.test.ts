import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	createMseDiffieHellman,
	createRc4Cipher,
	createRc4Decipher,
	createRc4Pair,
	initiateMseHandshake,
	MSE_CRYPTO_PLAINTEXT,
	MSE_CRYPTO_RC4,
	mseHash,
	respondMseHandshake,
	selectCryptoMethod,
	xorBytes,
} from "../../src/torrent/peer/mse.ts";
import { bytes } from "../helpers/bytes.ts";
import { singleFileTorrentFixture } from "../helpers/torrent-fixtures.ts";

describe("MSE/PE helpers", () => {
	test("derives matching Diffie-Hellman shared secrets", () => {
		const a = createMseDiffieHellman();
		const b = createMseDiffieHellman();

		expect(
			a
				.computeSecret(b.getPublicKey())
				.equals(b.computeSecret(a.getPublicKey())),
		).toBe(true);
	});

	test("selects crypto methods from policy and peer-provided bits", () => {
		expect(selectCryptoMethod(MSE_CRYPTO_RC4, "required")).toBe(MSE_CRYPTO_RC4);
		expect(selectCryptoMethod(MSE_CRYPTO_PLAINTEXT, "required")).toBe(0);
		expect(
			selectCryptoMethod(MSE_CRYPTO_PLAINTEXT | MSE_CRYPTO_RC4, "preferred"),
		).toBe(MSE_CRYPTO_RC4);
		expect(selectCryptoMethod(MSE_CRYPTO_PLAINTEXT, "allowed")).toBe(
			MSE_CRYPTO_PLAINTEXT,
		);
	});

	test("builds MSE hashes and symmetric RC4 streams", () => {
		const fixture = singleFileTorrentFixture();
		const shared = bytes("shared-secret");
		const initiator = createRc4Pair(shared, fixture.metadata.infoHash, true);
		const responder = createRc4Pair(shared, fixture.metadata.infoHash, false);
		const encrypted = createRc4Cipher(initiator.encryptKey).update(
			bytes("hello"),
		);
		const decrypted = createRc4Decipher(responder.decryptKey).update(encrypted);

		expect(mseHash("req1", shared)).toHaveLength(20);
		expect(xorBytes(bytes("abc"), bytes("ABC"))).toEqual(
			Buffer.from([0x20, 0x20, 0x20]),
		);
		expect(Buffer.from(decrypted).toString()).toBe("hello");
	});

	test("negotiates RC4 streams over a duplex socket pair", async () => {
		const fixture = singleFileTorrentFixture();
		const { a, b } = socketPair();
		const [client, server] = await Promise.all([
			initiateMseHandshake(
				a as never,
				fixture.metadata.infoHash,
				"required",
				bytes("client-hello"),
			),
			respondMseHandshake(
				b as never,
				fixture.metadata.infoHash,
				"required",
				new Uint8Array(),
			),
		]);

		expect(client.method).toBe(MSE_CRYPTO_RC4);
		expect(server.method).toBe(MSE_CRYPTO_RC4);
		expect(Buffer.from(server.initialData).toString()).toBe("client-hello");
		if (!client.encrypt || !server.decrypt) throw new Error("missing streams");
		const encrypted = client.encrypt.update(bytes("payload"));
		expect(Buffer.from(server.decrypt.update(encrypted)).toString()).toBe(
			"payload",
		);
	});
});

function socketPair(): { a: FakeSocket; b: FakeSocket } {
	const a = new FakeSocket();
	const b = new FakeSocket();
	a.peer = b;
	b.peer = a;
	return { a, b };
}

class FakeSocket extends EventEmitter {
	peer: FakeSocket | null = null;

	write(chunk: Uint8Array): boolean {
		const peer = this.peer;
		if (!peer) return false;
		queueMicrotask(() => peer.emit("data", Buffer.from(chunk)));
		return true;
	}
}
