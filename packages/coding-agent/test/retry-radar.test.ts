import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { type RetryRadarContext, RetryRadarController } from "@oh-my-pi/pi-coding-agent/retry-radar/controller";
import {
	RING_GLYPHS,
	ringGlyph,
	ringRemaining,
	secondsRemaining,
	shortReason,
} from "@oh-my-pi/pi-coding-agent/retry-radar/ring";
import {
	type RetryRadarState,
	type RetryRadarTheme,
	RetryRadarWidget,
	renderRetryLine,
} from "@oh-my-pi/pi-coding-agent/retry-radar/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: RetryRadarTheme = { fg: (_color, text) => text };

function waitingState(overrides: Partial<RetryRadarState> = {}): RetryRadarState {
	return { attempt: 2, maxAttempts: 5, delayMs: 8000, reason: "429", phase: "waiting", ...overrides };
}

/** Manual frame scheduler: drives host ticks and elapsed-ms deterministically. */
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

describe("retry radar ring math", () => {
	it("ringRemaining is a clamped pure function of elapsed vs delay", () => {
		expect(ringRemaining(0, 8000)).toBe(1);
		expect(ringRemaining(4000, 8000)).toBeCloseTo(0.5, 5);
		expect(ringRemaining(8000, 8000)).toBe(0);
		expect(ringRemaining(9000, 8000)).toBe(0); // past the end clamps
		expect(ringRemaining(1000, 0)).toBe(0); // non-positive delay reads as elapsed
		expect(ringRemaining(-100, 8000)).toBe(1); // negative elapsed clamps high
	});

	it("secondsRemaining rounds up and never goes negative", () => {
		expect(secondsRemaining(0, 8000)).toBe(8);
		expect(secondsRemaining(4000, 8000)).toBe(4);
		expect(secondsRemaining(7999, 8000)).toBe(1);
		expect(secondsRemaining(8000, 8000)).toBe(0);
		expect(secondsRemaining(12000, 8000)).toBe(0);
	});

	it("ringGlyph drains monotonically from full to empty", () => {
		expect(ringGlyph(1)).toBe(RING_GLYPHS[RING_GLYPHS.length - 1]);
		expect(ringGlyph(0)).toBe(RING_GLYPHS[0]);
		const glyphs: readonly string[] = RING_GLYPHS;
		const glyphIndices = [1, 0.75, 0.5, 0.25, 0].map(r => glyphs.indexOf(ringGlyph(r)));
		const sortedDesc = [...glyphIndices].sort((a, b) => b - a);
		expect(glyphIndices).toEqual(sortedDesc); // non-increasing as time elapses
	});

	it("shortReason prefers an HTTP status and sanitizes otherwise", () => {
		expect(shortReason("429 Too Many Requests")).toBe("429");
		expect(shortReason("Upstream 503 from provider")).toBe("503");
		expect(shortReason("connection reset by peer\nsecond line")).toBe("connection reset by peer");
		expect(shortReason(undefined)).toBe("");
		expect(shortReason("")).toBe("");
	});
});

describe("retry radar line rendering", () => {
	it("renders attempt, reason, ring glyph, and a draining countdown while waiting", () => {
		const state = waitingState();
		const atStart = renderRetryLine(state, 0, 80, idTheme);
		expect(atStart).toContain("retry 2/5");
		expect(atStart).toContain("429");
		expect(atStart).toContain("8s");
		expect(atStart.startsWith(RING_GLYPHS[RING_GLYPHS.length - 1])).toBe(true); // full ring at start

		const midway = renderRetryLine(state, 6000, 80, idTheme);
		expect(midway).toContain("2s");
		expect(secondsRemaining(6000, state.delayMs)).toBeLessThan(secondsRemaining(0, state.delayMs));
	});

	it("settles green on recovery and red on give-up with the final error", () => {
		const recovered = renderRetryLine(waitingState({ phase: "recovered" }), 8000, 80, idTheme);
		expect(recovered).toContain("recovered");
		expect(recovered).toContain("✔");

		const gaveUp = renderRetryLine(
			waitingState({ phase: "gaveup", attempt: 5, finalError: "503 Service Unavailable" }),
			8000,
			80,
			idTheme,
		);
		expect(gaveUp).toContain("failed");
		expect(gaveUp).toContain("✘");
		expect(gaveUp).toContain("503");
	});
});

