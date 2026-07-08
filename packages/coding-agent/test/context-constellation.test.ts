import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import {
	type ContextConstellationContext,
	ContextConstellationController,
} from "@oh-my-pi/pi-coding-agent/context-constellation/controller";
import {
	buildFillOrder,
	COMET_GLYPH,
	cellsForPercent,
	clampPercent,
	FILL_ORDER,
	GRID_CELLS,
	GROW_FLARE_MS,
	growFlareIntensity,
	invertFillOrder,
	lerpCells,
	RANK_OF_CELL,
	SWEEP_DURATION_MS,
	sweepProgress,
} from "@oh-my-pi/pi-coding-agent/context-constellation/sky";
import type { ContextUsageReading } from "@oh-my-pi/pi-coding-agent/context-constellation/state";
import { ConstellationState } from "@oh-my-pi/pi-coding-agent/context-constellation/state";
import {
	type ConstellationTheme,
	ContextConstellationWidget,
	displayedFilledCells,
	renderConstellationGrid,
	renderConstellationOffText,
} from "@oh-my-pi/pi-coding-agent/context-constellation/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: ConstellationTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: ConstellationTheme = { fg: (color, text) => `${color}:${text}` };

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

function usage(percent: number, contextWindow = 100_000, tokens?: number): ContextUsageReading {
	return { percent, contextWindow, tokens: tokens ?? Math.round((percent / 100) * contextWindow) };
}

describe("context constellation math (pure)", () => {
	it("clampPercent clamps into [0, 100] and treats non-finite input as 0", () => {
		expect(clampPercent(-5)).toBe(0);
		expect(clampPercent(0)).toBe(0);
		expect(clampPercent(42)).toBe(42);
		expect(clampPercent(150)).toBe(100);
		expect(clampPercent(Number.NaN)).toBe(0);
		expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("cellsForPercent is monotonic and spans the full grid at the extremes", () => {
		expect(cellsForPercent(0)).toBe(0);
		expect(cellsForPercent(100)).toBe(GRID_CELLS);
		expect(cellsForPercent(50)).toBe(GRID_CELLS / 2);
		expect(cellsForPercent(5)).toBe(1); // 5% grid: one cell per 5%
		let previous = -1;
		for (let p = 0; p <= 100; p += 5) {
			const cells = cellsForPercent(p);
			expect(cells).toBeGreaterThanOrEqual(previous);
			previous = cells;
		}
	});

	it("FILL_ORDER is a permutation of every grid cell, and RANK_OF_CELL is its exact inverse", () => {
		expect(new Set(FILL_ORDER).size).toBe(GRID_CELLS);
		expect([...FILL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: GRID_CELLS }, (_, i) => i));
		FILL_ORDER.forEach((cellIndex, rank) => {
			expect(RANK_OF_CELL[cellIndex]).toBe(rank);
		});
		expect(invertFillOrder(FILL_ORDER)).toEqual(RANK_OF_CELL as number[]);
	});

	it("FILL_ORDER is deterministic across repeated builds (byte-stable scatter)", () => {
		expect(buildFillOrder(GRID_CELLS)).toEqual(FILL_ORDER as number[]);
	});

	it("sweepProgress is 0 at start, monotonic, and clamps to 1 by durationMs", () => {
		expect(sweepProgress(0)).toBe(0);
		expect(sweepProgress(SWEEP_DURATION_MS)).toBe(1);
		expect(sweepProgress(SWEEP_DURATION_MS * 10)).toBe(1);
		let previous = -1;
		for (let t = 0; t <= SWEEP_DURATION_MS; t += 50) {
			const progress = sweepProgress(t);
			expect(progress).toBeGreaterThanOrEqual(previous);
			previous = progress;
		}
	});

	it("lerpCells interpolates and rounds, clamping progress into [0, 1]", () => {
		expect(lerpCells(20, 4, 0)).toBe(20);
		expect(lerpCells(20, 4, 1)).toBe(4);
		expect(lerpCells(20, 4, 0.5)).toBe(12);
		expect(lerpCells(20, 4, -1)).toBe(20);
		expect(lerpCells(20, 4, 2)).toBe(4);
	});

	it("growFlareIntensity is born at full brightness and decays to 0 by durationMs", () => {
		expect(growFlareIntensity(0)).toBe(1);
		expect(growFlareIntensity(GROW_FLARE_MS / 2)).toBeCloseTo(0.5, 5);
		expect(growFlareIntensity(GROW_FLARE_MS)).toBe(0);
		expect(growFlareIntensity(GROW_FLARE_MS * 10)).toBe(0);
		expect(growFlareIntensity(-50)).toBe(1);
	});
});

describe("context constellation state", () => {
	it("re-derives filledCells/percent/level from each applied usage reading", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(0), 0);
		expect(state.snapshot()).toMatchObject({ filledCells: 0, percent: 0, level: "normal" });

		state.applyContextUsage(usage(55), 100);
		const snap = state.snapshot();
		expect(snap.filledCells).toBe(cellsForPercent(55));
		expect(snap.level).toBe("warning");
		expect(snap.lastGrowAt).toBe(100);
	});

	it("stamps lastGrowAt only when the lit-cell count actually increases", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(20), 0);
		expect(state.snapshot().lastGrowAt).toBe(0);
		state.applyContextUsage(usage(20), 500); // same percent -> same cell count -> no regrow
		expect(state.snapshot().lastGrowAt).toBe(0);
		state.applyContextUsage(usage(40), 900);
		expect(state.snapshot().lastGrowAt).toBe(900);
	});

	it("beginSweep captures the pre-compaction cell count; a later lower reading updates the sweep's target", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(80), 0);
		const before = state.snapshot().filledCells;
		state.beginSweep(1000);
		expect(state.snapshot().sweep).toEqual({ from: before, to: before, startedAt: 1000 });

		state.applyContextUsage(usage(20), 1050);
		const snap = state.snapshot();
		expect(snap.filledCells).toBe(cellsForPercent(20));
		expect(snap.sweep).toEqual({ from: before, to: cellsForPercent(20), startedAt: 1000 });
	});

	it("a sweep whose post-compaction reading is unchanged (aborted/skipped) leaves from === to", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(60), 0);
		const before = state.snapshot().filledCells;
		state.beginSweep(200);
		state.applyContextUsage(usage(60), 250); // unchanged: nothing was actually reclaimed
		expect(state.snapshot().sweep).toEqual({ from: before, to: before, startedAt: 200 });
	});

	it("treats a non-finite/zero contextWindow as unknown (0) rather than throwing", () => {
		const state = new ConstellationState();
		state.applyContextUsage({ percent: 10, contextWindow: Number.NaN, tokens: -5 }, 0);
		const snap = state.snapshot();
		expect(snap.contextWindow).toBe(0);
		expect(snap.tokens).toBe(0);
	});
});

