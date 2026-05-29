import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { abbreviateHomePath } from "../../src/layout/detail-panel.ts";

describe("detail panel path formatting", () => {
	test("abbreviates current home paths with either separator style", () => {
		expect(abbreviateHomePath(`${homedir()}/Downloads/file.iso`)).toBe(
			"~/Downloads/file.iso",
		);

		const windowsStylePath = `${homedir().replace(/\//g, "\\")}\\Downloads\\file.iso`;
		expect(abbreviateHomePath(windowsStylePath)).toBe("~/Downloads/file.iso");
	});
});
