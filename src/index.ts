import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

function sep(): void {
	console.log("-".repeat(44));
}

async function loadTorrent(torrentPath: string) {
	const { decode } = await import("./torrent/parser");
	const { TorrentMetadata } = await import("./torrent/metadata");
	const { TorrentSession } = await import("./torrent/session");
	const { loadConfig } = await import("./config/index");

	const config = loadConfig();
	const downloadPath = config.downloadPath.replace("~", process.env["HOME"] ?? ".");
	const raw = new Uint8Array(readFileSync(torrentPath));
	const decoded = decode(raw);

	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded) || decoded instanceof Uint8Array) {
		fail("Invalid torrent file");
	}

	const metadata = new TorrentMetadata(
		decoded as { [key: string]: import("./torrent/parser").BencodeValue },
		raw,
	);
	const session = new TorrentSession(metadata, downloadPath);
	return { metadata, session, downloadPath };
}

async function runVerify(torrentPath: string): Promise<void> {
	const { log } = await import("./torrent/metadata");
	const { announce } = await import("./torrent/tracker/http-tracker");
	const { metadata, session, downloadPath } = await loadTorrent(torrentPath);

	metadata.logSummary();
	await session.start();

	const trackerResult = await announce(metadata).catch(() => null);
	const peers = trackerResult?.peers ?? [];

	let valid = 0;
	let missing = 0;
	let corrupt = 0;
	for (let i = 0; i < metadata.pieceCount; i++) {
		if (session.storage.hasPiece(i)) valid++;
		else missing++;
	}

	console.log("");
	sep();
	console.log("  Verify Summary");
	sep();
	log("storage", `${metadata.files.map((f) => join(downloadPath, f.path)).join(", ")}`);
	log("verify", `${valid} valid   ${missing} missing   ${corrupt} corrupt   (${metadata.pieceCount} total)`);
	log("tracker", `${peers.length} peers`);
	console.log("");
	for (const file of metadata.files) {
		const fullPath = join(downloadPath, file.path);
		console.log(`  ${existsSync(fullPath) ? "✓" : "✗"}  ${fullPath}`);
	}
	sep();
}

async function runHandshake(torrentPath: string): Promise<void> {
	const { announce } = await import("./torrent/tracker/http-tracker");
	const { PeerManager } = await import("./torrent/peer/manager");
	const { getPeerId, peerIdToString } = await import("./torrent/peer/peer-id");
	const { metadata, session } = await loadTorrent(torrentPath);

	metadata.logSummary();
	const { log } = await import("./torrent/metadata");
	log("peer-id", peerIdToString(getPeerId()));

	// session.start() internally logs storage + verify
	await session.start();

	// announce() internally logs tracker result
	const trackerResult = await announce(metadata).catch(() => null);
	const peers = trackerResult?.peers ?? [];

	console.log("");

	// manager.start() internally logs the listener port
	const manager = new PeerManager(metadata);
	await manager.start();

	// connect() logs one "handshake" line per peer (success or timeout)
	await manager.connect(peers);

	// Wait up to 15s for bitfields and unchokes to arrive
	await new Promise((r) => setTimeout(r, 15_000));

	const connected = [...manager.connections.values()];
	const unchoked = connected.filter((c) => !c.amChoked);
	const failed = peers.length - connected.length;

	// Summary
	const W = 80;
	const line = "-".repeat(W);
	console.log(`\n${line}`);
	console.log("  Connection Summary");
	console.log(line);
	console.log(`  attempted    ${peers.length}`);
	console.log(`  connected    ${connected.length}    unchoked ${unchoked.length}    failed ${failed}`);

	if (connected.length > 0) {
		const AW = 46; // address column width (fits longest IPv6+port)
		const CW = 10; // client ID column
		const PW = 13; // pieces column
		console.log("");
		console.log(`  ${"address".padEnd(AW)}  ${"client".padEnd(CW)}  ${"pieces".padEnd(PW)}  choked`);
		console.log(`  ${"-".repeat(W - 2)}`);
		for (const c of connected) {
			const addr = `${c.address}:${c.port}`.padEnd(AW);
			const client = c.peerId.slice(0, 8).padEnd(CW);
			const pieces = `${c.countPiecesPublic()}/${metadata.pieceCount}`.padEnd(PW);
			const choked = c.amChoked ? "yes" : "no";
			console.log(`  ${addr}  ${client}  ${pieces}  ${choked}`);
		}
	}
	console.log(line);

	manager.close();
}

async function runDownload(torrentPath: string): Promise<void> {
	const { announce } = await import("./torrent/tracker/http-tracker");
	const { PeerManager } = await import("./torrent/peer/manager");
	const { getPeerId, peerIdToString } = await import("./torrent/peer/peer-id");
	const { metadata, session } = await loadTorrent(torrentPath);
	const { log } = await import("./torrent/metadata");

	metadata.logSummary();
	log("peer-id", peerIdToString(getPeerId()));

	await session.start();

	const trackerResult = await announce(metadata).catch(() => null);
	const peers = trackerResult?.peers ?? [];

	console.log("");
	const manager = new PeerManager(metadata);
	await manager.start();

	// connect() now resolves only after each handshake completes —
	// so all handshake logs finish before the progress bar starts
	await manager.connect(peers);

	if (manager.connections.size === 0) {
		log("error", "no peers connected — cannot download");
		manager.close();
		return;
	}

	const downloader = session.download(manager);
	log("log file", downloader.getLogFilePath());
	console.log("");

	await new Promise<void>((resolve) => {
		session.on("complete", () => resolve());
		process.on("SIGINT", () => {
			downloader.stop();
			resolve();
		});
	});

	const downloaded = session.storage.downloadedCount;
	const W = 80;
	const line = "-".repeat(W);

	console.log(`\n${line}`);
	console.log("  Download Summary");
	console.log(line);
	console.log(`  torrent      ${metadata.name}`);
	console.log(`  pieces       ${downloaded} / ${metadata.pieceCount} downloaded`);
	console.log(`  status       ${session.status}`);

	if (downloaded > 0) {
		const resumeDir = join(
			(await import("./utils/paths")).getDataDir(),
			"resume",
		);
		const hex = Buffer.from(metadata.infoHash).toString("hex");
		console.log(`  resume       ${resumeDir}/${hex}.json`);
	}

	console.log("");
	console.log("  files");
	for (const file of metadata.files) {
		const fullPath = join(session.downloadPath, file.path);
		console.log(`    ${existsSync(fullPath) ? "✓" : "✗"}  ${fullPath}`);
	}
	console.log(line);

	manager.close();
}

async function main() {
	const args = process.argv.slice(2);
	const torrentArg = args.find((a) => !a.startsWith("--"));
	const isVerify = args.includes("--verify");
	const isHandshake = args.includes("--handshake");
	const isDownload = args.includes("--download");

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

		if (isDownload) {
			await runDownload(torrentPath).catch((e) =>
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
