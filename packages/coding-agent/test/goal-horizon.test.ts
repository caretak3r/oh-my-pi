import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { GoalUpdatedEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { type GoalHorizonContext, GoalHorizonController } from "@oh-my-pi/pi-coding-agent/goal-horizon/controller";
import {
	FLARE_DECAY_MS,
	filledColumnCount,
	flareGlyph,
	flareIntensity,
	goalFraction,
	HORIZON_BAR_WIDTH,
	horizonBucket,
	indeterminatePulse,
	MILESTONE_FRACTIONS,
	milestoneColumn,
	milestonesCrossed,
	nearestCrossedMilestone,
} from "@oh-my-pi/pi-coding-agent/goal-horizon/horizon";
import { GoalHorizonState } from "@oh-my-pi/pi-coding-agent/goal-horizon/state";
import {
	type GoalHorizonTheme,
	GoalHorizonWidget,
	renderGoalHorizonOffText,
	renderGoalHorizonRow,
	renderHorizonBar,
} from "@oh-my-pi/pi-coding-agent/goal-horizon/widget";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: GoalHorizonTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color token the renderer chose.
const taggedTheme: GoalHorizonTheme = { fg: (color, text) => `${color}:${text}` };

/** Manual frame scheduler: drives host ticks deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "ship the thing",
		status: "active",
		tokenBudget: 1000,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function goalUpdated(goal: Goal | null): GoalUpdatedEvent {
	return { type: "goal_updated", goal };
}

describe("goal horizon pure math", () => {
	it("goalFraction is undefined with no/invalid tokenBudget, and clamps [0, 1] otherwise", () => {
		expect(goalFraction(500, undefined)).toBeUndefined();
		expect(goalFraction(500, 0)).toBeUndefined();
		expect(goalFraction(500, -10)).toBeUndefined();
		expect(goalFraction(0, 1000)).toBe(0);
		expect(goalFraction(-5, 1000)).toBe(0);
		expect(goalFraction(500, 1000)).toBe(0.5);
		expect(goalFraction(1000, 1000)).toBe(1);
		expect(goalFraction(5000, 1000)).toBe(1); // over budget clamps at 1
	});

	it("milestonesCrossed counts thresholds reached, monotonic in fraction", () => {
		expect(milestonesCrossed(0)).toBe(0);
		expect(milestonesCrossed(0.1)).toBe(0);
		expect(milestonesCrossed(0.25)).toBe(1);
		expect(milestonesCrossed(0.5)).toBe(2);
		expect(milestonesCrossed(0.75)).toBe(3);
		expect(milestonesCrossed(1)).toBe(4);
		expect(milestonesCrossed(1)).toBe(MILESTONE_FRACTIONS.length);
	});

	it("nearestCrossedMilestone returns the largest threshold at or below fraction, or undefined below the first", () => {
		expect(nearestCrossedMilestone(0.1)).toBeUndefined();
		expect(nearestCrossedMilestone(0.25)).toBe(0.25);
		expect(nearestCrossedMilestone(0.6)).toBe(0.5);
		expect(nearestCrossedMilestone(1)).toBe(1);
	});

	it("flareIntensity decays linearly to 0 by FLARE_DECAY_MS and stays 0 for a non-positive peak", () => {
		expect(flareIntensity(0, 0)).toBe(0);
		expect(flareIntensity(1, 0)).toBe(1);
		expect(flareIntensity(1, FLARE_DECAY_MS / 2)).toBeCloseTo(0.5, 5);
		expect(flareIntensity(1, FLARE_DECAY_MS)).toBe(0);
		expect(flareIntensity(1, FLARE_DECAY_MS * 10)).toBe(0);
		expect(flareIntensity(1, -100)).toBe(1); // clamps negative elapsed to "just happened"
	});

	it("horizonBucket classifies bar position from dim predawn to hot zenith, monotonic", () => {
		expect(horizonBucket(0)).toBe("predawn");
		expect(horizonBucket(0.1)).toBe("dawn");
		expect(horizonBucket(0.25)).toBe("dawn");
		expect(horizonBucket(0.4)).toBe("morning");
		expect(horizonBucket(0.6)).toBe("noon");
		expect(horizonBucket(0.9)).toBe("zenith");
		expect(horizonBucket(1)).toBe("zenith");
	});

	it("milestoneColumn maps a fraction onto a bar column within bounds", () => {
		expect(milestoneColumn(0.25, HORIZON_BAR_WIDTH)).toBeGreaterThanOrEqual(0);
		expect(milestoneColumn(0.25, HORIZON_BAR_WIDTH)).toBeLessThan(HORIZON_BAR_WIDTH);
		expect(milestoneColumn(1, HORIZON_BAR_WIDTH)).toBe(HORIZON_BAR_WIDTH - 1);
		expect(milestoneColumn(0.5, 0)).toBe(0); // zero-width bar doesn't throw
	});

	it("flareGlyph and filledColumnCount are monotonic along their ramps", () => {
		const glyphs = [0, 0.3, 0.6, 0.9].map(flareGlyph);
		expect(new Set(glyphs).size).toBeGreaterThan(1);

		expect(filledColumnCount(0, HORIZON_BAR_WIDTH)).toBe(0);
		expect(filledColumnCount(0.5, HORIZON_BAR_WIDTH)).toBe(HORIZON_BAR_WIDTH / 2);
		expect(filledColumnCount(1, HORIZON_BAR_WIDTH)).toBe(HORIZON_BAR_WIDTH);
		expect(filledColumnCount(0.5, 0)).toBe(0);
	});

	it("indeterminatePulse is deterministic, periodic, and stays within [0, 1]", () => {
		expect(indeterminatePulse(100)).toBe(indeterminatePulse(100));
		const samples = Array.from({ length: 20 }, (_, i) => indeterminatePulse(i * 100));
		for (const s of samples) {
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(1);
		}
		expect(new Set(samples).size).toBeGreaterThan(1); // actually pulses, not flat
	});
});

describe("goal horizon state", () => {
	it("applyGoal(null, ...) clears to no-goal", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 500 }), 0);
		expect(state.snapshot().hasGoal).toBe(true);

		state.applyGoal(null, 0);
		const snapshot = state.snapshot();
		expect(snapshot.hasGoal).toBe(false);
		expect(snapshot.objective).toBe("");
		expect(snapshot.fraction).toBeUndefined();
		expect(snapshot.tokensUsed).toBe(0);
	});

	it("tracks objective/status/tokensUsed/tokenBudget off the latest goal", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ objective: "write tests", status: "active", tokensUsed: 200, tokenBudget: 800 }), 0);
		const snapshot = state.snapshot();
		expect(snapshot.hasGoal).toBe(true);
		expect(snapshot.objective).toBe("write tests");
		expect(snapshot.status).toBe("active");
		expect(snapshot.tokensUsed).toBe(200);
		expect(snapshot.tokenBudget).toBe(800);
		expect(snapshot.fraction).toBe(0.25);
	});

	it("does not flare on the initial application of a freshly created goal, even if it starts past a milestone", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 900, tokenBudget: 1000 }), 500);
		expect(state.snapshot().lastFlareAt).toBeUndefined();
		expect(state.snapshot().lastFlarePeakIntensity).toBe(0);
	});

	it("flares exactly once when an update on the same goal crosses a new milestone", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 0, tokenBudget: 1000 }), 0);
		state.applyGoal(makeGoal({ tokensUsed: 300, tokenBudget: 1000 }), 100); // crosses 0.25
		expect(state.snapshot().lastFlareAt).toBe(100);
		expect(state.snapshot().lastFlarePeakIntensity).toBe(1);

		// A further update within the same milestone band does not re-flare.
		state.applyGoal(makeGoal({ tokensUsed: 400, tokenBudget: 1000 }), 200);
		expect(state.snapshot().lastFlareAt).toBe(100);

		// Crossing the next milestone flares again, at the new timestamp.
		state.applyGoal(makeGoal({ tokensUsed: 600, tokenBudget: 1000 }), 300); // crosses 0.5
		expect(state.snapshot().lastFlareAt).toBe(300);
	});

	it("a new goal id resets milestone tracking without flaring, even if the old goal had crossed milestones", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ id: "goal-1", tokensUsed: 900, tokenBudget: 1000 }), 0);
		state.applyGoal(makeGoal({ id: "goal-1", tokensUsed: 1000, tokenBudget: 1000 }), 50); // crosses 1.0 -> flares
		expect(state.snapshot().lastFlareAt).toBe(50);

		state.applyGoal(makeGoal({ id: "goal-2", tokensUsed: 100, tokenBudget: 1000 }), 100);
		expect(state.snapshot().objective).toBe("ship the thing");
		expect(state.snapshot().lastFlareAt).toBe(50); // unchanged: the new goal's first application never flares
		state.applyGoal(makeGoal({ id: "goal-2", tokensUsed: 300, tokenBudget: 1000 }), 150); // crosses 0.25 on goal-2
		expect(state.snapshot().lastFlareAt).toBe(150);
	});

	it("fraction is undefined for an unbounded goal (no tokenBudget)", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 5000, tokenBudget: undefined }), 0);
		expect(state.snapshot().fraction).toBeUndefined();
		expect(state.snapshot().tokensUsed).toBe(5000);
	});
});

describe("goal horizon rendering (byte-stable)", () => {
	it("renderHorizonBar fills columns left-to-right with the sunrise gradient, monotonic in fraction", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 400, tokenBudget: 1000 }), 0);
		const snapshot = state.snapshot();
		const row = renderHorizonBar(snapshot.fraction as number, 100000, snapshot, idTheme);
		expect([...row]).toHaveLength(HORIZON_BAR_WIDTH);
		const filledCount = [...row].filter(ch => ch === "█").length;
		expect(filledCount).toBe(8); // 0.4 * 20

		const fuller = new GoalHorizonState();
		fuller.applyGoal(makeGoal({ tokensUsed: 900, tokenBudget: 1000 }), 0);
		const fullerSnapshot = fuller.snapshot();
		const fullerRow = renderHorizonBar(fullerSnapshot.fraction as number, 100000, fullerSnapshot, idTheme);
		const fullerFilledCount = [...fullerRow].filter(ch => ch === "█").length;
		expect(fullerFilledCount).toBeGreaterThan(filledCount);
	});

	it("colors warm toward the fill edge and stays dim past it", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 950, tokenBudget: 1000 }), 0);
		const snapshot = state.snapshot();
		const row = renderHorizonBar(snapshot.fraction as number, 100000, snapshot, taggedTheme);
		expect(row).toContain("warning:"); // near-zenith filled cells
		expect(row).toContain("dim:"); // unfilled tail past 95%
	});

	it("a fresh milestone flare overlays a bright glyph that fades with elapsed time", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 0, tokenBudget: 1000 }), 0);
		state.applyGoal(makeGoal({ tokensUsed: 300, tokenBudget: 1000 }), 0); // crosses 0.25 at clock 0
		const snapshot = state.snapshot();

		const fresh = renderHorizonBar(snapshot.fraction as number, 0, snapshot, idTheme);
		const decayed = renderHorizonBar(snapshot.fraction as number, FLARE_DECAY_MS * 10, snapshot, idTheme);
		expect(fresh).not.toBe(decayed); // flare glyph fades out of the row
	});

	it("renderGoalHorizonRow reports 'no active goal' before any goal", () => {
		const state = new GoalHorizonState();
		expect(renderGoalHorizonRow(state.snapshot(), 0, idTheme, "full")).toBe("no active goal");
	});

	it("renderGoalHorizonRow falls back to the indeterminate pulse for an unbounded goal", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ objective: "explore", tokensUsed: 1234, tokenBudget: undefined }), 0);
		const full = renderGoalHorizonRow(state.snapshot(), 0, idTheme, "full");
		expect(full).toContain("1234 tok");
		expect(full).toContain("no budget");
		expect(full).toContain("explore");
	});

	it("subtle tier collapses to a single dominant glyph and the percentage", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ objective: "long objective text here", tokensUsed: 700, tokenBudget: 1000 }), 0);
		const subtle = renderGoalHorizonRow(state.snapshot(), 0, idTheme, "subtle");
		expect(subtle).not.toContain("long objective text here");
		expect(subtle).toContain("70%");
	});

	it("off-tier text reports 'no active goal' before any goal, then objective/percent/tokens once tracking", () => {
		const state = new GoalHorizonState();
		expect(renderGoalHorizonOffText(state.snapshot())).toBe("no active goal");

		state.applyGoal(makeGoal({ objective: "ship it", tokensUsed: 250, tokenBudget: 1000 }), 0);
		expect(renderGoalHorizonOffText(state.snapshot())).toBe("🌅 ship it 25% (250/1000 tok)");
	});

	it("off-tier text reports the unbounded form when there is no tokenBudget", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ objective: "explore", tokensUsed: 500, tokenBudget: undefined }), 0);
		expect(renderGoalHorizonOffText(state.snapshot())).toBe("🌅 explore — 500 tok (no budget)");
	});
});

describe("GoalHorizonWidget", () => {
	it("renders a frame, tracks the injected clock, and disposes with zero leaked subscriptions", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 100, tokenBudget: 1000 }), 0);
		const widget = new GoalHorizonWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		const initial = widget.render(80);
		state.applyGoal(makeGoal({ tokensUsed: 300, tokenBudget: 1000 }), 50); // crosses 0.25 -> flares
		scheduler.advance(50);
		const next = widget.render(80);
		expect(next).not.toEqual(initial);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 100, tokenBudget: 1000 }), 0);
		const widget = new GoalHorizonWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).not.toBe("");
	});
});

describe("goal horizon controller", () => {
	function recordingContext(overrides: Partial<GoalHorizonContext> = {}): {
		ctx: GoalHorizonContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: GoalHorizonContext = {
			hasUI: true,
			isTTY: true,
			env: {},
			motionSetting: "full",
			theme: idTheme,
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	it("mounts an animated widget on the first goal_updated event and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new GoalHorizonController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onGoalUpdated(goalUpdated(makeGoal({ tokensUsed: 100 })), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: GoalHorizonTheme) => GoalHorizonWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onGoalUpdated(goalUpdated(makeGoal({ tokensUsed: 200 })), ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().tokensUsed).toBe(200);
	});

	it("renders and updates a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new GoalHorizonController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onGoalUpdated(
			goalUpdated(makeGoal({ objective: "ship it", tokensUsed: 250, tokenBudget: 1000 })),
			ctx,
		);
		expect((calls[0].content as string[])[0]).toBe("🌅 ship it 25% (250/1000 tok)");
		expect(scheduler.running).toBe(false);

		controller.onGoalUpdated(
			goalUpdated(makeGoal({ objective: "ship it", tokensUsed: 500, tokenBudget: 1000 })),
			ctx,
		);
		expect((calls[calls.length - 1].content as string[])[0]).toBe("🌅 ship it 50% (500/1000 tok)");
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new GoalHorizonController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onGoalUpdated(goalUpdated(makeGoal()), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new GoalHorizonController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onGoalUpdated(goalUpdated(makeGoal()), ctx);
		expect(calls).toHaveLength(0);
	});

	it("a goal_updated(null) after mounting clears state to no-goal but keeps the widget mounted", () => {
		const controller = new GoalHorizonController();
		const { ctx, calls } = recordingContext();

		controller.onGoalUpdated(goalUpdated(makeGoal()), ctx);
		expect(calls).toHaveLength(1);
		controller.onGoalUpdated(goalUpdated(null), ctx);
		expect(calls).toHaveLength(1); // still no remount in animated mode
		expect(controller.state.snapshot().hasGoal).toBe(false);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new GoalHorizonController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onGoalUpdated(goalUpdated(makeGoal()), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: GoalHorizonTheme) => GoalHorizonWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
