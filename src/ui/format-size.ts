export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";

	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1000 && unitIndex < units.length - 1) {
		value /= 1000;
		unitIndex += 1;
	}

	return unitIndex === 0
		? `${Math.round(value)} ${units[unitIndex]}`
		: `${value.toFixed(1)} ${units[unitIndex]}`;
}
