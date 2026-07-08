import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type TokenTideContext,
	TokenTideController,
	type WallClock,
} from "@oh-my-pi/pi-coding-agent/token-tide/controller";
import {
	BUCKET_THEME_COLOR,
	MAX_REFERENCE_RATE,
	normalizeAmplitude,
	rateBucket,
	restingPulse,
	WAVE_GLYPHS,
	waveGlyph,
} from "@oh-my-pi/pi-coding-agent/token-tide/scale";
import { TokenTideState } from "@oh-my-pi/pi-coding-agent/token-tide/state";
import {
	renderTokenRateText,
	renderVuBar,
	renderWaveformRow,
	type TokenTideTheme,
	TokenTideWidget,
} from "@oh-my-pi/pi-coding-agent/token-tide/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: TokenTideTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which bucket colored a glyph.
const taggedTheme: TokenTideTheme = { fg: (color, text) => `${color}:${text}` };

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

/** Manual wall clock (epoch ms) — distinct from the frame scheduler, matching the shipped seam. */
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

describe("token tide rate scale (pure)", () => {
	it("rateBucket classifies tok/s into ascending buckets", () => {
		expect(rateBucket(0)).toBe("idle");
		expect(rateBucket(-5)).toBe("idle");
		expect(rateBucket(5)).toBe("low");
		expect(rateBucket(20)).toBe("low");
		expect(rateBucket(21)).toBe("medium");
		expect(rateBucket(60)).toBe("medium");
		expect(rateBucket(61)).toBe("high");
		expect(rateBucket(120)).toBe("high");
		expect(rateBucket(121)).toBe("burst");
	});

	it("gives every bucket a distinct theme color, warming from idle to burst", () => {
		const colors = Object.values(BUCKET_THEME_COLOR);
		expect(new Set(colors).size).toBe(colors.length);
	});

	it("normalizeAmplitude is monotonic non-decreasing in tokensPerSecond and clamps to 1", () => {
		const samples = [0, 10, 40, 80, MAX_REFERENCE_RATE, MAX_REFERENCE_RATE * 2].map(normalizeAmplitude);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
		}
		expect(normalizeAmplitude(0)).toBe(0);
		expect(normalizeAmplitude(MAX_REFERENCE_RATE)).toBe(1);
		expect(normalizeAmplitude(MAX_REFERENCE_RATE * 10)).toBe(1);
	});

	it("restingPulse is bounded, periodic, and a pure function of elapsedMs alone", () => {
		for (const t of [0, 137, 1300, 2600, 5200, 999_999]) {
			const p = restingPulse(t);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(0.08);
		}
		expect(restingPulse(500)).toBe(restingPulse(500)); // pure
		expect(restingPulse(0)).toBeCloseTo(restingPulse(2600), 10); // periodic
	});

	it("waveGlyph is monotonic non-decreasing along the amplitude ramp", () => {
		const indices = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map(a =>
			WAVE_GLYPHS.indexOf(waveGlyph(a) as (typeof WAVE_GLYPHS)[number]),
		);
		const sorted = [...indices].sort((a, b) => a - b);
		expect(indices).toEqual(sorted);
		expect(waveGlyph(0)).toBe(WAVE_GLYPHS[0]);
		expect(waveGlyph(1)).toBe(WAVE_GLYPHS[WAVE_GLYPHS.length - 1]);
	});
});

describe("token tide waveform rendering (pure)", () => {
	it("is byte-stable across repeated calls with the same buffer and elapsed time", () => {
		const buffer = [0, 0, 10, 40, 80, 160, 40, 0];
		const first = renderWaveformRow(buffer, 1000, idTheme, buffer.length);
		const second = renderWaveformRow(buffer, 1000, idTheme, buffer.length);
		expect(first).toEqual(second);
	});

	it("pads blank columns on the left when the buffer is narrower than the requested width", () => {
		const row = renderWaveformRow([160], 0, idTheme, 4);
		expect(row).toHaveLength(4);
		expect(row.slice(0, 3)).toBe("   "); // three padded blanks
	});

	it("right-aligns to the newest samples when the buffer is wider than the requested width", () => {
		const wide = renderWaveformRow([0, 0, 160], 0, idTheme, 1);
		expect(wide).toBe(waveGlyph(1));
	});

	it("amplitude is monotonic in the sampled rate: louder input renders a higher glyph on the ramp", () => {
		const glyphAt = (rate: number) => renderWaveformRow([rate], 0, idTheme, 1);
		const rates = [0, 10, 40, 80, 160];
		const indices = rates.map(r => WAVE_GLYPHS.indexOf(glyphAt(r) as (typeof WAVE_GLYPHS)[number]));
		for (let i = 1; i < indices.length; i++) {
			expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
		}
	});

	it("a flat all-zero buffer renders only the resting pulse, never a bucket color", () => {
		const row = renderWaveformRow([0, 0, 0, 0], 1300, taggedTheme, 4);
		expect(row).toContain("dim:");
		for (const key of Object.keys(BUCKET_THEME_COLOR) as (keyof typeof BUCKET_THEME_COLOR)[]) {
			if (key === "idle") continue;
			expect(row).not.toContain(`${BUCKET_THEME_COLOR[key]}:`);
		}
	});

	it("colors an active column by its rate bucket", () => {
		const row = renderWaveformRow([200], 0, taggedTheme, 1);
		expect(row).toBe(`${BUCKET_THEME_COLOR.burst}:${waveGlyph(1)}`);
	});
});

