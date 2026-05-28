import { describe, expect, test } from "bun:test";
import {
	buildHandshake,
	parseHandshake,
} from "../../src/torrent/peer/handshake.ts";
import { MessageBuffer } from "../../src/torrent/peer/message-buffer.ts";
import {
	decode,
	decodeHave,
	decodePiece,
	decodeRequest,
	encode,
	encodeCancel,
	encodeHave,
	encodeRequest,
	MSG,
	msgName,
} from "../../src/torrent/peer/protocol.ts";
import { PiecePicker } from "../../src/torrent/piece-picker.ts";
import { bytes, concatBytes } from "../helpers/bytes.ts";
import { FakePeer } from "../helpers/fakes.ts";

describe("peer handshake", () => {
	test("builds and parses a valid handshake", () => {
		const infoHash = new Uint8Array(20).fill(1);
		const peerId = bytes("-TT0001-123456789012");
		const raw = buildHandshake(infoHash, peerId);

		expect(raw.length).toBe(68);
		expect(parseHandshake(raw, infoHash)).toEqual({
			peerId: "-TT0001-123456789012",
			reserved: new Uint8Array(8),
		});
	});

	test("rejects invalid handshakes", () => {
		const infoHash = new Uint8Array(20).fill(1);
		const peerId = bytes("-TT0001-123456789012");
		const raw = buildHandshake(infoHash, peerId);
		const badProtocol = raw.slice();
		badProtocol[0] = 18;
		const badHash = raw.slice();
		badHash[28] = 2;

		expect(() => parseHandshake(raw.slice(0, 12), infoHash)).toThrow(
			"Handshake too short",
		);
		expect(() => parseHandshake(badProtocol, infoHash)).toThrow(
			"Invalid pstrlen",
		);
		expect(() => parseHandshake(badHash, infoHash)).toThrow(
			"info_hash mismatch",
		);
	});
});

describe("peer protocol messages", () => {
	test("encodes and decodes keepalive and simple messages", () => {
		expect(decode(encode({ type: MSG.KEEPALIVE }))).toEqual({
			type: MSG.KEEPALIVE,
		});
		expect(decode(encode({ type: MSG.CHOKE }))).toEqual({
			type: MSG.CHOKE,
			payload: undefined,
		});
		expect(decode(encode({ type: MSG.UNCHOKE }))).toEqual({
			type: MSG.UNCHOKE,
			payload: undefined,
		});
		expect(msgName(MSG.INTERESTED)).toBe("INTERESTED");
	});

	test("encodes and decodes have, request, cancel, and piece payloads", () => {
		const have = decode(encodeHave(513));
		expect(have.type).toBe(MSG.HAVE);
		expect(decodeHave(have.payload ?? new Uint8Array())).toBe(513);

		const request = decode(encodeRequest(2, 16_384, 8_192));
		expect(request.type).toBe(MSG.REQUEST);
		expect(decodeRequest(request.payload ?? new Uint8Array())).toEqual({
			index: 2,
			begin: 16_384,
			length: 8_192,
		});

		const cancel = decode(encodeCancel(3, 32_768, 4_096));
		expect(cancel.type).toBe(MSG.CANCEL);
		expect(decodeRequest(cancel.payload ?? new Uint8Array())).toEqual({
			index: 3,
			begin: 32_768,
			length: 4_096,
		});

		const block = bytes("payload");
		const payload = new Uint8Array(8 + block.length);
		const view = new DataView(payload.buffer);
		view.setUint32(0, 4);
		view.setUint32(4, 128);
		payload.set(block, 8);
		const piece = decode(encode({ type: MSG.PIECE, payload }));
		expect(decodePiece(piece.payload ?? new Uint8Array())).toEqual({
			index: 4,
			begin: 128,
			block,
		});
	});
});

describe("MessageBuffer", () => {
	test("returns complete frames and retains partial trailing data", () => {
		const buffer = new MessageBuffer();
		const have = encodeHave(7);
		const unchoke = encode({ type: MSG.UNCHOKE });
		const combined = concatBytes([have, unchoke]);

		expect(buffer.push(combined.slice(0, 3))).toEqual([]);
		expect(buffer.push(combined.slice(3, have.length + 2))).toEqual([have]);
		expect(buffer.push(combined.slice(have.length + 2))).toEqual([unchoke]);
	});

	test("handles keepalive and coalesced frames", () => {
		const buffer = new MessageBuffer();
		const keepalive = encode({ type: MSG.KEEPALIVE });
		const interested = encode({ type: MSG.INTERESTED });

		expect(buffer.push(concatBytes([keepalive, interested]))).toEqual([
			keepalive,
			interested,
		]);
	});
});

describe("PiecePicker", () => {
	test("picks the rarest available piece and skips owned or in-progress pieces", () => {
		const owned = new Set([0]);
		const inProgress = new Set([2]);
		const picker = new PiecePicker(
			5,
			(index) => owned.has(index),
			(index) => inProgress.has(index),
		);
		const peerA = new FakePeer("127.0.0.1", 6001, new Set([1, 2, 3]));
		const peerB = new FakePeer("127.0.0.2", 6002, new Set([1, 3, 4]));

		picker.addPeer(peerA.asConnection());
		picker.addPeer(peerB.asConnection());

		expect(picker.availabilityOf(1)).toBe(2);
		expect(picker.availabilityOf(4)).toBe(1);
		expect(picker.pick(peerB.asConnection())).toBe(4);

		picker.removePeer(peerB.asConnection());
		expect(picker.availabilityOf(1)).toBe(1);
		expect(picker.availabilityOf(4)).toBe(0);
	});

	test("tracks have announcements", () => {
		const picker = new PiecePicker(
			3,
			() => false,
			() => false,
		);
		const peer = new FakePeer("127.0.0.1", 6001, new Set([2]));

		picker.onHave(2);

		expect(picker.availabilityOf(2)).toBe(1);
		expect(picker.pick(peer.asConnection())).toBe(2);
	});
});
