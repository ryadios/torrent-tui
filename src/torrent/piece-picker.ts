import type { PeerConnection } from "./peer/connection.ts";

export class PiecePicker {
	private availability = new Map<number, number>(); // pieceIndex → peer count

	constructor(
		private pieceCount: number,
		private hasPiece: (i: number) => boolean,
		private isInProgress: (i: number) => boolean,
		private isWanted: (i: number) => boolean = () => true,
	) {}

	addPeer(conn: PeerConnection): void {
		for (let i = 0; i < this.pieceCount; i++) {
			if (conn.hasPiece(i)) {
				this.availability.set(i, (this.availability.get(i) ?? 0) + 1);
			}
		}
	}

	removePeer(conn: PeerConnection): void {
		for (let i = 0; i < this.pieceCount; i++) {
			if (conn.hasPiece(i)) {
				const n = (this.availability.get(i) ?? 1) - 1;
				if (n <= 0) this.availability.delete(i);
				else this.availability.set(i, n);
			}
		}
	}

	onHave(pieceIndex: number): void {
		this.availability.set(
			pieceIndex,
			(this.availability.get(pieceIndex) ?? 0) + 1,
		);
	}

	// Returns the lowest-availability unstarted wanted piece this peer has.
	// In-progress pieces are handled by Tier 1 in nextBlock() — skip them here.
	pick(conn: PeerConnection): number | null {
		let best = -1;
		let bestAvail = Infinity;

		for (let i = 0; i < this.pieceCount; i++) {
			if (this.hasPiece(i)) continue;
			if (this.isInProgress(i)) continue; // Tier 1 handles these
			if (!this.isWanted(i)) continue;
			if (!conn.hasPiece(i)) continue;

			const avail = this.availability.get(i) ?? 1;
			if (avail < bestAvail) {
				bestAvail = avail;
				best = i;
			}
		}

		return best === -1 ? null : best;
	}

	availabilityOf(pieceIndex: number): number {
		return this.availability.get(pieceIndex) ?? 0;
	}
}
