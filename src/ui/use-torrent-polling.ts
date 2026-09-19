import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 2_000;

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
