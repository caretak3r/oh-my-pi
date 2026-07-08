import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import {
	flameBrightness,
	flameGlyph,
	formatUsd,
	GUTTER_DECAY_MS,
	GUTTER_REFERENCE_COST_USD,
	gutterEnvelope,
	gutterIntensity,
	WAX_REFERENCE_COST_USD,
	waxBar,
	waxRemaining,
} from "@oh-my-pi/pi-coding-agent/cost-candle/candle";
import { type CostCandleContext, CostCandleController } from "@oh-my-pi/pi-coding-agent/cost-candle/controller";
import { CostCandleState } from "@oh-my-pi/pi-coding-agent/cost-candle/state";
import {
	type CostCandleTheme,
	CostCandleWidget,
	renderCostCandleOffText,
	renderCostCandleRow,
} from "@oh-my-pi/pi-coding-agent/cost-candle/widget";
import type { MessageEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: CostCandleTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: CostCandleTheme = { fg: (color, text) => `${color}:${text}` };

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

/** Build a minimal `message_end` event for an assistant message with the given settled USD cost. */
function assistantMessageEnd(costUsd: number): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
			},
			stopReason: "stop",
		},
	} as unknown as MessageEndEvent;
}

function toolResultMessageEnd(): MessageEndEvent {
	return { type: "message_end", message: { role: "toolResult" } } as unknown as MessageEndEvent;
}

describe("cost candle math (pure)", () => {
	it("waxRemaining is 1 at zero spend, decreases monotonically, and clamps at 0 past the reference ceiling", () => {
		expect(waxRemaining(0)).toBe(1);
		expect(waxRemaining(-5)).toBe(1);
		expect(waxRemaining(WAX_REFERENCE_COST_USD / 2)).toBeCloseTo(0.5, 5);
		expect(waxRemaining(WAX_REFERENCE_COST_USD)).toBe(0);
		expect(waxRemaining(WAX_REFERENCE_COST_USD * 10)).toBe(0);
	});

	it("gutterIntensity is 0 at zero cost, ramps linearly, and clamps at 1 past the reference cost", () => {
		expect(gutterIntensity(0)).toBe(0);
		expect(gutterIntensity(-1)).toBe(0);
		expect(gutterIntensity(GUTTER_REFERENCE_COST_USD / 2)).toBeCloseTo(0.5, 5);
		expect(gutterIntensity(GUTTER_REFERENCE_COST_USD)).toBe(1);
		expect(gutterIntensity(GUTTER_REFERENCE_COST_USD * 10)).toBe(1);
	});

	it("gutterEnvelope decays linearly to 0 by GUTTER_DECAY_MS and stays 0 for non-positive peakIntensity", () => {
		expect(gutterEnvelope(0, 0)).toBe(0);
		expect(gutterEnvelope(1, 0)).toBe(1);
		expect(gutterEnvelope(1, GUTTER_DECAY_MS / 2)).toBeCloseTo(0.5, 5);
		expect(gutterEnvelope(1, GUTTER_DECAY_MS)).toBe(0);
		expect(gutterEnvelope(1, GUTTER_DECAY_MS * 10)).toBe(0);
		expect(gutterEnvelope(1, -100)).toBe(1); // clamps negative msSinceTurn to "just happened"
	});

	it("flameBrightness oscillates with a wider swing as gutterAmplitude rises, but stays within [0, 1]", () => {
		const calmSamples = Array.from({ length: 14 }, (_, i) => flameBrightness(i * 50, 0));
		const gutterSamples = Array.from({ length: 14 }, (_, i) => flameBrightness(i * 50, 1));
		for (const b of [...calmSamples, ...gutterSamples]) {
			expect(b).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThanOrEqual(1);
		}
		const calmSwing = Math.max(...calmSamples) - Math.min(...calmSamples);
		const gutterSwing = Math.max(...gutterSamples) - Math.min(...gutterSamples);
		expect(gutterSwing).toBeGreaterThan(calmSwing);
	});

	it("flameBrightness is deterministic and periodic in elapsedMs alone", () => {
		expect(flameBrightness(123, 0.4)).toBe(flameBrightness(123, 0.4));
		expect(flameBrightness(0, 0.4)).toBeCloseTo(flameBrightness(700, 0.4), 10); // FLICKER_PERIOD_MS === 700
	});

	it("flameGlyph and waxBar are monotonic along their ramps", () => {
		const glyphs = [0, 0.3, 0.6, 0.9].map(flameGlyph);
		expect(new Set(glyphs).size).toBeGreaterThan(1);

		const emptyBar = waxBar(0, 10);
		const halfBar = waxBar(0.5, 10);
		const fullBar = waxBar(1, 10);
		const countFilled = (bar: string) => [...bar].filter(ch => ch === "█").length;
		expect(countFilled(emptyBar)).toBe(0);
		expect(countFilled(halfBar)).toBe(5);
		expect(countFilled(fullBar)).toBe(10);
		expect(emptyBar).toHaveLength(10);
		expect(fullBar).toHaveLength(10);
	});

	it("waxBar handles a zero-width bar without throwing", () => {
		expect(waxBar(0.5, 0)).toBe("");
	});

	it("formatUsd renders two decimal places and coerces non-finite input to $0.00", () => {
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(1.239)).toBe("$1.24");
		expect(formatUsd(Number.NaN)).toBe("$0.00");
	});
});

