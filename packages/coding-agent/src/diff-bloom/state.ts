import { BLOOM_DURATION_MS } from "./bloom";

/**
 * `idle`: no motion, byte-identical static/blank row (either no edit landed
 * yet this session, or the last bloom fully wiped clear).
 * `blooming`: an `edit` `tool_result` with a real, non-empty diff just
 * landed; the flower is opening and will wipe clear over
 * {@link BLOOM_DURATION_MS}.
 */
export type DiffBloomPhase = "idle" | "blooming";

export interface DiffBloomSnapshot {
	readonly phase: DiffBloomPhase;
	/** Display path of the most recent bloomed edit. `undefined` before any bloom. */
	readonly path: string | undefined;
	/** Added line count from the most recent bloom's diff stats. */
	readonly added: number;
	/** Removed line count from the most recent bloom's diff stats. */
	readonly removed: number;
	/** Total blooms observed this session. */
	readonly bloomCount: number;
}

/** How long a bloom stays visibly active before settling — the wipe's own full duration. */
const SETTLE_MS = BLOOM_DURATION_MS;

/**
 * Mutable, session-scoped Diff Bloom model. All timestamps come from the
 * caller's injected clock (never `Date.now`/`performance.now` read directly
 * here), so the whole state machine is deterministic and snapshot-testable.
 * Tracks a single active bloom, mirroring Reflection Ripple: a fresh edit
 * replaces any still-blooming one rather than queuing a backlog.
 */
export class DiffBloomState {
	#phase: DiffBloomPhase = "idle";
	#bloomedAt = 0;
	#path: string | undefined;
	#added = 0;
	#removed = 0;
	#bloomCount = 0;

	get phase(): DiffBloomPhase {
		return this.#phase;
	}

	/**
	 * An `edit` `tool_result` landed a real diff: (re)start the single bloom
	 * from `now`, replacing any still-opening one.
	 */
	applyBloom(path: string | undefined, added: number, removed: number, now: number): void {
		this.#phase = "blooming";
		this.#bloomedAt = now;
		this.#path = path;
		this.#added = added;
		this.#removed = removed;
		this.#bloomCount += 1;
	}

	/** Milliseconds since the current bloom was triggered. Only meaningful while `blooming`. */
	bloomElapsedMs(now: number): number {
		return Math.max(0, now - this.#bloomedAt);
	}

	/**
	 * Advance past a finished bloom. Returns `true` exactly once, on the
	 * `blooming` -> `idle` transition — the caller's cue to tear the animated
	 * mount down to a static widget (zero further frame-clock subscriptions).
	 */
	settleIfDone(now: number): boolean {
		if (this.#phase !== "blooming") return false;
		if (this.bloomElapsedMs(now) < SETTLE_MS) return false;
		this.#phase = "idle";
		return true;
	}

	snapshot(): DiffBloomSnapshot {
		return {
			phase: this.#phase,
			path: this.#path,
			added: this.#added,
			removed: this.#removed,
			bloomCount: this.#bloomCount,
		};
	}
}
