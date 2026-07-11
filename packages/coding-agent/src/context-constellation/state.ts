import type { ContextUsageLevel } from "../modes/components/status-line/context-thresholds";
import { getContextUsageLevel } from "../modes/components/status-line/context-thresholds";
import { cellsForPercent, clampPercent } from "./sky";

/** A raw context-usage reading, decoupled from the real `ContextUsage` extension type so this module stays independently testable. */
export interface ContextUsageReading {
	readonly percent: number;
	readonly contextWindow: number;
	readonly tokens: number;
}

/** An in-progress (or just-completed) shooting-star sweep, from a pre-compaction cell count down to the freshest post-compaction one. */
export interface SweepSnapshot {
	readonly from: number;
	readonly to: number;
	/** Clock reading (shared `FrameScheduler`) the sweep began at. */
	readonly startedAt: number;
}

/** Immutable snapshot handed to the pure renderer each frame. */
export interface ConstellationSnapshot {
	readonly filledCells: number;
	readonly percent: number;
	readonly contextWindow: number;
	readonly tokens: number;
	readonly level: ContextUsageLevel;
	/** Clock reading the currently-lit star count last grew at, or `undefined` if it never has. Drives the newest-star flare. */
	readonly lastGrowAt: number | undefined;
	/** The most recent sweep, or `undefined` if none has happened yet. Never cleared — the renderer decides staleness from elapsed time. */
	readonly sweep: SweepSnapshot | undefined;
}

/**
 * Mutable, session-scoped model of the context-fill star field.
 * `applyContextUsage` re-derives the lit-cell count from a fresh
 * `ContextUsage` reading (polled on the `context` event, and again
 * immediately after `auto_compaction_end` for a fast post-compaction
 * refresh); `beginSweep` stamps the pre-compaction cell count on
 * `auto_compaction_start` so the renderer can wipe from that count down to
 * whatever the next reading reports. Rendering reads an immutable
 * {@link snapshot} and is a pure function of that snapshot plus the caller's
 * clock reading.
 */
export class ConstellationState {
	#filledCells = 0;
	#percent = 0;
	#contextWindow = 0;
	#tokens = 0;
	#level: ContextUsageLevel = "normal";
	#lastGrowAt: number | undefined;
	#sweep: SweepSnapshot | undefined;

	/** Re-derive the lit-cell count from a fresh usage reading at `elapsedMs` (the shared clock). */
	applyContextUsage(usage: ContextUsageReading, elapsedMs: number): void {
		const percent = clampPercent(usage.percent);
		const filled = cellsForPercent(percent);

		if (filled > this.#filledCells) {
			this.#lastGrowAt = elapsedMs;
		}
		if (this.#sweep && filled < this.#filledCells) {
			// A sweep is in progress: keep its target tracking the freshest post-compaction reading.
			this.#sweep = { ...this.#sweep, to: filled };
		}

		this.#filledCells = filled;
		this.#percent = percent;
		this.#contextWindow = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : 0;
		this.#tokens = Number.isFinite(usage.tokens) && usage.tokens > 0 ? usage.tokens : 0;
		this.#level = getContextUsageLevel(percent, this.#contextWindow);
	}

	/** Stamp the pre-compaction cell count as a sweep's starting point at `elapsedMs`, called on `auto_compaction_start`. */
	beginSweep(elapsedMs: number): void {
		this.#sweep = { from: this.#filledCells, to: this.#filledCells, startedAt: elapsedMs };
	}

	/** Immutable view for the pure renderer. */
	snapshot(): ConstellationSnapshot {
		return {
			filledCells: this.#filledCells,
			percent: this.#percent,
			contextWindow: this.#contextWindow,
			tokens: this.#tokens,
			level: this.#level,
			lastGrowAt: this.#lastGrowAt,
			sweep: this.#sweep,
		};
	}
}
