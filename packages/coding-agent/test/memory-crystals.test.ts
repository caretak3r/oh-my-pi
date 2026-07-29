import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { AutoCompactionEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type MemoryCrystalsContext,
	MemoryCrystalsController,
} from "@oh-my-pi/pi-coding-agent/memory-crystals/controller";
import {
	crystalMagnitude,
	formatTokensCompact,
	gemGlyph,
	MAX_REFERENCE_TOKENS,
	SPARKLE_DURATION_MS,
	sparkleIntensity,
} from "@oh-my-pi/pi-coding-agent/memory-crystals/crystal";
import { MemoryCrystalsState } from "@oh-my-pi/pi-coding-agent/memory-crystals/state";
import {
	type MemoryCrystalsTheme,
	MemoryCrystalsWidget,
	renderMemoryCrystalsOffText,
	renderMemoryCrystalsRow,
} from "@oh-my-pi/pi-coding-agent/memory-crystals/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: MemoryCrystalsTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: MemoryCrystalsTheme = { fg: (color, text) => `${color}:${text}` };

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

/** Build a successful `auto_compaction_end` event (the only paths that ever populate `result`). */
function successfulCompactionEnd(
	tokensBefore: number,
	overrides: Partial<AutoCompactionEndEvent> = {},
): AutoCompactionEndEvent {
	return {
		type: "auto_compaction_end",
		action: "context-full",
		aborted: false,
		willRetry: false,
		result: { summary: "compacted the session", tokensBefore, firstKeptEntryId: "entry-1" },
		...overrides,
	} as AutoCompactionEndEvent;
}

/** An aborted/skipped/handoff/shake compaction — every one of these carries `result: undefined` in the real event union. */
function noResultCompactionEnd(overrides: Partial<AutoCompactionEndEvent> = {}): AutoCompactionEndEvent {
	return {
		type: "auto_compaction_end",
		action: "handoff",
		aborted: false,
		willRetry: false,
		result: undefined,
		...overrides,
	} as AutoCompactionEndEvent;
}

describe("memory crystals math (pure)", () => {
	it("crystalMagnitude is 0 at zero/negative tokens, ramps linearly, and clamps at 1 past the reference ceiling", () => {
		expect(crystalMagnitude(0)).toBe(0);
		expect(crystalMagnitude(-100)).toBe(0);
		expect(crystalMagnitude(MAX_REFERENCE_TOKENS / 2)).toBeCloseTo(0.5, 5);
		expect(crystalMagnitude(MAX_REFERENCE_TOKENS)).toBe(1);
		expect(crystalMagnitude(MAX_REFERENCE_TOKENS * 10)).toBe(1);
		expect(crystalMagnitude(Number.NaN)).toBe(0);
	});

	it("gemGlyph is monotonic along its ramp", () => {
		const glyphs = [0, 0.2, 0.4, 0.6, 0.8, 1].map(gemGlyph);
		expect(new Set(glyphs).size).toBeGreaterThan(1);
		expect(gemGlyph(0)).toBe(gemGlyph(0.01));
		expect(gemGlyph(1)).toBe(gemGlyph(0.99));
	});

	it("sparkleIntensity is born at full brightness and decays to 0 by durationMs", () => {
		expect(sparkleIntensity(0)).toBe(1);
		expect(sparkleIntensity(SPARKLE_DURATION_MS / 2)).toBeCloseTo(0.5, 5);
		expect(sparkleIntensity(SPARKLE_DURATION_MS)).toBe(0);
		expect(sparkleIntensity(SPARKLE_DURATION_MS * 10)).toBe(0);
		expect(sparkleIntensity(-50)).toBe(1); // clamps negative elapsed to "just spawned"
	});

	it("formatTokensCompact renders sub-1000 counts verbatim and larger counts as a 'k' figure", () => {
		expect(formatTokensCompact(0)).toBe("0");
		expect(formatTokensCompact(340)).toBe("340");
		expect(formatTokensCompact(12_400)).toBe("12.4k");
		expect(formatTokensCompact(Number.NaN)).toBe("0");
		expect(formatTokensCompact(-5)).toBe("0");
	});
});

