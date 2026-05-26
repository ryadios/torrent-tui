import { existsSync, readFileSync } from "node:fs";
import { getPeers } from "./torrent/get_peers";

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function validateTorrentArg(arg: string): string {
	if (!arg.toLowerCase().endsWith(".torrent")) {
		fail(`Error: '${arg}' is not a .torrent file`);
	}
	if (!existsSync(arg)) {
		fail(`Error: File not found: '${arg}'`);
	}
	return arg;
}

async function runVerify(torrentPath: string): Promise<void> {
	const { decode } = await import("./torrent/parser");
	const { TorrentMetadata } = await import("./torrent/metadata");
	const { TorrentSession } = await import("./torrent/session");
	const { announce } = await import("./torrent/tracker/http-tracker");
	const { loadConfig } = await import("./config/index");

	const config = loadConfig();
	const downloadPath = config.downloadPath.replace(
		"~",
		process.env["HOME"] ?? ".",
	);

	const raw = new Uint8Array(readFileSync(torrentPath));
	const decoded = decode(raw);

	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Array.isArray(decoded) ||
		decoded instanceof Uint8Array
	) {
		fail("Invalid torrent file");
	}

	const metadata = new TorrentMetadata(decoded as { [key: string]: import("./torrent/parser").BencodeValue });
	metadata.logSummary();

	const session = new TorrentSession(metadata, downloadPath);
	await session.start();

	const trackerResult = await announce(metadata).catch((e) => {
		console.log(`Tracker error: ${e instanceof Error ? e.message : e}`);
		return null;
	});

	const peers = trackerResult?.peers ?? [];

	const { join } = await import("node:path");

	// verifyAll already ran inside session.start() — read the result from storage state
	let valid = 0;
	let missing = 0;
	let corrupt = 0;
	for (let i = 0; i < metadata.pieceCount; i++) {
		if (session.storage.hasPiece(i)) valid++;
		else missing++;
	}

	const sep = "-".repeat(40);
	console.log(`\n${sep}`);
	console.log("  Phase 1 Summary");
	console.log(sep);
	console.log(`  torrent      ${metadata.name}`);
	console.log(`  size         ${metadata.formatSize()}`);
	console.log(`  pieces       ${metadata.pieceCount} x ${metadata.formatPieceLength()}`);
	console.log(`  files        ${metadata.files.length}`);
	const httpCount = metadata.announceList.flat().filter((u) => u.startsWith("http")).length;
	const udpCount = metadata.announceList.flat().filter((u) => u.startsWith("udp")).length;
	const trackerStr = [httpCount > 0 ? `${httpCount} HTTP` : "", udpCount > 0 ? `${udpCount} UDP` : ""].filter(Boolean).join(", ");
	console.log(`  trackers     ${trackerStr || "none"}`);
	console.log(`  peers        ${peers.length}`);
	console.log("");
	console.log("  pieces       valid    " + valid);
	console.log("               missing  " + missing);
	console.log("               corrupt  " + corrupt);
	console.log("");
	console.log("  files on disk");
	for (const file of metadata.files) {
		const fullPath = join(downloadPath, file.path);
		const exists = existsSync(fullPath);
		console.log(`    ${exists ? "✓" : "✗"}  ${fullPath}`);
	}
	console.log(sep);
}

async function runHandshake(torrentPath: string): Promise<void> {
	const { decode } = await import("./torrent/parser");
	const { TorrentMetadata, log } = await import("./torrent/metadata");
	const { TorrentSession } = await import("./torrent/session");
	const { announce } = await import("./torrent/tracker/http-tracker");
	const { PeerManager } = await import("./torrent/peer/manager");
	const { getPeerId, peerIdToString } = await import("./torrent/peer/peer-id");
	const { loadConfig } = await import("./config/index");

	const config = loadConfig();
	const downloadPath = config.downloadPath.replace("~", process.env["HOME"] ?? ".");

	const raw = new Uint8Array(readFileSync(torrentPath));
	const decoded = decode(raw);
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded) || decoded instanceof Uint8Array) {
		fail("Invalid torrent file");
	}

	const metadata = new TorrentMetadata(decoded as { [key: string]: import("./torrent/parser").BencodeValue });
	metadata.logSummary();

	const peerId = getPeerId();
	log("peer-id", peerIdToString(peerId).slice(0, 20));

	const session = new TorrentSession(metadata, downloadPath);
	await session.start();

	const trackerResult = await announce(metadata).catch(() => null);
	const peers = trackerResult?.peers ?? [];

	const manager = new PeerManager(metadata);
	await manager.start();
	await manager.connect(peers);

	// Wait up to 15s for handshakes and bitfields to come in
	await new Promise((r) => setTimeout(r, 15_000));

	const connected = [...manager.connections.values()];
	const sep = "-".repeat(40);
	console.log(`\n${sep}`);
	console.log("  Phase 2 Summary");
	console.log(sep);
	console.log(`  listening port   ${manager["listener"].port}`);
	console.log(`  attempted        ${peers.length}`);
	console.log(`  handshakes OK    ${connected.length}`);
	console.log(`  failed           ${peers.length - connected.length}`);

	if (connected.length > 0) {
		console.log("");
		console.log("  Connected peers:");
		console.log(`    ${"Address".padEnd(26)} ${"Pieces".padEnd(12)} Choked   Interested`);
		for (const c of connected) {
			const have = [...c.piecesBitfield].reduce((n, b) => {
				let x = b; let cnt = 0;
				while (x) { cnt += x & 1; x >>>= 1; }
				return n + cnt;
			}, 0);
			const addr = `${c.address}:${c.port}`.padEnd(26);
			const pieces = `${have}/${metadata.pieceCount}`.padEnd(12);
			const choked = c.amChoked ? "yes" : "no ";
			const interested = c.amInterested ? "yes" : "no";
			console.log(`    ${addr} ${pieces} ${choked}      ${interested}`);
		}
	}
	console.log(sep);

	manager.close();
}

async function main() {
	const args = process.argv.slice(2);
	const torrentArg = args.find((a) => !a.startsWith("--"));
	const isVerify = args.includes("--verify");
	const isHandshake = args.includes("--handshake");

	if (torrentArg) {
		const torrentPath = validateTorrentArg(torrentArg);

		if (isVerify) {
			await runVerify(torrentPath).catch((e) =>
				fail(`Error: ${e instanceof Error ? e.message : e}`),
			);
			return;
		}

		if (isHandshake) {
			await runHandshake(torrentPath).catch((e) =>
				fail(`Error: ${e instanceof Error ? e.message : e}`),
			);
			return;
		}

		try {
			await getPeers(torrentPath, 6881, 50);
		} catch (e) {
			fail(`Error: ${e instanceof Error ? e.message : e}`);
		}

		return;
	}

	const { App } = await import("./app");
	const app = new App();
	app.start();
}

main();
