import { describe, expect, test } from "bun:test";
import { deriveRuntimeStatus } from "../../src/torrent/bridge.ts";

describe("deriveRuntimeStatus", () => {
	test("paused always wins", () => {
		expect(deriveRuntimeStatus("downloading", 5, true, true)).toBe("paused");
		expect(deriveRuntimeStatus("downloading", 0, true, false)).toBe("paused");
	});

	test("seeding wins when not paused", () => {
		expect(deriveRuntimeStatus("seeding", 5, false, true)).toBe("seeding");
		expect(deriveRuntimeStatus("seeding", 0, false, false)).toBe("seeding");
	});

	test("stalled when no peers regardless of prior activity", () => {
		expect(deriveRuntimeStatus("downloading", 0, false, false)).toBe("stalled");
		// regression: was flickering "downloading" when a peer briefly reconnected
		expect(deriveRuntimeStatus("downloading", 0, false, true)).toBe("stalled");
	});

	test("connecting when peers present but no activity yet", () => {
		expect(deriveRuntimeStatus("downloading", 1, false, false)).toBe("connecting");
		expect(deriveRuntimeStatus("downloading", 3, false, false)).toBe("connecting");
	});

	test("downloading when peers present and activity seen", () => {
		expect(deriveRuntimeStatus("downloading", 1, false, true)).toBe("downloading");
		expect(deriveRuntimeStatus("downloading", 4, false, true)).toBe("downloading");
	});
});
