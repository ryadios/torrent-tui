export function formatRate(bytesPerSecond: number): string {
	const rate = Math.max(0, bytesPerSecond);
	const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
	let value = rate;
	let unitIndex = 0;

	if (value < 1000) return `${Math.round(value)} B/s`;

	while (value >= 1000 && unitIndex < units.length - 1) {
		value /= 1000;
		unitIndex += 1;
	}

	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
