import { describe, expect, test } from "bun:test";
import {
	createUploadedAccumulator,
	recordRemovedPeerUpload,
	uploadedSnapshot,
} from "../../src/torrent/upload-accounting.ts";

describe("uploaded tracker accounting", () => {
	test("includes live uploaded totals", () => {
		const accumulator = createUploadedAccumulator();

		expect(
			uploadedSnapshot(accumulator, [{ uploadedTotal: 10 }, { uploadedTotal: 5 }]),
		).toBe(15);
	});

	test("preserves removed peer uploads and does not double count removals", () => {
		const accumulator = createUploadedAccumulator();
		const removedPeer = { uploadedTotal: 12 };
		const livePeer = { uploadedTotal: 7 };

		recordRemovedPeerUpload(accumulator, removedPeer);
		recordRemovedPeerUpload(accumulator, removedPeer);

		expect(uploadedSnapshot(accumulator, [livePeer])).toBe(19);
	});

	test("does not decrease when an uploaded peer disconnects", () => {
		const accumulator = createUploadedAccumulator();
		const peer = { uploadedTotal: 12 };

		const beforeDisconnect = uploadedSnapshot(accumulator, [peer]);
		recordRemovedPeerUpload(accumulator, peer);
		const afterDisconnect = uploadedSnapshot(accumulator, []);

		expect(afterDisconnect).toBe(beforeDisconnect);
	});
});
