import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import {
	BAND_ALPHAS,
	BAND_COUNT,
	stepBand,
	stepBands,
	stepPeak,
} from "@oh-my-pi/pi-coding-agent/cadence-equalizer/bars";
import {
	type CadenceEqualizerContext,
	CadenceEqualizerController,
	type WallClock,
} from "@oh-my-pi/pi-coding-agent/cadence-equalizer/controller";
import { CadenceEqualizerState } from "@oh-my-pi/pi-coding-agent/cadence-equalizer/state";
import {
	type CadenceEqualizerTheme,
	CadenceEqualizerWidget,
	renderCompactEqualizer,
	renderEqualizerRow,
	renderEqualizerText,
} from "@oh-my-pi/pi-coding-agent/cadence-equalizer/widget";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MAX_REFERENCE_RATE, normalizeAmplitude, waveGlyph } from "@oh-my-pi/pi-coding-agent/token-tide/scale";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: CadenceEqualizerTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which bucket colored a glyph.
const taggedTheme: CadenceEqualizerTheme = { fg: (color, text) => `${color}:${text}` };

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

/** Manual wall clock (epoch ms) — distinct from the frame scheduler, matching Token Tide's seam. */
function manualWallClock(start = 0): WallClock & { advance(ms: number): void } {
	let current = start;
	return {
		now: () => current,
		advance(ms) {
			current += ms;
		},
	};
}

const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

function assistantMessage(timestamp: number, output: number, duration?: number): MessageStartEvent["message"] {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: { output, input: 0, cacheRead: 0, cacheWrite: 0, totalTokens: output },
		stopReason: "stop",
		timestamp,
		duration,
	} as unknown as MessageStartEvent["message"];
}

function userMessage(): MessageStartEvent["message"] {
	return { role: "user", content: [], timestamp: 0 } as unknown as MessageStartEvent["message"];
}

function messageStartEvent(message: MessageStartEvent["message"]): MessageStartEvent {
	return { type: "message_start", message };
}
function messageUpdateEvent(message: MessageStartEvent["message"]): MessageUpdateEvent {
	return { type: "message_update", message, assistantMessageEvent: {} } as unknown as MessageUpdateEvent;
}
function messageEndEvent(message: MessageStartEvent["message"]): MessageEndEvent {
	return { type: "message_end", message };
}

describe("cadence equalizer band math (pure)", () => {
	it("stepBand eases toward the target and never overshoots", () => {
		let value = 0;
		for (let i = 0; i < 200; i++) value = stepBand(value, 1, 0.1);
		expect(value).toBeCloseTo(1, 5);
		expect(value).toBeLessThanOrEqual(1);
	});

	it("stepBand clamps out-of-range inputs to [0, 1]", () => {
		expect(stepBand(-5, 1, 0.5)).toBeGreaterThanOrEqual(0);
		expect(stepBand(2, 1, 0.5)).toBeLessThanOrEqual(1);
		expect(stepBand(0.5, Number.NaN, 0.5)).toBe(0.25); // NaN target clamps to 0
	});

	it("a higher alpha reacts to a step target strictly faster than a lower alpha", () => {
		const fast = stepBand(0, 1, 0.55);
		const slow = stepBand(0, 1, 0.05);
		expect(fast).toBeGreaterThan(slow);
	});

	it("stepPeak snaps up instantly to a new high and decays linearly otherwise", () => {
		expect(stepPeak(0, 0.6, 0.02)).toBe(0.6);
		expect(stepPeak(0.6, 0.1, 0.02)).toBeCloseTo(0.58, 10);
		expect(stepPeak(0.6, 0.9, 0.02)).toBe(0.9); // new high overrides decay
	});

	it("stepPeak never decays below the current amplitude (it's a hold, not a free fall)", () => {
		let peak = 1;
		const current = 0.5;
		for (let i = 0; i < 50; i++) peak = stepPeak(peak, current, 0.02);
		expect(peak).toBeGreaterThanOrEqual(current);
	});

	it("BAND_ALPHAS is fastest-first, matching BAND_COUNT in length", () => {
		expect(BAND_ALPHAS).toHaveLength(BAND_COUNT);
		const sorted = [...BAND_ALPHAS].sort((a, b) => b - a);
		expect(BAND_ALPHAS).toEqual(sorted);
	});

	it("stepBands steps every band/peak in one pass and never mutates its inputs", () => {
		const prevBands = new Array(BAND_COUNT).fill(0);
		const prevPeaks = new Array(BAND_COUNT).fill(0);
		const frozenBands = [...prevBands];
		const frozenPeaks = [...prevPeaks];
		const { bands, peaks } = stepBands(prevBands, prevPeaks, 1);
		expect(prevBands).toEqual(frozenBands);
		expect(prevPeaks).toEqual(frozenPeaks);
		expect(bands).toHaveLength(BAND_COUNT);
		expect(peaks).toHaveLength(BAND_COUNT);
		// Fast band (alpha 0.55) reacts more than the slow band (alpha 0.05) to the same step target.
		expect(bands[0]).toBeGreaterThan(bands[bands.length - 1]);
	});
});

