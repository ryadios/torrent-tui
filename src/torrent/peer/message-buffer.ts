export class MessageBuffer {
	private buf = new Uint8Array(0);

	push(chunk: Uint8Array): Uint8Array[] {
		// Append chunk to internal buffer
		const merged = new Uint8Array(this.buf.length + chunk.length);
		merged.set(this.buf);
		merged.set(chunk, this.buf.length);
		this.buf = merged;

		const messages: Uint8Array[] = [];

		while (this.buf.length >= 4) {
			const length =
				((this.buf[0] ?? 0) << 24) |
				((this.buf[1] ?? 0) << 16) |
				((this.buf[2] ?? 0) << 8) |
				(this.buf[3] ?? 0);

			// length=0 is a keepalive — complete message is just the 4 length bytes
			const totalLen = 4 + length;

			if (this.buf.length < totalLen) break;

			messages.push(this.buf.slice(0, totalLen));
			this.buf = this.buf.slice(totalLen);
		}

		return messages;
	}
}
