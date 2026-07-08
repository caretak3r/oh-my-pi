import { gutterIntensity } from "./candle";

/** Immutable snapshot handed to the pure renderer each frame. */
export interface CostCandleSnapshot {
	readonly totalCostUsd: number;
	readonly messageCount: number;
	readonly lastMessageCostUsd: number;
	readonly averageMessageCostUsd: number;
	/** Gutter intensity (`0..1`, pre-decay) the last recorded message produced; `0` if no message yet. */
	readonly lastGutterPeakIntensity: number;
	/** Clock reading (shared `FrameScheduler`) the last message was recorded at; `undefined` if no message yet. */
	readonly lastMessageAt: number | undefined;
}

/**
 * Mutable, session-scoped model of accumulated spend: every recorded
 * assistant message's `usage.cost.total` (already a settled USD figure, see
 * `packages/catalog/src/types.ts`'s `Usage.cost`) both burns the candle's wax
 * down and stamps a decaying flame-gutter disturbance keyed off that
 * message's cost, per {@link gutterIntensity}. `lastMessageAt` is a clock
 * reading, not a wall-clock timestamp — the renderer combines it with the
 * same clock's later readings to compute gutter decay, matching every other
 * Wave 2 feature's dual-clock-seam pattern.
 */
export class CostCandleState {
	#totalCostUsd = 0;
	#messageCount = 0;
	#lastMessageCostUsd = 0;
	#lastGutterPeakIntensity = 0;
	#lastMessageAt: number | undefined;

	/** Record one assistant message's already-settled USD cost, stamped at `elapsedMs` (the shared clock). Negative/non-finite costs are ignored (no such message should exist, but this keeps the model well-defined). Returns whether anything changed. */
	recordMessageCost(costUsd: number, elapsedMs: number): boolean {
		if (!Number.isFinite(costUsd) || costUsd < 0) return false;
		this.#totalCostUsd += costUsd;
		this.#messageCount += 1;
		this.#lastMessageCostUsd = costUsd;
		this.#lastGutterPeakIntensity = gutterIntensity(costUsd);
		this.#lastMessageAt = elapsedMs;
		return true;
	}

	/** Immutable view for the pure renderer. */
	snapshot(): CostCandleSnapshot {
		return {
			totalCostUsd: this.#totalCostUsd,
			messageCount: this.#messageCount,
			lastMessageCostUsd: this.#lastMessageCostUsd,
			averageMessageCostUsd: this.#messageCount > 0 ? this.#totalCostUsd / this.#messageCount : 0,
			lastGutterPeakIntensity: this.#lastGutterPeakIntensity,
			lastMessageAt: this.#lastMessageAt,
		};
	}
}
