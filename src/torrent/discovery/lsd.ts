import { createSocket, type Socket } from "node:dgram";
import type { TorrentMetadata } from "../metadata";
import type { PeerInfo } from "../types";

const LSD_ADDRESS = "239.192.152.143";
const LSD_PORT = 6771;
const LSD_INTERVAL_MS = 5 * 60_000;

export interface LsdAnnounce {
	cookie: string;
	host: string;
	infoHashHex: string;
	port: number;
}

export class LsdService {
	private socket: Socket | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly cookie = Math.random().toString(16).slice(2, 10);

	constructor(
		private readonly metadata: TorrentMetadata,
		private readonly port: number,
		private readonly onPeer: (peer: PeerInfo) => void,
		private readonly multicastAddress = LSD_ADDRESS,
		private readonly multicastPort = LSD_PORT,
	) {}

	async start(): Promise<void> {
		if (this.metadata.private) return;
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		this.socket = socket;
		socket.on("message", (message, remote) => {
			const announce = parseLsdAnnounce(message.toString("utf-8"));
			if (!announce) return;
			if (announce.cookie === this.cookie) return;
			if (
				announce.infoHashHex !==
				Buffer.from(this.metadata.infoHash).toString("hex")
			)
				return;
			this.onPeer({ ip: remote.address, port: announce.port });
		});
		await new Promise<void>((resolve, reject) => {
			let binding = true;
			const onError = (err: Error): void => {
				if (binding) reject(err);
			};
			socket.on("error", onError);
			socket.bind(this.multicastPort, () => {
				binding = false;
				try {
					socket.addMembership(this.multicastAddress);
				} catch {
					// Some systems disallow multicast membership in containers.
				}
				resolve();
			});
		});
		this.announce();
		this.timer = setInterval(() => this.announce(), LSD_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.socket?.close();
		this.socket = null;
	}

	private announce(): void {
		if (!this.socket) return;
		const message = buildLsdAnnounce({
			cookie: this.cookie,
			host: "0.0.0.0",
			infoHashHex: Buffer.from(this.metadata.infoHash).toString("hex"),
			port: this.port,
		});
		this.socket.send(message, this.multicastPort, this.multicastAddress);
	}
}

export function buildLsdAnnounce(announce: LsdAnnounce): Buffer {
	return Buffer.from(
		[
			"BT-SEARCH * HTTP/1.1",
			`Host: ${announce.host}:${LSD_PORT}`,
			`Port: ${announce.port}`,
			`Infohash: ${announce.infoHashHex.toUpperCase()}`,
			`cookie: ${announce.cookie}`,
			"",
			"",
		].join("\r\n"),
		"utf-8",
	);
}

export function parseLsdAnnounce(message: string): LsdAnnounce | null {
	const lines = message.split(/\r?\n/);
	if (lines[0] !== "BT-SEARCH * HTTP/1.1") return null;
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
	}
	const hostHeader = headers.get("host") ?? "";
	const host = hostHeader.split(":")[0] ?? "";
	const port = Number(headers.get("port"));
	const infoHashHex = (headers.get("infohash") ?? "").toLowerCase();
	const cookie = headers.get("cookie") ?? "";
	if (!/^[0-9a-f]{40}$/.test(infoHashHex)) return null;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return { cookie, host, infoHashHex, port };
}