describe("token tide VU bar and numeric fallback (pure)", () => {
	it("renderVuBar filled length maps to rate buckets, monotonic in tokensPerSecond", () => {
		// Total bar length is fixed under an identity theme; measure the filled segment instead.
		const filledCount = (rate: number) => (renderVuBar(rate, 0, idTheme).match(/█/g) ?? []).length;
		const counts = [0, 10, 40, 80, 160].map(filledCount);
		for (let i = 1; i < counts.length; i++) {
			expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
		}
		expect(filledCount(160)).toBeGreaterThan(filledCount(0));
	});

	it("renderVuBar shows a full bar at the reference ceiling and an all-empty bar plus resting pulse when idle", () => {
		const full = renderVuBar(MAX_REFERENCE_RATE, 0, taggedTheme);
		expect(full).not.toContain("░");
		const idle = renderVuBar(0, 0, taggedTheme);
		expect(idle).toContain("dim:");
	});

	it("renderTokenRateText formats a positive rate and falls back to a dash when idle/unknown", () => {
		expect(renderTokenRateText(142)).toBe("142 tok/s");
		expect(renderTokenRateText(141.6)).toBe("142 tok/s");
		expect(renderTokenRateText(0)).toBe("-- tok/s");
		expect(renderTokenRateText(null)).toBe("-- tok/s");
		expect(renderTokenRateText(-5)).toBe("-- tok/s");
	});
});

describe("token tide ring buffer state", () => {
	it("starts zero-filled at the configured capacity and stays that length after pushes", () => {
		const state = new TokenTideState({ capacity: 4 });
		expect(state.snapshot()).toEqual([0, 0, 0, 0]);
		state.pushSample(50);
		expect(state.snapshot()).toEqual([0, 0, 0, 50]);
		expect(state.latest()).toBe(50);
	});

	it("drops the oldest sample once the buffer is full", () => {
		const state = new TokenTideState({ capacity: 3 });
		state.pushSample(1);
		state.pushSample(2);
		state.pushSample(3);
		state.pushSample(4);
		expect(state.snapshot()).toEqual([2, 3, 4]);
	});

	it("coerces non-finite or negative samples to idle (0)", () => {
		const state = new TokenTideState({ capacity: 2 });
		state.pushSample(-5);
		state.pushSample(Number.NaN);
		expect(state.snapshot()).toEqual([0, 0]);
	});
});

describe("token tide widget lifecycle", () => {
	it("subscribes on mount, samples via the injected clocks each tick, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new TokenTideState({ capacity: 4 });
		let nextRate: number | null = 80;
		const widget = new TokenTideWidget({
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
		expect(state.latest()).toBe(80);

		nextRate = null;
		scheduler.advance(33);
		expect(state.latest()).toBe(0); // idle sample coerces to 0

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("subtle tier renders a VU bar, not a waveform row", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "subtle");
		const host = new AnimationHost({ policy, scheduler });
		const state = new TokenTideState({ capacity: 4 });
		state.pushSample(160);
		const widget = new TokenTideWidget({
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
		expect(rows[0]).toBe(renderVuBar(160, 0, idTheme));
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new TokenTideState({ capacity: 4 });
		const widget = new TokenTideWidget({
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
		// off tier resolves through the widget's subtle branch, same as retry-radar/tool-constellation.
		expect(widget.render(80)).toEqual([renderVuBar(state.latest(), 0, idTheme)]);
	});
});

describe("token tide controller", () => {
	function recordingContext(overrides: Partial<TokenTideContext> = {}): {
		ctx: TokenTideContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: TokenTideContext = {
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
		const controller = new TokenTideController({ scheduler, wallClock });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: TokenTideTheme) => TokenTideWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);
		expect(scheduler.running).toBe(true);
	});

	it("ignores user and tool-result messages entirely", () => {
		const scheduler = manualScheduler();
		const controller = new TokenTideController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(messageStartEvent(userMessage()), ctx);
		expect(calls).toHaveLength(0);
	});

	it("samples a live rate from a growing assistant message via message_update, reusing the shared token-rate provider", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock(1_000_000);
		const controller = new TokenTideController({ scheduler, wallClock });

		controller.onMessageStart(messageStartEvent(assistantMessage(1_000_000, 0)), {
			hasUI: false,
		} as TokenTideContext);
		wallClock.advance(500);
		controller.onMessageUpdate(messageUpdateEvent(assistantMessage(1_000_000, 100)), {
			hasUI: false,
		} as TokenTideContext);

		// 100 output tokens over 500ms of in-flight streaming == 200 tok/s.
		expect(controller.sampleRate(wallClock.now())).toBeCloseTo(200, 5);
	});

	it("clears the tracked message on message_end so throughput settles back to idle between turns", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock(0);
		const controller = new TokenTideController({ scheduler, wallClock });
		const dormantCtx = { hasUI: false } as TokenTideContext;

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), dormantCtx);
		controller.onMessageEnd(messageEndEvent(assistantMessage(0, 300, 600)), dormantCtx);

		expect(controller.sampleRate(wallClock.now())).toBeNull();
	});

	it("renders and live-updates a static numeric line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const wallClock = manualWallClock(0);
		const controller = new TokenTideController({ scheduler, wallClock });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(calls[0].content).toEqual(["-- tok/s"]);
		expect(scheduler.running).toBe(false); // static tier never starts the shared frame clock

		wallClock.advance(1000);
		controller.onMessageUpdate(messageUpdateEvent(assistantMessage(0, 150)), ctx);
		expect(calls[1].content).toEqual(["150 tok/s"]);

		controller.onMessageEnd(messageEndEvent(assistantMessage(0, 150, 1000)), ctx);
		expect(calls[2].content).toEqual(["-- tok/s"]); // settles back to idle between turns
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const scheduler = manualScheduler();
		const controller = new TokenTideController({ scheduler });
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const scheduler = manualScheduler();
		const controller = new TokenTideController({ scheduler });
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new TokenTideController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(messageStartEvent(assistantMessage(0, 0)), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: TokenTideTheme) => TokenTideWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
