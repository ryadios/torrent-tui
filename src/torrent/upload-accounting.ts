export interface UploadedPeer {
	uploadedTotal: number;
}

export interface UploadedAccumulator {
	cumulativeUploaded: number;
	accountedPeers: WeakSet<object>;
}

export function createUploadedAccumulator(): UploadedAccumulator {
	return {
		cumulativeUploaded: 0,
		accountedPeers: new WeakSet<object>(),
	};
}

export function recordRemovedPeerUpload(
	accumulator: UploadedAccumulator,
	peer: UploadedPeer & object,
): void {
	if (accumulator.accountedPeers.has(peer)) return;
	accumulator.accountedPeers.add(peer);
	accumulator.cumulativeUploaded += peer.uploadedTotal;
}

export function uploadedSnapshot(
	accumulator: UploadedAccumulator,
	livePeers: Iterable<UploadedPeer>,
): number {
	let uploaded = accumulator.cumulativeUploaded;
	for (const peer of livePeers) {
		uploaded += peer.uploadedTotal;
	}
	return uploaded;
}
