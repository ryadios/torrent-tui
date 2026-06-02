import { log } from "../metadata.ts";
import type {
	TrackerAnnounceRequest,
	TrackerAnnounceTarget,
	TrackerResponse,
} from "../types.ts";
import { announceHTTP } from "./http-tracker.ts";
import { announceUDP } from "./udp-tracker.ts";

export async function announce(
	metadata: TrackerAnnounceTarget,
	request: Partial<TrackerAnnounceRequest> = {},
): Promise<TrackerResponse> {
	const resolvedRequest: TrackerAnnounceRequest = {
		port: request.port ?? 6881,
		numwant: request.numwant ?? 50,
		uploaded: request.uploaded ?? 0,
		downloaded: request.downloaded ?? 0,
		left: request.left ?? metadata.totalSize,
		event: request.event,
		peerId: request.peerId,
	};
	const flat = metadata.announceList.flat();
	const hasHTTP = flat.some((u) => u.startsWith("http"));
	const udpUrls = [...new Set(flat.filter((u) => u.startsWith("udp://")))];

	const [httpResults, udpResults] = await Promise.all([
		hasHTTP ? announceHTTP(metadata, resolvedRequest) : Promise.resolve([]),
		Promise.allSettled(
			udpUrls.map((u) => announceUDP(u, metadata, resolvedRequest)),
		),
	]);

	const successes = [...httpResults];

	for (const r of udpResults) {
		if (r?.status === "fulfilled") {
			successes.push(r.value);
		}
	}

	const seen = new Set<string>();
	const allPeers = [];
	let interval = 1800;
	let complete = 0;
	let incomplete = 0;

	for (const response of successes) {
		interval = Math.min(interval, response.interval || 1800);
		complete = Math.max(complete, response.complete);
		incomplete = Math.max(incomplete, response.incomplete);
		for (const peer of response.peers) {
			const key = `${peer.ip}:${peer.port}`;
			if (seen.has(key)) continue;
			seen.add(key);
			allPeers.push(peer);
		}
	}

	log("tracker", `${allPeers.length} unique peers`);

	return { complete, incomplete, interval, peers: allPeers };
}
