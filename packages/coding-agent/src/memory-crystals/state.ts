import { crystalMagnitude } from "./crystal";

/** One crystallized compaction, resting in the tray. */
export interface CrystalSnapshot {
	readonly id: number;
	readonly tokensBefore: number;
	readonly magnitude: number;
	readonly summary: string;
	readonly action: string;
	/** Clock reading (shared `FrameScheduler`) this crystal spawned at — NOT a wall-clock timestamp. */
	readonly spawnedAt: number;
}

/** Immutable snapshot handed to the pure renderer each frame. */
export interface MemoryCrystalsSnapshot {
	/** Crystals currently displayed in the tray, oldest first, capped at `MAX_DISPLAYED_CRYSTALS`. */
	readonly crystals: readonly CrystalSnapshot[];
	/** Crystals spawned this session but pruned out of the displayed tray. */
	readonly hiddenCount: number;
	/** Total crystals spawned this session (displayed + hidden). */
	readonly totalCrystals: number;
	readonly totalTokensReclaimed: number;
}

/** Maximum crystals shown in the tray at once, mirroring Session Bonsai's `MAX_DISPLAYED_LEAVES`/Todo Meteors' `MAX_EMBERS_SHOWN` pruning pattern. */
const MAX_DISPLAYED_CRYSTALS = 10;

/**
 * Mutable, session-scoped model of the crystal tray. `applyCompactionEnd` is
 * called once per successful `auto_compaction_end` (a defined `result` —
 * see the controller's re-grounding note) and appends one crystal, stamped
 * against the caller's injected clock so the whole model stays deterministic
 * and snapshot-testable. Past `MAX_DISPLAYED_CRYSTALS`, the oldest displayed
 * crystals drop off the tray (never a silent data loss — `hiddenCount`
 * reports what's no longer shown) while the running totals keep counting
 * every crystal ever spawned.
 */
export class MemoryCrystalsState {
	#crystals: CrystalSnapshot[] = [];
	#nextId = 0;
	#totalCrystals = 0;
	#totalTokensReclaimed = 0;

	/** Record one successful compaction's crystal, stamped at `elapsedMs` (the shared clock). */
	applyCompactionEnd(tokensBefore: number, summary: string, action: string, elapsedMs: number): void {
		const safeTokens = Number.isFinite(tokensBefore) && tokensBefore > 0 ? tokensBefore : 0;
		const crystal: CrystalSnapshot = {
			id: this.#nextId++,
			tokensBefore: safeTokens,
			magnitude: crystalMagnitude(safeTokens),
			summary,
			action,
			spawnedAt: elapsedMs,
		};
		this.#totalCrystals += 1;
		this.#totalTokensReclaimed += safeTokens;
		this.#crystals.push(crystal);
		if (this.#crystals.length > MAX_DISPLAYED_CRYSTALS) {
			this.#crystals = this.#crystals.slice(this.#crystals.length - MAX_DISPLAYED_CRYSTALS);
		}
	}

	/** Immutable view for the pure renderer. */
	snapshot(): MemoryCrystalsSnapshot {
		return {
			crystals: this.#crystals,
			hiddenCount: Math.max(0, this.#totalCrystals - this.#crystals.length),
			totalCrystals: this.#totalCrystals,
			totalTokensReclaimed: this.#totalTokensReclaimed,
		};
	}
}