describe("context constellation rendering (byte-stable)", () => {
	it("lights exactly as many cells as filledCells and dims the rest", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(25), 0); // 5 of 20 cells
		const grid = renderConstellationGrid(state.snapshot(), 10_000, idTheme, "subtle");
		const joined = grid.join(" ");
		const stars = [...joined].filter(ch => ch === "✦").length;
		const dots = [...joined].filter(ch => ch === "·").length;
		expect(stars).toBe(5);
		expect(dots).toBe(GRID_CELLS - 5);
	});

	it("colors stars by the usage level, reusing the shared context-threshold color mapping", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(10), 0);
		const normalGrid = renderConstellationGrid(state.snapshot(), 0, taggedTheme, "subtle").join(" ");
		expect(normalGrid).toContain("statusLineContext:");

		state.applyContextUsage(usage(95), 0);
		const errorGrid = renderConstellationGrid(state.snapshot(), 0, taggedTheme, "subtle").join(" ");
		expect(errorGrid).toContain("error:");
	});

	it("full tier flares the newest-lit star briefly after it grows in", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(20), 0); // grows at t=0
		const fresh = renderConstellationGrid(state.snapshot(), 0, taggedTheme, "full").join(" ");
		const settled = renderConstellationGrid(state.snapshot(), GROW_FLARE_MS * 2, taggedTheme, "full").join(" ");
		expect(fresh).toContain("✹");
		expect(settled).not.toContain("✹");
	});

	it("subtle tier never flares or shows a comet, even mid-sweep", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(80), 0);
		state.beginSweep(0);
		state.applyContextUsage(usage(20), 0);
		const row = renderConstellationGrid(state.snapshot(), 100, idTheme, "subtle").join(" ");
		expect(row).not.toContain(COMET_GLYPH);
		expect(row).not.toContain("✹");
	});

	it("full tier shows a comet at the sweep's live wipe boundary, which settles once the sweep completes", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(80), 0);
		const before = state.snapshot().filledCells;
		state.beginSweep(0);
		state.applyContextUsage(usage(20), 0);
		const after = state.snapshot().filledCells;

		const midSweep = renderConstellationGrid(state.snapshot(), SWEEP_DURATION_MS / 2, idTheme, "full").join(" ");
		expect(midSweep).toContain(COMET_GLYPH);
		expect(displayedFilledCells(state.snapshot(), SWEEP_DURATION_MS / 2)).toBeGreaterThan(after);
		expect(displayedFilledCells(state.snapshot(), SWEEP_DURATION_MS / 2)).toBeLessThan(before);

		const doneSweep = renderConstellationGrid(state.snapshot(), SWEEP_DURATION_MS * 2, idTheme, "full").join(" ");
		expect(doneSweep).not.toContain(COMET_GLYPH);
		expect(displayedFilledCells(state.snapshot(), SWEEP_DURATION_MS * 2)).toBe(after);
	});

	it("is deterministic: same snapshot and elapsedMs always render identically", () => {
		const state = new ConstellationState();
		state.applyContextUsage(usage(37), 0);
		const a = renderConstellationGrid(state.snapshot(), 200, idTheme, "full");
		const b = renderConstellationGrid(state.snapshot(), 200, idTheme, "full");
		expect(a).toEqual(b);
	});

	it("off-tier text reports empty before any reading, then a percent/window readout afterward", () => {
		const state = new ConstellationState();
		expect(renderConstellationOffText(state.snapshot())).toBe("✦ context empty");
		state.applyContextUsage(usage(42, 128_000), 0);
		expect(renderConstellationOffText(state.snapshot())).toBe("✦ 42.0%/128K");
	});
});

