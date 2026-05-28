import type { TorrentMetadata } from "../metadata.ts";
import { log } from "../metadata.ts";
import type { TrackerResponse } from "../types.ts";
import { announceHTTP } from "./http-tracker.ts";
import { announceUDP } from "./udp-tracker.ts";

export async function announce(
	metadata: TorrentMetadata,
	port = 6881,
	numwant = 50,
): Promise<TrackerResponse> {
	const flat = metadata.announceList.flat();
	const hasHTTP = flat.some((u) => u.startsWith("http"));
	const udpUrls = [...new Set(flat.filter((u) => u.startsWith("udp://")))];

	const [httpPeers, udpResults] = await Promise.all([
		hasHTTP ? announceHTTP(metadata, port, numwant) : Promise.resolve([]),
		Promise.allSettled(udpUrls.map((u) => announceUDP(u, metadata, port))),
	]);

	const seen = new Set<string>(httpPeers.map((p) => `${p.ip}:${p.port}`));
	const allPeers = [...httpPeers];

	for (const r of udpResults) {
		if (r?.status === "fulfilled") {
			for (const p of r.value) {
				const k = `${p.ip}:${p.port}`;
				if (!seen.has(k)) {
					seen.add(k);
					allPeers.push(p);
				}
			}
		}
	}

	log("tracker", `${allPeers.length} unique peers`);

	return { complete: 0, incomplete: 0, interval: 1800, peers: allPeers };
}