describe("cadence equalizer state", () => {
	it("starts all bands and peaks at zero", () => {
		const state = new CadenceEqualizerState();
		expect(state.bandCount).toBe(BAND_COUNT);
		expect(state.snapshotBands()).toEqual(new Array(BAND_COUNT).fill(0));
		expect(state.snapshotPeaks()).toEqual(new Array(BAND_COUNT).fill(0));
	});

	it("pushSample coerces non-finite or negative targets to idle (0)", () => {
		const state = new CadenceEqualizerState();
		state.pushSample(1);
		const afterOne = state.snapshotBands();
		state.pushSample(Number.NaN);
		state.pushSample(-5);
		// Idle pushes should only ever ease bands down, never up or to something invalid.
		const after = state.snapshotBands();
		for (let i = 0; i < after.length; i++) {
			expect(after[i]).toBeLessThanOrEqual(afterOne[i]);
			expect(Number.isFinite(after[i])).toBe(true);
		}
	});

	it("snapshots are immutable copies — mutating one does not affect the next read", () => {
		const state = new CadenceEqualizerState();
		state.pushSample(1);
		const snap = state.snapshotBands() as number[];
		snap[0] = 999;
		expect(state.snapshotBands()[0]).not.toBe(999);
	});

	it("a sustained loud signal saturates every band toward 1, fast bands first", () => {
		const state = new CadenceEqualizerState();
		for (let i = 0; i < 5; i++) state.pushSample(1);
		const early = state.snapshotBands();
		for (let i = 0; i < 200; i++) state.pushSample(1);
		const saturated = state.snapshotBands();
		for (const v of saturated) expect(v).toBeCloseTo(1, 3);
		// Early on, the fast band should already be further along than the slow band.
		expect(early[0]).toBeGreaterThan(early[early.length - 1]);
	});
});

describe("cadence equalizer rendering (pure)", () => {
	it("renderEqualizerRow is byte-stable across repeated calls with the same snapshot", () => {
		const bands = [0.9, 0.6, 0.3, 0.1, 0];
		const peaks = [0.9, 0.6, 0.3, 0.1, 0];
		const first = renderEqualizerRow(bands, peaks, idTheme);
		const second = renderEqualizerRow(bands, peaks, idTheme);
		expect(first).toEqual(second);
	});

	it("renders one amplitude glyph plus a peak-cap column per band", () => {
		const bands = [1, 0, 0, 0, 0];
		const peaks = [1, 0, 0, 0, 0];
		const row = renderEqualizerRow(bands, peaks, idTheme);
		expect(row).toContain(waveGlyph(1));
	});

	it("shows a peak cap only once the band has decayed meaningfully below its held peak", () => {
		// The peak cap is colored with BUCKET_THEME_COLOR.burst ("warning"), so absence/presence
		// of "warning:‾" tracks whether the cap glyph itself rendered.
		const noCap = renderEqualizerRow([0.5], [0.5], taggedTheme);
		expect(noCap).not.toContain("warning:‾");
		const withCap = renderEqualizerRow([0.3], [0.9], taggedTheme);
		expect(withCap).toContain("warning:‾");
	});

	it("colors each band by its amplitude bucket, matching Token Tide's projected palette", () => {
		const row = renderEqualizerRow([1], [1], taggedTheme);
		// amplitude 1 * MAX_REFERENCE_RATE sits in the burst bucket, themed "warning".
		expect(row).toContain(`${waveGlyph(1)}`);
		expect(row).toMatch(/warning:.$/);
	});

	it("renderCompactEqualizer concatenates one glyph per band with no separators or peak caps", () => {
		const bands = [1, 1, 1, 1, 1];
		const compact = renderCompactEqualizer(bands, idTheme);
		expect(compact).toBe(waveGlyph(1).repeat(5));
	});

	it("renderEqualizerText formats a positive rate and falls back to idle text otherwise", () => {
		expect(renderEqualizerText(142)).toBe("eq 142 tok/s");
		expect(renderEqualizerText(141.6)).toBe("eq 142 tok/s");
		expect(renderEqualizerText(0)).toBe("eq --");
		expect(renderEqualizerText(null)).toBe("eq --");
		expect(renderEqualizerText(-5)).toBe("eq --");
	});
});

