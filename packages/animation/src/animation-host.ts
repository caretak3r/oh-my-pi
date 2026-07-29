import { logger } from "@oh-my-pi/pi-utils";
import { type BackpressureSignal, NO_BACKPRESSURE } from "./backpressure";
import type { MotionPolicy } from "./motion-policy";

/**
 * Clock/scheduler seam so tests drive frames deterministically without real
 * timers. `start` begins a repeating tick every `intervalMs` and returns a stop
 * function; `now` supplies the monotonic time used to derive elapsed-ms.
 */
export interface FrameScheduler {
	/** Monotonic clock in milliseconds. */
	now(): number;
	/** Begin ticking every `intervalMs`. Returns a function that stops the tick. */
	start(intervalMs: number, tick: () => void): () => void;
}

/** Default scheduler backed by `performance.now` + `setInterval`/`clearInterval`. */
export const DEFAULT_FRAME_SCHEDULER: FrameScheduler = {
	now: () => performance.now(),
	start(intervalMs, tick) {
		const id = setInterval(tick, intervalMs);
		return () => clearInterval(id);
	},
};

/** Called each emitted frame with a monotonic frame index and elapsed-ms since host start. */
export type FrameListener = (frame: number, elapsedMs: number) => void;

export interface AnimationHostOptions {
	/** Supplies the cadence tier and notifies on live changes. */
	policy: MotionPolicy;
	/** Render-backpressure signal; the host frame-skips (time-based) while under pressure. */
	backpressure?: BackpressureSignal;
	/** Injectable clock/scheduler seam. Defaults to real timers. */
	scheduler?: FrameScheduler;
}

/**
 * One shared frame clock for the whole animated-plugin family. N subscribers
 * coalesce onto exactly one underlying timer; the timer stops when the last
 * subscriber leaves and restarts on re-subscribe. Cadence follows the
 * {@link MotionPolicy} tier (`off` never starts); the host re-syncs live when the
 * policy changes. Elapsed-ms is wall-time-based so effects derive phase from
 * time and stay smooth across frames skipped under backpressure.
 */
export class AnimationHost {
	#policy: MotionPolicy;
	#backpressure: BackpressureSignal;
	#scheduler: FrameScheduler;
	#listeners = new Map<FrameListener, { cadenceMs?: () => number; lastEmitAt?: number }>();
	#stopTimerFn: (() => void) | undefined;
	#activeCadenceMs = 0;
	#frame = 0;
	#startedAt: number | undefined;
	#unsubscribePolicy: (() => void) | undefined;
	#disposed = false;

	constructor(options: AnimationHostOptions) {
		this.#policy = options.policy;
		this.#backpressure = options.backpressure ?? NO_BACKPRESSURE;
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#unsubscribePolicy = this.#policy.subscribe(() => this.#sync());
	}

	/** Number of live subscribers. */
	get subscriberCount(): number {
		return this.#listeners.size;
	}

	/** Whether the underlying timer is currently running. */
	get running(): boolean {
		return this.#stopTimerFn !== undefined;
	}

	/**
	 * Subscribe to frame ticks. Returns an unsubscribe function. Adding the first
	 * subscriber (when the tier allows motion) starts the shared timer; removing
	 * the last one stops it.
	 */
	subscribe(listener: FrameListener, options?: { cadenceMs?: () => number }): () => void {
		if (this.#disposed) return () => {};
		this.#listeners.set(listener, { cadenceMs: options?.cadenceMs });
		this.#sync();
		return () => {
			if (!this.#listeners.delete(listener)) return;
			this.#sync();
		};
	}

	/** Stop the timer, drop all subscribers, and detach from the policy. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#listeners.clear();
		this.#stopTimer();
		this.#unsubscribePolicy?.();
		this.#unsubscribePolicy = undefined;
	}

	/** Reconcile the timer with the current subscriber count and policy tier. */
	#sync(): void {
		if (this.#disposed) return;
		const cadence = this.#policy.cadenceMs;
		const wantTimer = this.#listeners.size > 0 && cadence > 0;
		if (!wantTimer) {
			this.#stopTimer();
			return;
		}
		if (this.#stopTimerFn !== undefined && this.#activeCadenceMs === cadence) {
			// Already running at the right cadence — nothing to reconcile.
			return;
		}
		this.#stopTimer();
		this.#activeCadenceMs = cadence;
		if (this.#startedAt === undefined) {
			this.#startedAt = this.#scheduler.now();
		}
		this.#stopTimerFn = this.#scheduler.start(cadence, () => this.#tick());
	}

	#stopTimer(): void {
		if (this.#stopTimerFn === undefined) return;
		this.#stopTimerFn();
		this.#stopTimerFn = undefined;
		this.#activeCadenceMs = 0;
	}

	#tick(): void {
		// Time-based frame-skip: drop this frame's emission under backpressure, but
		// keep the clock running so the next emitted frame lands at real elapsed
		// time and visuals stay smooth after the skip.
		if (this.#backpressure.underPressure) return;
		this.#frame++;
		const elapsedMs = this.#scheduler.now() - (this.#startedAt ?? this.#scheduler.now());
		// Snapshot so a listener unsubscribing mid-emit cannot skip a sibling.
		let quarantined = false;
		for (const [listener, entry] of [...this.#listeners]) {
			try {
				const cadenceMs = entry.cadenceMs?.();
				if (cadenceMs !== undefined) {
					if (cadenceMs <= 0) continue;
					if (cadenceMs > this.#activeCadenceMs && elapsedMs - (entry.lastEmitAt ?? -Infinity) < cadenceMs) {
						continue;
					}
					entry.lastEmitAt = elapsedMs;
				}
				listener(this.#frame, elapsedMs);
			} catch (err) {
				// Fail-open: one bad renderer must neither stop siblings nor escape
				// the scheduler interval as a process-level uncaught exception.
				this.#listeners.delete(listener);
				quarantined = true;
				logger.error("AnimationHost listener threw; quarantined", {
					frame: this.#frame,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (quarantined) this.#sync();
	}
}