describe("retry radar widget lifecycle", () => {
	it("subscribes on mount, reflects host elapsed, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const widget = new RetryRadarWidget({ tui: noopTui, host, policy, state: waitingState(), theme: idTheme });

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);
		expect(host.running).toBe(true);

		expect(widget.render(80)[0]).toContain("8s");
		scheduler.advance(4000);
		expect(widget.render(80)[0]).toContain("4s"); // frame clock drove the countdown

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const widget = new RetryRadarWidget({ tui: noopTui, host, policy, state: waitingState(), theme: idTheme });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).toContain("retry 2/5");
	});
});

describe("retry radar controller", () => {
	const startEvent = {
		type: "auto_retry_start" as const,
		attempt: 2,
		maxAttempts: 5,
		delayMs: 8000,
		errorMessage: "429 Too Many Requests",
	};

	function recordingContext(
		overrides: Partial<RetryRadarContext> = {},
		scheduler: FrameScheduler = manualScheduler(),
	): {
		ctx: RetryRadarContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const policy = new MotionPolicy(fullEnv, "full");
		const ctx: RetryRadarContext = {
			hasUI: true,
			animation: { host: new AnimationHost({ policy, scheduler }), policy },
			theme: idTheme,
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	const immediateTimer = (_ms: number, fn: () => void) => {
		fn();
		return () => {};
	};

	it("mounts an animated widget on start without disposing the session host on settle", () => {
		const scheduler = manualScheduler();
		const controller = new RetryRadarController({ timer: immediateTimer });
		const { ctx, calls } = recordingContext({}, scheduler);

		controller.onStart(startEvent, ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		// Simulate the UI invoking the widget factory (mount).
		const factory = calls[0].content as (tui: typeof noopTui, theme: RetryRadarTheme) => RetryRadarWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);
		expect(scheduler.running).toBe(true);

		controller.onEnd({ type: "auto_retry_end", success: true, attempt: 2 }, ctx);
		// Settle fires immediately: the widget is cleared, but its session host remains owned by the UI.
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(true);
		widget.dispose();
		expect(scheduler.running).toBe(false);
	});

	it("renders a static line for the off tier and updates it to the terminal state", () => {
		const controller = new RetryRadarController({ timer: immediateTimer });
		const { ctx, calls } = recordingContext({ animation: undefined });

		controller.onStart(startEvent, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
		expect((calls[0].content as string[]).join(" ")).toContain("retry 2/5");
		expect((calls[0].content as string[]).join(" ")).toContain("8s");

		controller.onEnd(
			{ type: "auto_retry_end", success: false, attempt: 5, finalError: "503 Service Unavailable" },
			ctx,
		);
		const terminal = calls.find(
			c => Array.isArray(c.content) && (c.content as string[]).join(" ").includes("failed"),
		);
		expect(terminal).toBeDefined();
		expect(calls[calls.length - 1].content).toBeUndefined(); // cleared after settle
	});

	it("falls back to a static line without a session animation handle", () => {
		const controller = new RetryRadarController({ timer: immediateTimer });
		const { ctx, calls } = recordingContext({ animation: undefined });

		controller.onStart(startEvent, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
		expect((calls[0].content as string[]).join(" ")).toContain("retry 2/5");
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new RetryRadarController({ timer: immediateTimer });
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onStart(startEvent, ctx);
		controller.onEnd({ type: "auto_retry_end", success: true, attempt: 2 }, ctx);
		expect(calls).toHaveLength(0);
	});
});
