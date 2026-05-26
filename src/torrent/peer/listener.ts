import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { log } from "../metadata.ts";

const PORT_RANGE = [6881, 6882, 6883, 6884, 6885, 6886, 6887, 6888, 6889];

export class PeerListener {
	port: number = 0;
	private server: Server | null = null;
	private connectionCb: ((socket: Socket) => void) | null = null;

	async listen(): Promise<void> {
		for (const p of PORT_RANGE) {
			const success = await this.tryListen(p);
			if (success) {
				this.port = p;
				log("listener", `port ${p}`);
				return;
			}
		}
		throw new Error("No available port in range 6881–6889");
	}

	private tryListen(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const server = createServer((socket) => {
				const remote = `${socket.remoteAddress}:${socket.remotePort}`;
				log("inbound", remote);
				this.connectionCb?.(socket);
			});

			server.once("listening", () => {
				this.server = server;
				resolve(true);
			});

			server.once("error", () => {
				resolve(false);
			});

			server.listen(port);
		});
	}

	onConnection(cb: (socket: Socket) => void): void {
		this.connectionCb = cb;
	}

	close(): void {
		this.server?.close();
	}
}
