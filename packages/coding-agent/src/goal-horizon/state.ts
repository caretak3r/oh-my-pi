import type { Goal, GoalStatus } from "../goals/state";
import { goalFraction, milestonesCrossed } from "./horizon";

/** Immutable snapshot handed to the pure renderer each frame. */
export interface GoalHorizonSnapshot {
	/** Whether a `/goal` is currently tracked (survives status transitions; only `false` once the runtime commits `goal: null`). */
	readonly hasGoal: boolean;
	readonly objective: string;
	readonly status: GoalStatus | undefined;
	/** `[0, 1]` consumption fraction, or `undefined` when the goal has no `tokenBudget` (unbounded). */
	readonly fraction: number | undefined;
	readonly tokensUsed: number;
	readonly tokenBudget: number | undefined;
	/** Clock reading (shared `FrameScheduler`) the most recent milestone flare was stamped at; `undefined` if none yet this goal. */
	readonly lastFlareAt: number | undefined;
	/** Flare peak intensity (always `1` when set) the last crossing stamped; `0` before any flare. */
	readonly lastFlarePeakIntensity: number;
}

/**
 * Mutable, session-scoped model of the active goal's consumption. All
 * timestamps come from the caller's injected clock (never `Date.now`/
 * `performance.now` read directly here), so the whole state machine is
 * deterministic and snapshot-testable. Milestone crossings are detected by
 * comparing this event's crossed-count against the last one recorded for
 * the *same* goal id — a fresh goal (a new `id`) initializes its crossed
 * count silently, without retroactively flaring for whatever fraction it
 * starts at.
 */
export class GoalHorizonState {
	#goalId: string | undefined;
	#hasGoal = false;
	#objective = "";
	#status: GoalStatus | undefined;
	#tokensUsed = 0;
	#tokenBudget: number | undefined;
	#milestonesCrossedCount = 0;
	#lastFlareAt: number | undefined;
	#lastFlarePeakIntensity = 0;

	/** Apply one `goal_updated` event's payload, stamped at `now` (the shared clock). `goal: null` means the runtime has no accounting state left (dropped/cleared). */
	applyGoal(goal: Goal | null, now: number): void {
		if (goal === null) {
			this.#goalId = undefined;
			this.#hasGoal = false;
			this.#objective = "";
			this.#status = undefined;
			this.#tokensUsed = 0;
			this.#tokenBudget = undefined;
			this.#milestonesCrossedCount = 0;
			return;
		}

		const isNewGoal = this.#goalId !== goal.id;
		this.#goalId = goal.id;
		this.#hasGoal = true;
		this.#objective = goal.objective;
		this.#status = goal.status;
		this.#tokensUsed = goal.tokensUsed;
		this.#tokenBudget = goal.tokenBudget;

		const fraction = goalFraction(goal.tokensUsed, goal.tokenBudget);
		const crossed = fraction === undefined ? 0 : milestonesCrossed(fraction);
		if (!isNewGoal && crossed > this.#milestonesCrossedCount) {
			this.#lastFlarePeakIntensity = 1;
			this.#lastFlareAt = now;
		}
		this.#milestonesCrossedCount = crossed;
	}

	/** Immutable view for the pure renderer. */
	snapshot(): GoalHorizonSnapshot {
		return {
			hasGoal: this.#hasGoal,
			objective: this.#objective,
			status: this.#status,
			fraction: goalFraction(this.#tokensUsed, this.#tokenBudget),
			tokensUsed: this.#tokensUsed,
			tokenBudget: this.#tokenBudget,
			lastFlareAt: this.#lastFlareAt,
			lastFlarePeakIntensity: this.#lastFlarePeakIntensity,
		};
	}
}