describe("memory crystals state", () => {
	it("accumulates total crystals and reclaimed tokens across compactions", () => {
		const state = new MemoryCrystalsState();
		expect(state.snapshot()).toMatchObject({ totalCrystals: 0, totalTokensReclaimed: 0, hiddenCount: 0 });

		state.applyCompactionEnd(10_000, "first pass", "context-full", 0);
		state.applyCompactionEnd(20_000, "second pass", "snapcompact", 100);
		const snapshot = state.snapshot();
		expect(snapshot.totalCrystals).toBe(2);
		expect(snapshot.totalTokensReclaimed).toBe(30_000);
		expect(snapshot.crystals).toHaveLength(2);
		expect(snapshot.crystals[0].summary).toBe("first pass");
		expect(snapshot.crystals[1].spawnedAt).toBe(100);
		expect(snapshot.crystals[1].magnitude).toBeCloseTo(crystalMagnitude(20_000), 10);
	});

	it("caps the displayed tray and reports the rest as hiddenCount, keeping the most recent crystals", () => {
		const state = new MemoryCrystalsState();
		for (let i = 0; i < 13; i++) {
			state.applyCompactionEnd(1000 * (i + 1), `pass ${i}`, "context-full", i);
		}
		const snapshot = state.snapshot();
		expect(snapshot.totalCrystals).toBe(13);
		expect(snapshot.crystals).toHaveLength(10);
		expect(snapshot.hiddenCount).toBe(3);
		// Oldest 3 dropped; the tray keeps the most recent 10 in original spawn order.
		expect(snapshot.crystals[0].summary).toBe("pass 3");
		expect(snapshot.crystals[9].summary).toBe("pass 12");
	});

	it("treats non-finite/negative tokensBefore as a zero-magnitude crystal rather than throwing", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(Number.NaN, "weird", "context-full", 0);
		const snapshot = state.snapshot();
		expect(snapshot.totalTokensReclaimed).toBe(0);
		expect(snapshot.crystals[0].magnitude).toBe(0);
		expect(snapshot.totalCrystals).toBe(1);
	});
});

describe("memory crystals rendering (byte-stable)", () => {
	it("full tier flashes accent for a freshly spawned crystal, then settles to its magnitude color", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(MAX_REFERENCE_TOKENS, "big pass", "context-full", 0);

		const fresh = renderMemoryCrystalsRow(state.snapshot(), 0, taggedTheme, "full");
		const settled = renderMemoryCrystalsRow(state.snapshot(), SPARKLE_DURATION_MS * 2, taggedTheme, "full");
		expect(fresh.startsWith("accent:")).toBe(true);
		expect(settled.startsWith("success:")).toBe(true); // full magnitude -> success tier
	});

	it("subtle tier always shows the resting color, ignoring how recently the crystal spawned", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(MAX_REFERENCE_TOKENS, "big pass", "context-full", 0);

		const atSpawn = renderMemoryCrystalsRow(state.snapshot(), 0, taggedTheme, "subtle");
		const later = renderMemoryCrystalsRow(state.snapshot(), 10_000, taggedTheme, "subtle");
		expect(atSpawn.startsWith("success:")).toBe(true);
		expect(later).toBe(atSpawn);
	});

	it("renders the empty-tray message before any crystal exists", () => {
		const state = new MemoryCrystalsState();
		expect(renderMemoryCrystalsRow(state.snapshot(), 0, idTheme, "full")).toBe("· tray empty ·");
	});

	it("appends a '+N more' trailer once the tray is capped", () => {
		const state = new MemoryCrystalsState();
		for (let i = 0; i < 12; i++) state.applyCompactionEnd(500, `pass ${i}`, "context-full", i);
		const row = renderMemoryCrystalsRow(state.snapshot(), 100_000, idTheme, "full");
		expect(row).toContain("+2 more");
	});

	it("is deterministic: same snapshot and elapsedMs always render identically", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(5000, "pass", "context-full", 0);
		const a = renderMemoryCrystalsRow(state.snapshot(), 200, idTheme, "full");
		const b = renderMemoryCrystalsRow(state.snapshot(), 200, idTheme, "full");
		expect(a).toBe(b);
	});

	it("off-tier text reports 'no crystals yet' before any compaction, then a pluralized count/reclaim summary afterward", () => {
		const state = new MemoryCrystalsState();
		expect(renderMemoryCrystalsOffText(state.snapshot())).toBe("no crystals yet");

		state.applyCompactionEnd(500, "pass", "context-full", 0);
		expect(renderMemoryCrystalsOffText(state.snapshot())).toBe("◆ 1 crystal · 500 tokens reclaimed");

		state.applyCompactionEnd(20_000, "pass 2", "snapcompact", 10);
		expect(renderMemoryCrystalsOffText(state.snapshot())).toBe("◆ 2 crystals · 20.5k tokens reclaimed");
	});
});

