import type { TorrentMetadata } from "../metadata.ts";
import type {
	PeerInfo,
	TrackerAnnounceRequest,
	TrackerEvent,
	TrackerResponse,
} from "../types.ts";
import { announceHTTPTracker } from "./http-tracker.ts";
import { announceUDP } from "./udp-tracker.ts";

const DEFAULT_INTERVAL_MS = 1_800_000;
const MIN_INTERVAL_MS = 60_000;
const INITIAL_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 600_000;

interface TrackerState {
	url: string;
	timer: unknown | null;
	inFlight: boolean;
	inFlightPromise: Promise<void> | null;
	pendingRefresh: boolean;
	pendingEvent?: TrackerEvent;
	backoffMs: number;
}

interface TrackerSnapshot {
	downloaded: number;
	uploaded: number;
	left: number;
}

interface Scheduler {
	setTimeout(fn: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface TrackerCoordinatorOptions {
	port?: number;
	numwant?: number;
	peerId?: Uint8Array;
	getSnapshot: () => TrackerSnapshot;
	onPeers?: (peers: PeerInfo[], response: TrackerResponse, url: string) => void;
	announceTracker?: (
		url: string,
		metadata: TorrentMetadata,
		request: TrackerAnnounceRequest,
	) => Promise<TrackerResponse>;
	scheduler?: Scheduler;
}

export class TrackerCoordinator {
	private readonly states = new Map<string, TrackerState>();
	private readonly port: number;
	private readonly numwant: number;
	private readonly announceTracker;
	private readonly scheduler: Scheduler;
	private stopped = false;
	private completed = false;

	constructor(
		private readonly metadata: TorrentMetadata,
		private readonly options: TrackerCoordinatorOptions,
	) {
		this.port = options.port ?? 6881;
		this.numwant = options.numwant ?? 50;
		this.announceTracker = options.announceTracker ?? announceSingleTracker;
		this.scheduler = options.scheduler ?? {
			setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};

		for (const url of uniqueTrackerUrls(metadata)) {
			this.states.set(url, {
				url,
				timer: null,
				inFlight: false,
				inFlightPromise: null,
				pendingRefresh: false,
				backoffMs: INITIAL_BACKOFF_MS,
			});
		}
	}

	start(): void {
		if (this.stopped) return;
		for (const state of this.states.values()) {
			this.enqueue(state, "started");
		}
	}

	markCompleted(): void {
		if (this.stopped || this.completed) return;
		this.completed = true;
		for (const state of this.states.values()) {
			this.enqueue(state, "completed");
		}
	}

	refreshNow(): void {
		if (this.stopped) return;
		for (const state of this.states.values()) {
			if (state.inFlight) {
				state.pendingRefresh = true;
				continue;
			}
			this.enqueue(state);
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;

		const pending: Promise<void>[] = [];
		for (const state of this.states.values()) {
			if (state.timer) {
				this.scheduler.clearTimeout(state.timer);
				state.timer = null;
			}
			if (state.inFlight) {
				state.pendingEvent = prioritizeEvent(state.pendingEvent, "stopped");
				if (state.inFlightPromise) pending.push(state.inFlightPromise);
			} else {
				pending.push(this.runAnnounce(state, "stopped"));
			}
		}
		await Promise.allSettled(pending);
	}

	private enqueue(state: TrackerState, event?: TrackerEvent): void {
		if (this.stopped && event !== "stopped") return;
		if (state.inFlight) {
			if (event) {
				state.pendingEvent = prioritizeEvent(state.pendingEvent, event);
			}
			return;
		}
		void this.runAnnounce(state, event);
	}

	private async runAnnounce(
		state: TrackerState,
		event?: TrackerEvent,
	): Promise<void> {
		if ((this.stopped && event !== "stopped") || state.inFlight) return;
		const operation = this.runAnnounceBody(state, event);
		state.inFlightPromise = operation;
		try {
			await operation;
		} finally {
			if (state.inFlightPromise === operation) state.inFlightPromise = null;
		}
	}

	private async runAnnounceBody(
		state: TrackerState,
		event?: TrackerEvent,
	): Promise<void> {
		state.inFlight = true;
		if (state.timer) {
			this.scheduler.clearTimeout(state.timer);
			state.timer = null;
		}

		let nextDelayMs: number | null = null;
		try {
			const response = await this.announceTracker(
				state.url,
				this.metadata,
				this.buildRequest(event),
			);
			state.backoffMs = INITIAL_BACKOFF_MS;
			nextDelayMs = clampIntervalMs(response.interval);
			this.options.onPeers?.(response.peers, response, state.url);
		} catch {
			if (!this.stopped && event !== "stopped") {
				nextDelayMs = state.backoffMs;
				state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
			}
		} finally {
			state.inFlight = false;
		}

		const pendingEvent = state.pendingEvent;
		state.pendingEvent = undefined;
		if (pendingEvent) {
			await this.runAnnounce(state, pendingEvent);
			return;
		}

		if (this.stopped || event === "stopped" || nextDelayMs === null) return;
		if (state.pendingRefresh) {
			state.pendingRefresh = false;
			await this.runAnnounce(state);
			return;
		}
		state.timer = this.scheduler.setTimeout(() => {
			state.timer = null;
			this.enqueue(state);
		}, nextDelayMs);
	}

	private buildRequest(event?: TrackerEvent): TrackerAnnounceRequest {
		const snapshot = this.options.getSnapshot();
		return {
			port: this.port,
			numwant: this.numwant,
			uploaded: snapshot.uploaded,
			downloaded: snapshot.downloaded,
			left: snapshot.left,
			event,
			peerId: this.options.peerId,
		};
	}
}

function uniqueTrackerUrls(metadata: TorrentMetadata): string[] {
	return [...new Set(metadata.announceList.flat())];
}

function clampIntervalMs(intervalSeconds: number | undefined): number {
	if (!intervalSeconds || intervalSeconds <= 0) return DEFAULT_INTERVAL_MS;
	return Math.max(MIN_INTERVAL_MS, intervalSeconds * 1000);
}

function prioritizeEvent(
	current: TrackerEvent | undefined,
	next: TrackerEvent,
): TrackerEvent {
	if (!current) return next;
	return eventPriority(next) >= eventPriority(current) ? next : current;
}

function eventPriority(event: TrackerEvent): number {
	switch (event) {
		case "stopped":
			return 3;
		case "completed":
			return 2;
		case "started":
			return 1;
	}
}

async function announceSingleTracker(
	url: string,
	metadata: TorrentMetadata,
	request: TrackerAnnounceRequest,
): Promise<TrackerResponse> {
	if (url.startsWith("udp://")) {
		return announceUDP(url, metadata, request);
	}
	return announceHTTPTracker(url, metadata, request);
}
