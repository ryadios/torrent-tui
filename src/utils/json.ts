import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, value: unknown): void {
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
		renameSync(tmpPath, path);
	} catch {
		try {
			if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
		} catch {
			// Silently ignore cleanup failures.
		}
	}
}
