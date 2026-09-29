import { useEffect, useRef } from "react";

export const POLL_INTERVAL_MS = 1_000;

type UseTorrentPollingOptions = {
	enabled: boolean;
	onTick: () => void;
};

export function useTorrentPolling({
	enabled,
	onTick,
}: UseTorrentPollingOptions): void {
	const onTickRef = useRef(onTick);
	onTickRef.current = onTick;

	useEffect(() => {
		if (!enabled) return;

		const interval = setInterval(() => {
			onTickRef.current();
		}, POLL_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [enabled]);
}