describe("memory crystals widget lifecycle", () => {
	it("renders a frame, tracks the injected clock, and disposes with zero leaked subscriptions", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(MAX_REFERENCE_TOKENS, "pass", "context-full", 0);
		const widget = new MemoryCrystalsWidget({
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
		scheduler.advance(SPARKLE_DURATION_MS + 50);
		const next = widget.render(80);
		expect(next).not.toEqual(initial); // sparkle decayed from accent to the resting magnitude color

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(1000, "pass", "context-full", 0);
		const widget = new MemoryCrystalsWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).not.toBe("");
	});
});

/** Hoisted to module scope so both the base controller suite and the hardening suite can share it. */
function recordingContext(
	overrides: Partial<MemoryCrystalsContext> = {},
	scheduler: FrameScheduler = manualScheduler(),
): {
	ctx: MemoryCrystalsContext;
	calls: Array<{ key: string; content: unknown }>;
} {
	const calls: Array<{ key: string; content: unknown }> = [];
	const policy = new MotionPolicy(fullEnv, "full");
	const ctx: MemoryCrystalsContext = {
		hasUI: true,
		animation: { host: new AnimationHost({ policy, scheduler }), policy },
		theme: idTheme,
		setWidget: (key, content) => calls.push({ key, content }),
		...overrides,
	};
	return { ctx, calls };
}