describe("context constellation widget lifecycle", () => {
	it("renders a frame, tracks the injected clock, and disposes with zero leaked subscriptions", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.applyContextUsage(usage(20), 0);
		const widget = new ContextConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: taggedTheme,
			clock: scheduler,
		});

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		const initial = widget.render(80);
		scheduler.advance(GROW_FLARE_MS + 50);
		const next = widget.render(80);
		expect(next).not.toEqual(initial); // grow flare decayed

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame per row and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.applyContextUsage(usage(20), 0);
		const widget = new ContextConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80).length).toBeGreaterThan(0);
	});
});

describe("context constellation controller", () => {
	function recordingContext(overrides: Partial<ContextConstellationContext> = {}): {
		ctx: ContextConstellationContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: ContextConstellationContext = {
			hasUI: true,
			isTTY: true,
			env: {},
			motionSetting: "full",
			theme: idTheme,
			getContextUsage: () => usage(30),
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	it("mounts an animated widget on the first defined usage reading and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new ContextConstellationController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onContext(ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (
			tui: typeof noopTui,
			theme: ConstellationTheme,
		) => ContextConstellationWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onContext({ ...ctx, getContextUsage: () => usage(50) });
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().percent).toBe(50);
	});

	it("stays dormant on 'context' events until a defined usage reading arrives", () => {
		const controller = new ContextConstellationController();
		const { ctx, calls } = recordingContext({ getContextUsage: () => undefined });

		controller.onContext(ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().percent).toBe(0);
	});

	it("stages a sweep on auto_compaction_start and resolves its target on auto_compaction_end without waiting on 'context'", () => {
		const scheduler = manualScheduler();
		const controller = new ContextConstellationController({ scheduler });
		const { ctx } = recordingContext({ getContextUsage: () => usage(80) });

		controller.onContext(ctx);
		const before = controller.state.snapshot().filledCells;

		controller.onAutoCompactionStart(ctx);
		expect(controller.state.snapshot().sweep).toMatchObject({ from: before, to: before });

		scheduler.advance(50);
		controller.onAutoCompactionEnd({ ...ctx, getContextUsage: () => usage(20) });
		const snap = controller.state.snapshot();
		expect(snap.filledCells).toBe(cellsForPercent(20));
		expect(snap.sweep?.to).toBe(cellsForPercent(20));
		expect(snap.sweep?.from).toBe(before);
	});

	it("renders and updates a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new ContextConstellationController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off", getContextUsage: () => usage(42, 128_000) });

		controller.onContext(ctx);
		expect((calls[0].content as string[])[0]).toBe("✦ 42.0%/128K");
		expect(scheduler.running).toBe(false);

		controller.onContext({ ...ctx, getContextUsage: () => usage(60, 128_000) });
		expect((calls[calls.length - 1].content as string[])[0]).toBe("✦ 60.0%/128K");
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new ContextConstellationController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onContext(ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new ContextConstellationController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onContext(ctx);
		controller.onAutoCompactionStart(ctx);
		controller.onAutoCompactionEnd(ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().sweep).toBeUndefined();
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new ContextConstellationController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onContext(ctx);
		const factory = calls[0].content as (
			tui: typeof noopTui,
			theme: ConstellationTheme,
		) => ContextConstellationWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
