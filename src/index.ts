import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

class CliExit extends Error {}

async function getVersion(): Promise<string> {
	const pkg = await import("../package.json");
	return pkg.default.version as string;
}

function fail(msg: string): never {
	console.error(msg);
	process.exitCode = 1;
	throw new CliExit();
}

async function printHelp(): Promise<void> {
	const version = await getVersion();
	console.log(`torrent-tui ${version}

Usage:
  torrent-tui                         Start the terminal UI
  torrent-tui <file.torrent>          Start the TUI and add the torrent
  torrent-tui <magnet-uri>            Start the TUI and fetch magnet metadata
  torrent-tui <file.torrent> --verify Verify local pieces and trackers
  torrent-tui <file.torrent> --handshake
                                      Connect to peers and print handshake summary
  torrent-tui <file.torrent|magnet> --download
                                      Download from the command line

Magnet links:
  Supported for tracker-backed magnets and magnets with x.pe peers.
  DHT-only magnets require the planned DHT phase.
  --verify and --handshake can use a magnet after its metadata is cached.

Options:
  --help, -h                          Show this help
  --version, -v                       Print the version`);
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

async function resolveTorrentArg(arg: string): Promise<string> {
	const { isMagnetUri } = await import("./torrent/magnet");
	if (!isMagnetUri(arg)) return validateTorrentArg(arg);
	const { resolveMagnetToTorrent } = await import("./torrent/magnet-resolver");
	const result = await resolveMagnetToTorrent(arg);
	return result.torrentPath;
}

async function cachedTorrentArg(arg: string): Promise<string> {
	const { isMagnetUri, parseMagnetUri } = await import("./torrent/magnet");
	if (!isMagnetUri(arg)) return validateTorrentArg(arg);
	const { metadataCachePath, readCachedMetadata } = await import(
		"./torrent/metadata-cache"
	);
	const magnet = parseMagnetUri(arg);
	if (!readCachedMetadata(magnet.infoHashHex)) {
		fail("Error: cached metadata not found; add or download the magnet first");
	}
	return metadataCachePath(magnet.infoHashHex);
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
	const { resolvePath } = await import("./utils/paths");
	const downloadPath = resolvePath(config.downloadPath);
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

	const metadata = new TorrentMetadata(
		decoded as { [key: string]: import("./torrent/parser").BencodeValue },
		raw,
	);
	const session = new TorrentSession(metadata, downloadPath);
	return { metadata, session, downloadPath };
}

async function runVerify(torrentPath: string): Promise<void> {
	const { log } = await import("./torrent/metadata");
	const { announce } = await import("./torrent/tracker/announce");
	const { metadata, session, downloadPath } = await loadTorrent(torrentPath);

	metadata.logSummary();
	await session.start();

	const trackerResult = await announce(metadata).catch(() => null);
	const peers = trackerResult?.peers ?? [];

	let valid = 0;
	let missing = 0;
	const corrupt = 0;
	for (let i = 0; i < metadata.pieceCount; i++) {
		if (session.storage.hasPiece(i)) valid++;
		else missing++;
	}

	console.log("");
	sep();
	console.log("  Verify Summary");
	sep();
	log(
		"storage",
		`${metadata.files.map((f) => join(downloadPath, f.path)).join(", ")}`,
	);
	log(
		"verify",
		`${valid} valid   ${missing} missing   ${corrupt} corrupt   (${metadata.pieceCount} total)`,
	);
	log("tracker", `${peers.length} peers`);
	console.log("");
	for (const file of metadata.files) {
		const fullPath = join(downloadPath, file.path);
		console.log(`  ${existsSync(fullPath) ? "✓" : "✗"}  ${fullPath}`);
	}
	sep();
}

async function runHandshake(torrentPath: string): Promise<void> {
	const { announce } = await import("./torrent/tracker/announce");
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
	console.log(
		`  connected    ${connected.length}    unchoked ${unchoked.length}    failed ${failed}`,
	);

	if (connected.length > 0) {
		const AW = 46; // address column width (fits longest IPv6+port)
		const CW = 10; // client ID column
		const PW = 13; // pieces column
		console.log("");
		console.log(
			`  ${"address".padEnd(AW)}  ${"client".padEnd(CW)}  ${"pieces".padEnd(PW)}  choked`,
		);
		console.log(`  ${"-".repeat(W - 2)}`);
		for (const c of connected) {
			const addr = `${c.address}:${c.port}`.padEnd(AW);
			const client = c.peerId.slice(0, 8).padEnd(CW);
			const pieces = `${c.countPiecesPublic()}/${metadata.pieceCount}`.padEnd(
				PW,
			);
			const choked = c.amChoked ? "yes" : "no";
			console.log(`  ${addr}  ${client}  ${pieces}  ${choked}`);
		}
	}
	console.log(line);

	manager.close();
}

async function runDownload(torrentPath: string): Promise<void> {
	const { PeerManager } = await import("./torrent/peer/manager");
	const { getPeerId, peerIdToString } = await import("./torrent/peer/peer-id");
	const { TrackerCoordinator } = await import("./torrent/tracker/coordinator");
	const {
		createUploadedAccumulator,
		recordRemovedPeerUpload,
		uploadedSnapshot,
	} = await import("./torrent/upload-accounting");
	const { metadata, session } = await loadTorrent(torrentPath);
	const { log } = await import("./torrent/metadata");

	metadata.logSummary();
	log("peer-id", peerIdToString(getPeerId()));

	await session.start();

	console.log("");
	const manager = new PeerManager(metadata);
	await manager.start();
	const uploadedAccumulator = createUploadedAccumulator();
	const trackerCoordinator = new TrackerCoordinator(metadata, {
		getSnapshot: () => {
			const downloaded = session.storage.downloadedBytes;
			const uploaded = uploadedSnapshot(
				uploadedAccumulator,
				manager.connections.values(),
			);
			return {
				downloaded,
				uploaded,
				left: Math.max(0, metadata.totalSize - downloaded),
			};
		},
		onPeers: (peers) => {
			void manager.connect(peers).then(() => {
				const unchokedNow = manager.getUnchoked().length;
				log(
					"peers",
					`${manager.connections.size} connected   ${unchokedNow} unchoked`,
				);
			});
		},
	});
	manager.on("peerRemoved", (conn: { uploadedTotal: number } & object) => {
		recordRemovedPeerUpload(uploadedAccumulator, conn);
		if (manager.connections.size === 0) trackerCoordinator.refreshNow();
	});
	trackerCoordinator.start();

	manager.startChoking();
	const downloader = session.download(manager);
	session.on("complete", () => trackerCoordinator.markCompleted());

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
	console.log(
		`  pieces       ${downloaded} / ${metadata.pieceCount} downloaded`,
	);
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

	await trackerCoordinator.stop();
	manager.close();
}

async function main() {
	const args = process.argv.slice(2);

	if (args.includes("--help") || args.includes("-h")) {
		await printHelp();
		return;
	}

	if (args.includes("--version") || args.includes("-v")) {
		console.log(await getVersion());
		return;
	}

	const torrentArg = args.find((a) => !a.startsWith("--"));
	const isVerify = args.includes("--verify");
	const isHandshake = args.includes("--handshake");
	const isDownload = args.includes("--download");

	if (torrentArg) {
		const { isMagnetUri } = await import("./torrent/magnet");
		const torrentPath = isMagnetUri(torrentArg)
			? torrentArg
			: validateTorrentArg(torrentArg);

		if (isVerify) {
			const resolvedPath = await cachedTorrentArg(torrentPath);
			await runVerify(resolvedPath).catch((e) =>
				fail(`Error: ${e instanceof Error ? e.message : e}`),
			);
			return;
		}

		if (isHandshake) {
			const resolvedPath = await cachedTorrentArg(torrentPath);
			await runHandshake(resolvedPath).catch((e) =>
				fail(`Error: ${e instanceof Error ? e.message : e}`),
			);
			return;
		}

		if (isDownload) {
			const resolvedPath = await resolveTorrentArg(torrentPath).catch((e) =>
				fail(`Error: ${e instanceof Error ? e.message : e}`),
			);
			await runDownload(resolvedPath).catch((e) =>
				fail(`Error: ${e instanceof Error ? e.message : e}`),
			);
			return;
		}

		const { App } = await import("./app");
		const app = new App();
		await app.start(torrentPath);
		return;
	}

	const { App } = await import("./app");
	const app = new App();
	await app.start();
}

main().catch((err: unknown) => {
	if (err instanceof CliExit) return;
	process.exitCode = 1;
	console.error(`Error: ${err instanceof Error ? err.message : err}`);
});