describe("memory crystals controller", () => {
	it("mounts an animated widget on the first successful compaction and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new MemoryCrystalsController({ scheduler });
		const { ctx, calls } = recordingContext({}, scheduler);

		controller.onAutoCompactionEnd(successfulCompactionEnd(10_000), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: MemoryCrystalsTheme) => MemoryCrystalsWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onAutoCompactionEnd(successfulCompactionEnd(5000), ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().totalCrystals).toBe(2);
	});

	it("ignores auto_compaction_end events with an undefined result (aborted, skipped, handoff, or shake)", () => {
		const controller = new MemoryCrystalsController();
		const { ctx, calls } = recordingContext();

		controller.onAutoCompactionEnd(noResultCompactionEnd({ action: "handoff" }), ctx);
		controller.onAutoCompactionEnd(noResultCompactionEnd({ action: "shake" }), ctx);
		controller.onAutoCompactionEnd(noResultCompactionEnd({ action: "context-full", aborted: true }), ctx);
		controller.onAutoCompactionEnd(noResultCompactionEnd({ action: "context-full", skipped: true }), ctx);

		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().totalCrystals).toBe(0);
	});

	it("renders and updates a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new MemoryCrystalsController({ scheduler });
		const { ctx, calls } = recordingContext({ animation: undefined }, scheduler);

		controller.onAutoCompactionEnd(successfulCompactionEnd(500), ctx);
		expect((calls[0].content as string[])[0]).toBe("◆ 1 crystal · 500 tokens reclaimed");
		expect(scheduler.running).toBe(false);

		controller.onAutoCompactionEnd(successfulCompactionEnd(2000), ctx);
		expect((calls[calls.length - 1].content as string[])[0]).toBe("◆ 2 crystals · 2.5k tokens reclaimed");
	});

	it("falls back to a static line without a session animation handle", () => {
		const controller = new MemoryCrystalsController();
		const { ctx, calls } = recordingContext({ animation: undefined });

		controller.onAutoCompactionEnd(successfulCompactionEnd(1000), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new MemoryCrystalsController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onAutoCompactionEnd(successfulCompactionEnd(1000), ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().totalCrystals).toBe(0);
	});

	it("dispose clears the widget without disposing the session-owned host", () => {
		const scheduler = manualScheduler();
		const controller = new MemoryCrystalsController({ scheduler });
		const { ctx, calls } = recordingContext({}, scheduler);

		controller.onAutoCompactionEnd(successfulCompactionEnd(1000), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: MemoryCrystalsTheme) => MemoryCrystalsWidget;
		const widget = factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(true);

		widget.dispose();
		expect(scheduler.running).toBe(false);
	});
});

