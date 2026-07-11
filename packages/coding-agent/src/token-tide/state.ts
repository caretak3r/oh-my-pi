/** Fixed-length ring buffer capacity: how many sampled columns the full-tier waveform scrolls through. */
const DEFAULT_CAPACITY = 48;

/**
 * Mutable, session-scoped ring buffer of tok/s samples. Fixed length from
 * construction (zero-filled) so the buffer snapshot handed to the pure
 * renderer is always the same shape regardless of how long the session has
 * been running. Mutation happens only in {@link pushSample}, driven by the
 * widget's per-frame sampling; rendering reads an immutable {@link snapshot}.
 */
export class TokenTideState {
	#buffer: number[];
	#capacity: number;

	constructor(options: { capacity?: number } = {}) {
		this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
		this.#buffer = new Array(this.#capacity).fill(0);
	}

	/** Buffer length (fixed for the state's lifetime). */
	get capacity(): number {
		return this.#capacity;
	}

	/** Push the newest sample, dropping the oldest. Negative/non-finite rates coerce to `0` (idle). */
	pushSample(tokensPerSecond: number): void {
		const sample = Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : 0;
		this.#buffer.push(sample);
		if (this.#buffer.length > this.#capacity) this.#buffer.shift();
	}

	/** Immutable, oldest-to-newest view for the pure renderer. */
	snapshot(): readonly number[] {
		return [...this.#buffer];
	}

	/** Most recently pushed sample (`0` before the first sample). */
	latest(): number {
		return this.#buffer[this.#buffer.length - 1] ?? 0;
	}
}