describe("cost candle state", () => {
	it("accumulates total cost and message count across recorded messages", () => {
		const state = new CostCandleState();
		expect(state.snapshot()).toMatchObject({ totalCostUsd: 0, messageCount: 0, averageMessageCostUsd: 0 });

		state.recordMessageCost(0.02, 100);
		state.recordMessageCost(0.04, 200);
		const snapshot = state.snapshot();
		expect(snapshot.totalCostUsd).toBeCloseTo(0.06, 10);
		expect(snapshot.messageCount).toBe(2);
		expect(snapshot.averageMessageCostUsd).toBeCloseTo(0.03, 10);
		expect(snapshot.lastMessageCostUsd).toBeCloseTo(0.04, 10);
		expect(snapshot.lastMessageAt).toBe(200);
	});

	it("stamps lastGutterPeakIntensity from the message's own cost, not the running total", () => {
		const state = new CostCandleState();
		state.recordMessageCost(GUTTER_REFERENCE_COST_USD, 0);
		expect(state.snapshot().lastGutterPeakIntensity).toBe(1);
		state.recordMessageCost(0, 10); // cheap follow-up turn barely disturbs the flame
		expect(state.snapshot().lastGutterPeakIntensity).toBe(0);
	});

	it("ignores negative or non-finite costs", () => {
		const state = new CostCandleState();
		expect(state.recordMessageCost(-1, 0)).toBe(false);
		expect(state.recordMessageCost(Number.NaN, 0)).toBe(false);
		expect(state.snapshot().messageCount).toBe(0);
	});

	it("snapshot before any message reports an undefined lastMessageAt", () => {
		expect(new CostCandleState().snapshot().lastMessageAt).toBeUndefined();
	});
});