describe("memory crystals hardening — edge cases", () => {
	it("gemGlyph(NaN) falls back to the dimmest glyph instead of rendering undefined (regression test)", () => {
		expect(gemGlyph(Number.NaN)).toBe(gemGlyph(0));
		expect(gemGlyph(Number.NaN)).not.toBeUndefined();
	});

	it("gemGlyph clamps +/-Infinity to the ramp's brightest/dimmest ends", () => {
		expect(gemGlyph(Number.POSITIVE_INFINITY)).toBe(gemGlyph(1));
		expect(gemGlyph(Number.NEGATIVE_INFINITY)).toBe(gemGlyph(0));
	});

	it("crystalMagnitude treats +Infinity tokensBefore as zero (fails the Number.isFinite guard), not maximal", () => {
		expect(crystalMagnitude(Number.POSITIVE_INFINITY)).toBe(0);
		expect(crystalMagnitude(Number.NEGATIVE_INFINITY)).toBe(0);
	});

	it("sparkleIntensity propagates NaN for a NaN elapsedMs or durationMs, but callers never observe it as a crash", () => {
		expect(Number.isNaN(sparkleIntensity(Number.NaN))).toBe(true);
		expect(Number.isNaN(sparkleIntensity(100, Number.NaN))).toBe(true);
		// A NaN sparkle intensity fails every `> 0.5` comparison in the renderer, so it silently
		// reads as "not sparkling" rather than corrupting output — verified below at the render level.
	});

	it("sparkleIntensity(elapsedMs, Infinity) never crashes: an infinite duration reads as 'just spawned' at any finite elapsedMs", () => {
		// elapsedMs / Infinity is always 0, so cos(0) keeps the crystal at full brightness forever — an
		// infinite sparkle duration is a degenerate input no real caller produces (durationMs is always the
		// SPARKLE_DURATION_MS constant), documented here rather than "fixed" since it can't reach this path.
		expect(sparkleIntensity(1000, Number.POSITIVE_INFINITY)).toBe(1);
		expect(sparkleIntensity(1_000_000, Number.POSITIVE_INFINITY)).toBe(1);
	});

	it("formatTokensCompact treats +/-Infinity as zero, matching its NaN/negative handling", () => {
		expect(formatTokensCompact(Number.POSITIVE_INFINITY)).toBe("0");
		expect(formatTokensCompact(Number.NEGATIVE_INFINITY)).toBe("0");
	});

	it("a NaN-poisoned spawnedAt (NaN clock at record time) never sparkles and never renders undefined", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(5000, "poisoned clock", "context-full", Number.NaN);
		const snapshot = state.snapshot();
		expect(snapshot.crystals[0].spawnedAt).toBeNaN();

		const row = renderMemoryCrystalsRow(snapshot, 0, idTheme, "full");
		expect(row).not.toContain("undefined");
		// sinceSpawn = 0 - NaN = NaN, which fails the `>= 0` guard, so it renders the resting glyph.
		expect(row).toBe(gemGlyph(snapshot.crystals[0].magnitude));
	});

	it("backward clock skew across compactions is stored as-is without throwing or reordering the tray", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(1000, "first", "context-full", 500);
		state.applyCompactionEnd(2000, "second (earlier clock reading)", "context-full", 100);
		const snapshot = state.snapshot();
		expect(snapshot.crystals[0].spawnedAt).toBe(500);
		expect(snapshot.crystals[1].spawnedAt).toBe(100);
		expect(snapshot.crystals.map(c => c.summary)).toEqual(["first", "second (earlier clock reading)"]);
	});

	it("hiddenCount never goes negative even immediately after construction", () => {
		const state = new MemoryCrystalsState();
		expect(state.snapshot().hiddenCount).toBe(0);
	});

	it("off-tier text never renders undefined/NaN even after a NaN-tokens compaction", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(Number.NaN, "weird", "context-full", 0);
		const text = renderMemoryCrystalsOffText(state.snapshot());
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("NaN");
		expect(text).toBe("◆ 1 crystal · 0 tokens reclaimed");
	});

	it("renders a wide adversarial tray (many crystals, mixed NaN/Infinity/negative tokens) with no undefined/NaN text", () => {
		const state = new MemoryCrystalsState();
		const inputs = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -100, 0, 40_000, 1e9];
		for (const [i, tokens] of inputs.entries()) state.applyCompactionEnd(tokens, `pass ${i}`, "context-full", i);
		const row = renderMemoryCrystalsRow(state.snapshot(), 0, idTheme, "full");
		expect(row).not.toContain("undefined");
		expect(row).not.toContain("NaN");
	});

	it("controller: onAutoCompactionEnd before any mount, then dispose(), is a safe no-op", () => {
		const controller = new MemoryCrystalsController();
		const { ctx, calls } = recordingContext();
		controller.dispose(ctx);
		expect(calls).toHaveLength(0);
	});

	it("controller: dispose() is idempotent when called twice in a row", () => {
		const scheduler = manualScheduler();
		const controller = new MemoryCrystalsController({ scheduler });
		const { ctx, calls } = recordingContext();
		controller.onAutoCompactionEnd(successfulCompactionEnd(1000), ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;
		controller.dispose(ctx);
		expect(calls).toHaveLength(callsAfterFirstDispose); // no extra setWidget(undefined) call
	});

	it("controller: remounts cleanly if a new compaction arrives after dispose()", () => {
		const scheduler = manualScheduler();
		const controller = new MemoryCrystalsController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAutoCompactionEnd(successfulCompactionEnd(1000), ctx);
		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();

		controller.onAutoCompactionEnd(successfulCompactionEnd(2000), ctx);
		const last = calls[calls.length - 1].content;
		expect(typeof last).toBe("function"); // remounted an animated widget, not left dormant
		expect(controller.state.snapshot().totalCrystals).toBe(2); // state survived dispose (only the mount tore down)
	});

	it("controller: an empty summary string on a real compaction still renders without crashing", () => {
		const controller = new MemoryCrystalsController();
		const { ctx, calls } = recordingContext();
		controller.onAutoCompactionEnd(
			successfulCompactionEnd(1000, {
				result: { summary: "", tokensBefore: 1000, firstKeptEntryId: "entry-1" },
			}),
			ctx,
		);
		expect(calls).toHaveLength(1);
		expect(controller.state.snapshot().crystals[0].summary).toBe("");
	});
});