describe("cadence equalizer widget lifecycle", () => {
	it("subscribes on mount, samples via the injected clocks each tick, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CadenceEqualizerState();
		let nextRate: number | null = 80;
		const widget = new CadenceEqualizerWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			wallClock,
			sampleRate: () => nextRate,
		});

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);

		scheduler.advance(33);
		expect(state.snapshotBands()[0]).toBeGreaterThan(0);

		nextRate = null;
		const beforeIdle = state.snapshotBands()[0];
		scheduler.advance(33);
		expect(state.snapshotBands()[0]).toBeLessThanOrEqual(beforeIdle); // idle sample eases back down

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("full tier renders the multi-band row, not the compact strip", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CadenceEqualizerState();
		state.pushSample(1);
		const widget = new CadenceEqualizerWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			wallClock,
			sampleRate: () => null,
		});

		const rows = widget.render(80);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(renderEqualizerRow(state.snapshotBands(), state.snapshotPeaks(), idTheme));
	});

	it("subtle tier renders the compact strip, not the peak-cap row", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "subtle");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CadenceEqualizerState();
		state.pushSample(1);
		const widget = new CadenceEqualizerWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			wallClock,
			sampleRate: () => null,
		});

		const rows = widget.render(80);
		expect(rows).toEqual([renderCompactEqualizer(state.snapshotBands(), idTheme)]);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CadenceEqualizerState();
		const widget = new CadenceEqualizerWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			wallClock,
			sampleRate: () => 42,
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)).toEqual([renderCompactEqualizer(state.snapshotBands(), idTheme)]);
	});
});

describe("cadence equalizer controller", () => {
	function recordingContext(overrides: Partial<CadenceEqualizerContext> = {}): {
		ctx: CadenceEqualizerContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: CadenceEqualizerContext = {
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

	it("mounts an animated widget on the first streamed assistant message", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const controller = new CadenceEqualizerController({ scheduler, wallClock });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: CadenceEqualizerTheme) => CadenceEqualizerWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);
		expect(scheduler.running).toBe(true);
	});

	it("ignores user and tool-result messages entirely", () => {
		const scheduler = manualScheduler();
		const controller = new CadenceEqualizerController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(messageStartEvent(userMessage()), ctx);
		expect(calls).toHaveLength(0);
	});

	it("samples a live rate from a growing assistant message via message_update, reusing the shared token-rate provider", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock(1_000_000);
		const controller = new CadenceEqualizerController({ scheduler, wallClock });

		controller.onMessageStart(messageStartEvent(assistantMessage(1_000_000, 0)), {
			hasUI: false,
		} as CadenceEqualizerContext);
		wallClock.advance(500);
		controller.onMessageUpdate(messageUpdateEvent(assistantMessage(1_000_000, 100)), {
			hasUI: false,
		} as CadenceEqualizerContext);

		// 100 output tokens over 500ms of in-flight streaming == 200 tok/s.
		expect(controller.sampleRate(wallClock.now())).toBeCloseTo(200, 5);
		expect(normalizeAmplitude(controller.sampleRate(wallClock.now()) ?? 0)).toBeCloseTo(
			Math.min(1, 200 / MAX_REFERENCE_RATE),
			10,
		);
	});

	it("clears the tracked message on message_end so throughput settles back to idle between turns", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock(0);
		const controller = new CadenceEqualizerController({ scheduler, wallClock });
		const dormantCtx = { hasUI: false } as CadenceEqualizerContext;

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), dormantCtx);
		controller.onMessageEnd(messageEndEvent(assistantMessage(0, 300, 600)), dormantCtx);

		expect(controller.sampleRate(wallClock.now())).toBeNull();
	});

	it("renders and live-updates a static numeric line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock(0);
		const controller = new CadenceEqualizerController({ scheduler, wallClock });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(calls[0].content).toEqual(["eq --"]);
		expect(scheduler.running).toBe(false); // static tier never starts the shared frame clock

		wallClock.advance(1000);
		controller.onMessageUpdate(messageUpdateEvent(assistantMessage(0, 150)), ctx);
		expect(calls[1].content).toEqual(["eq 150 tok/s"]);

		controller.onMessageEnd(messageEndEvent(assistantMessage(0, 150, 1000)), ctx);
		expect(calls[2].content).toEqual(["eq --"]); // settles back to idle between turns
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const scheduler = manualScheduler();
		const controller = new CadenceEqualizerController({ scheduler });
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const scheduler = manualScheduler();
		const controller = new CadenceEqualizerController({ scheduler });
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new CadenceEqualizerController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: CadenceEqualizerTheme) => CadenceEqualizerWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