describe("cost candle rendering (byte-stable)", () => {
	it("full tier renders flame + wax bar + total, reacting to a fresh gutter", () => {
		const state = new CostCandleState();
		state.recordMessageCost(GUTTER_REFERENCE_COST_USD, 0);
		const fresh = renderCostCandleRow(state.snapshot(), 0, idTheme, "full");
		const decayed = renderCostCandleRow(state.snapshot(), GUTTER_DECAY_MS * 2, idTheme, "full");
		expect(fresh).toContain("$0.05");
		expect(decayed).toContain("$0.05");
		// Same snapshot, same elapsedMs always renders identically (byte-stable).
		expect(renderCostCandleRow(state.snapshot(), 0, idTheme, "full")).toBe(fresh);
	});

	it("subtle tier ignores gutter amplitude entirely (calm, static flame regardless of recent cost)", () => {
		const state = new CostCandleState();
		state.recordMessageCost(GUTTER_REFERENCE_COST_USD, 0);
		const subtleAtZero = renderCostCandleRow(state.snapshot(), 0, taggedTheme, "subtle");
		const subtleLater = renderCostCandleRow(state.snapshot(), 40, taggedTheme, "subtle");
		// subtle tier's flame color never reflects gutter urgency: always "dim" (no active gutter fed in).
		expect(subtleAtZero.split(" ")[0].startsWith("dim:")).toBe(true);
		expect(subtleLater.split(" ")[0].startsWith("dim:")).toBe(true);
	});

	it("wax bar shrinks as cumulative cost rises", () => {
		const cheap = new CostCandleState();
		cheap.recordMessageCost(0.01, 0);
		const expensive = new CostCandleState();
		expensive.recordMessageCost(WAX_REFERENCE_COST_USD, 0);

		const cheapRow = renderCostCandleRow(cheap.snapshot(), 0, idTheme, "subtle");
		const expensiveRow = renderCostCandleRow(expensive.snapshot(), 0, idTheme, "subtle");
		const filledCount = (row: string) => [...row].filter(ch => ch === "█").length;
		expect(filledCount(cheapRow)).toBeGreaterThan(filledCount(expensiveRow));
	});

	it("off-tier text reports 'no spend yet' before any message, then total/average afterward", () => {
		const state = new CostCandleState();
		expect(renderCostCandleOffText(state.snapshot())).toBe("no spend yet");

		state.recordMessageCost(0.02, 0);
		state.recordMessageCost(0.04, 10);
		expect(renderCostCandleOffText(state.snapshot())).toBe("$0.06 total · $0.03/msg avg");
	});
});

describe("cost candle widget lifecycle", () => {
	it("renders a frame, tracks the injected clock (not the host's own elapsedMs), and disposes with zero leaked subscriptions", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CostCandleState();
		state.recordMessageCost(GUTTER_REFERENCE_COST_USD, 0);
		const widget = new CostCandleWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		const initial = widget.render(80);
		scheduler.advance(50);
		const next = widget.render(80);
		expect(next).not.toEqual(initial); // flicker phase advanced

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CostCandleState();
		state.recordMessageCost(0.03, 0);
		const widget = new CostCandleWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).not.toBe("");
	});
});

describe("cost candle controller", () => {
	function recordingContext(overrides: Partial<CostCandleContext> = {}): {
		ctx: CostCandleContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: CostCandleContext = {
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

	it("mounts an animated widget on the first assistant message_end and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new CostCandleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageEnd(assistantMessageEnd(0.02), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: CostCandleTheme) => CostCandleWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onMessageEnd(assistantMessageEnd(0.03), ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().messageCount).toBe(2);
	});

	it("ignores message_end events for non-assistant roles", () => {
		const controller = new CostCandleController();
		const { ctx, calls } = recordingContext();

		controller.onMessageEnd(toolResultMessageEnd(), ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().messageCount).toBe(0);
	});

	it("renders and updates a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new CostCandleController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onMessageEnd(assistantMessageEnd(0.02), ctx);
		expect((calls[0].content as string[])[0]).toBe("$0.02 total · $0.02/msg avg");
		expect(scheduler.running).toBe(false);

		controller.onMessageEnd(assistantMessageEnd(0.04), ctx);
		expect((calls[calls.length - 1].content as string[])[0]).toBe("$0.06 total · $0.03/msg avg");
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new CostCandleController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onMessageEnd(assistantMessageEnd(0.02), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new CostCandleController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onMessageEnd(assistantMessageEnd(0.02), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new CostCandleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageEnd(assistantMessageEnd(0.02), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: CostCandleTheme) => CostCandleWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
