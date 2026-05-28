import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "torrent-tui-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export async function withTempDir<T>(
	fn: (dir: string) => T | Promise<T>,
): Promise<T> {
	const dir = makeTempDir();
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function withIsolatedAppData<T>(
	fn: (dir: string) => T | Promise<T>,
): Promise<T> {
	const dir = makeTempDir("torrent-tui-data-");
	const previousHome = process.env.HOME;
	const previousXdgDataHome = process.env.XDG_DATA_HOME;
	try {
		process.env.HOME = dir;
		process.env.XDG_DATA_HOME = join(dir, "data");
		return await fn(dir);
	} finally {
		restoreEnv("HOME", previousHome);
		restoreEnv("XDG_DATA_HOME", previousXdgDataHome);
		rmSync(dir, { recursive: true, force: true });
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}
