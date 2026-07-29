import { describe, expect, it } from "bun:test";
import {
	AnimatedWidget,
	type AnimatedWidgetHost,
	AnimationHost,
	type BackpressureSignal,
	type FrameScheduler,
	type MotionEnvironment,
	MotionPolicy,
	resolveMotionTier,
	TIER_CADENCE_MS,
} from "../src/index";

/**
 * Deterministic clock/scheduler seam. Timers fire on `advance`, never on real
 * wall time, so every test drives frames explicitly. `activeTimers` and
 * `startCount` let coalescing tests assert the single-timer contract directly.
 */
class FakeScheduler implements FrameScheduler {
	#now = 0;
	#nextId = 0;
	#timers = new Map<number, { intervalMs: number; tick: () => void; nextAt: number }>();
	startCount = 0;

	now(): number {
		return this.#now;
	}

	start(intervalMs: number, tick: () => void): () => void {
		const id = this.#nextId++;
		this.startCount++;
		this.#timers.set(id, { intervalMs, tick, nextAt: this.#now + intervalMs });
		return () => {
			this.#timers.delete(id);
		};
	}

	get activeTimers(): number {
		return this.#timers.size;
	}

	/** Interval of the single active timer, or undefined when none is running. */
	get activeIntervalMs(): number | undefined {
		for (const t of this.#timers.values()) return t.intervalMs;
		return undefined;
	}

	/** Advance the clock by `ms`, firing due ticks in chronological order. */
	advance(ms: number): void {
		const target = this.#now + ms;
		let guard = 0;
		while (true) {
			let due: { intervalMs: number; tick: () => void; nextAt: number } | undefined;
			for (const t of this.#timers.values()) {
				if (t.nextAt <= target && (due === undefined || t.nextAt < due.nextAt)) due = t;
			}
			if (due === undefined) break;
			this.#now = due.nextAt;
			due.nextAt += due.intervalMs;
			due.tick();
			if (++guard > 1_000_000) throw new Error("runaway scheduler advance");
		}
		this.#now = target;
	}
}

/** Mutable backpressure signal for frame-skip tests. */
class ToggleBackpressure implements BackpressureSignal {
	underPressure = false;
}

const interactiveEnv = (overrides: Partial<MotionEnvironment> = {}): MotionEnvironment => ({
	hasUI: true,
	isTTY: true,
	env: {},
	...overrides,
});

function fullPolicy(env: Partial<MotionEnvironment> = {}): MotionPolicy {
	return new MotionPolicy(interactiveEnv(env), "full");
}

describe("AnimationHost coalescing", () => {
	it("shares one timer across N subscribers and stops on last unsubscribe", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		let firstFrames = 0;
		let secondFrames = 0;

		const unsubs = [
			host.subscribe(() => {
				firstFrames++;
			}),
			host.subscribe(() => {
				secondFrames++;
			}),
			host.subscribe(() => {}),
		];
		expect(host.subscriberCount).toBe(3);
		expect(scheduler.activeTimers).toBe(1);
		expect(scheduler.startCount).toBe(1);

		scheduler.advance(TIER_CADENCE_MS.full * 2 + 1);
		expect(firstFrames).toBe(2);
		expect(secondFrames).toBe(2);

		unsubs[0]!();
		unsubs[1]!();
		expect(scheduler.activeTimers).toBe(1);

		unsubs[2]!();
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);
		expect(host.running).toBe(false);
	});

	it("filters a subscriber cadence while keeping the host at full cadence", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		let unfilteredFrames = 0;
		let filteredFrames = 0;

		host.subscribe(() => {
			unfilteredFrames++;
		});
		host.subscribe(
			() => {
				filteredFrames++;
			},
			{ cadenceMs: () => TIER_CADENCE_MS.subtle },
		);

		scheduler.advance(1000);

		expect(scheduler.startCount).toBe(1);
		expect(scheduler.activeTimers).toBe(1);
		expect(unfilteredFrames).toBeGreaterThanOrEqual(29);
		expect(unfilteredFrames).toBeLessThanOrEqual(30);
		expect(filteredFrames).toBeGreaterThanOrEqual(10);
		expect(filteredFrames).toBeLessThanOrEqual(12);
	});

	it("never emits to a cadence-zero subscriber while siblings still receive frames", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		let unfilteredFrames = 0;
		let stoppedFrames = 0;

		host.subscribe(() => {
			unfilteredFrames++;
		});
		host.subscribe(
			() => {
				stoppedFrames++;
			},
			{ cadenceMs: () => 0 },
		);

		scheduler.advance(TIER_CADENCE_MS.full * 3 + 1);

		expect(unfilteredFrames).toBe(3);
		expect(stoppedFrames).toBe(0);
	});

	it("restarts the timer when a subscriber returns after the host went idle", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });

		const stop = host.subscribe(() => {});
		expect(scheduler.startCount).toBe(1);
		stop();
		expect(scheduler.activeTimers).toBe(0);

		host.subscribe(() => {});
		expect(scheduler.activeTimers).toBe(1);
		expect(scheduler.startCount).toBe(2);
	});

	it("emits monotonic frame indices and non-decreasing elapsed values", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const frames: number[] = [];
		const elapsed: number[] = [];
		host.subscribe((frame, elapsedMs) => {
			frames.push(frame);
			elapsed.push(elapsedMs);
		});

		// +1ms past the 4th frame so the boundary tick can't drift under float rounding.
		scheduler.advance(TIER_CADENCE_MS.full * 4 + 1);

		expect(frames).toEqual([1, 2, 3, 4]);
		expect(elapsed[0]).toBe(TIER_CADENCE_MS.full);
		for (let i = 1; i < elapsed.length; i++) {
			expect(elapsed[i]!).toBeGreaterThan(elapsed[i - 1]!);
		}
	});
});

describe("MotionPolicy gating", () => {
	it("forces off for every hard gate regardless of the setting", () => {
		expect(resolveMotionTier(interactiveEnv({ hasUI: false }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ isTTY: false }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ env: { CI: "true" } }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ env: { NO_COLOR: "1" } }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ env: { TERM: "dumb" } }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ backpressure: { underPressure: true } }), "full")).toBe("off");
	});

	it("passes the setting through on an interactive TTY", () => {
		expect(resolveMotionTier(interactiveEnv(), "subtle")).toBe("subtle");
		expect(resolveMotionTier(interactiveEnv(), "full")).toBe("full");
		expect(resolveMotionTier(interactiveEnv(), "off")).toBe("off");
	});

	it("treats an empty env var as unset (CI= does not gate)", () => {
		expect(resolveMotionTier(interactiveEnv({ env: { CI: "" } }), "full")).toBe("full");
	});

	it("notifies subscribers only when the resolved tier changes", () => {
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const seen: string[] = [];
		policy.subscribe(tier => seen.push(tier));

		policy.setSetting("full"); // no-op, no notification
		policy.setSetting("subtle");
		policy.setSetting("off");
		expect(seen).toEqual(["subtle", "off"]);
	});

	it("re-resolves live backpressure when the setting value is unchanged", () => {
		const backpressure = new ToggleBackpressure();
		backpressure.underPressure = true;
		const policy = new MotionPolicy(interactiveEnv({ backpressure }), "full");
		const seen: string[] = [];
		policy.subscribe(tier => seen.push(tier));
		expect(policy.tier).toBe("off");

		backpressure.underPressure = false;
		policy.setSetting("full");

		expect(policy.tier).toBe("full");
		expect(seen).toEqual(["full"]);
	});

	it("does not notify when the setting and environment resolve to the same tier", () => {
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const seen: string[] = [];
		policy.subscribe(tier => seen.push(tier));

		policy.setSetting("full");

		expect(seen).toEqual([]);
	});

	it("maps each tier to its cadence; off never starts a host timer", () => {
		expect(TIER_CADENCE_MS.off).toBe(0);
		expect(TIER_CADENCE_MS.subtle).toBeGreaterThan(TIER_CADENCE_MS.full);

		const scheduler = new FakeScheduler();
		const offHost = new AnimationHost({ policy: new MotionPolicy(interactiveEnv(), "off"), scheduler });
		offHost.subscribe(() => {});
		expect(scheduler.activeTimers).toBe(0);

		const subtleScheduler = new FakeScheduler();
		const subtleHost = new AnimationHost({
			policy: new MotionPolicy(interactiveEnv(), "subtle"),
			scheduler: subtleScheduler,
		});
		subtleHost.subscribe(() => {});
		expect(subtleScheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.subtle);
	});

	it("re-syncs host cadence live when the policy tier changes", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const host = new AnimationHost({ policy, scheduler });
		host.subscribe(() => {});
		expect(scheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.full);

		policy.setSetting("subtle");
		expect(scheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.subtle);

		policy.setSetting("off");
		expect(scheduler.activeTimers).toBe(0);
	});
});

describe("AnimationHost backpressure frame-skip", () => {
	it("emits fewer frames within a window while under pressure", () => {
		const scheduler = new FakeScheduler();
		const backpressure = new ToggleBackpressure();
		const host = new AnimationHost({ policy: fullPolicy(), backpressure, scheduler });

		let calmFrames = 0;
		let pressuredFrames = 0;
		let underPressure = false;
		host.subscribe(() => {
			if (underPressure) pressuredFrames++;
			else calmFrames++;
		});

		const window = TIER_CADENCE_MS.full * 10 + 1;
		scheduler.advance(window);
		expect(calmFrames).toBe(10);

		underPressure = true;
		backpressure.underPressure = true;
		scheduler.advance(window);
		expect(pressuredFrames).toBe(0);
		expect(pressuredFrames).toBeLessThan(calmFrames);
	});
});

describe("determinism", () => {
	it("reproduces the same elapsed sequence for a fixed injected clock", () => {
		const run = (): number[] => {
			const scheduler = new FakeScheduler();
			const host = new AnimationHost({ policy: fullPolicy(), scheduler });
			const elapsed: number[] = [];
			host.subscribe((_frame, elapsedMs) => elapsed.push(elapsedMs));
			scheduler.advance(TIER_CADENCE_MS.full * 5 + 1);
			return elapsed;
		};

		const a = run();
		const b = run();
		// Same injected clock → byte-identical elapsed sequence.
		expect(a).toEqual(b);
		expect(a).toHaveLength(5);
		// First frame lands exactly one cadence in; elapsed is strictly increasing.
		expect(a[0]).toBe(TIER_CADENCE_MS.full);
		for (let i = 1; i < a.length; i++) {
			expect(a[i]!).toBeGreaterThan(a[i - 1]!);
		}
	});
});

/** Counts scoped repaint requests without touching a real TUI. */
class CountingHost implements AnimatedWidgetHost {
	renders = 0;
	requestComponentRender(): void {
		this.renders++;
	}
}

class StaticWidget extends AnimatedWidget {
	renderFrame(): readonly string[] {
		return ["static"];
	}
}

class ClockWidget extends AnimatedWidget {
	renderFrame(): readonly string[] {
		// Content changes every frame (phase-dependent), forcing a repaint each tick.
		return [`t=${Math.floor(this.elapsedMs)}`];
	}
}

describe("AnimatedWidget lifecycle", () => {
	it("subscribes on mount and returns the host to zero subscribers on dispose", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const widget = new StaticWidget({ tui: new CountingHost(), host, policy: fullPolicy() });

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);

		// Idempotent: a second dispose is a no-op.
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("never requests a repaint for identical consecutive frames", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const tui = new CountingHost();
		const widget = new StaticWidget({ tui, host, policy: fullPolicy() });

		// Establish width + baseline rows (what the TUI does when it mounts the widget).
		expect(widget.render(80)).toEqual(["static"]);

		scheduler.advance(TIER_CADENCE_MS.full * 5 + 1);
		expect(tui.renders).toBe(0);

		widget.dispose();
	});

	it("requests a scoped repaint each frame when the rendered rows change", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const tui = new CountingHost();
		const widget = new ClockWidget({ tui, host, policy: fullPolicy() });
		widget.render(80);

		scheduler.advance(TIER_CADENCE_MS.full * 4 + 1);
		expect(tui.renders).toBe(4);

		widget.dispose();
	});

	it("renders one static frame and never subscribes when the tier is off", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const tui = new CountingHost();
		const offPolicy = new MotionPolicy(interactiveEnv(), "off");
		const widget = new StaticWidget({ tui, host, policy: offPolicy });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)).toEqual(["static"]);

		scheduler.advance(TIER_CADENCE_MS.full * 5 + 1);
		expect(tui.renders).toBe(0);
	});
});

describe("AnimatedWidget live tier changes", () => {
	it("animates without a remount when the tier changes from off to full", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "off");
		const host = new AnimationHost({ policy, scheduler });
		const tui = new CountingHost();
		const widget = new ClockWidget({ tui, host, policy });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);

		widget.render(80);
		policy.setSetting("full");

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);
		expect(tui.renders).toBe(1);

		widget.render(80);
		scheduler.advance(TIER_CADENCE_MS.full * 4 + 1);
		expect(tui.renders).toBe(5);

		widget.dispose();
	});

	it("stops the clock and settles on one static frame when the tier changes from full to off", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const host = new AnimationHost({ policy, scheduler });
		const tui = new CountingHost();
		const widget = new ClockWidget({ tui, host, policy });

		widget.render(80);
		scheduler.advance(TIER_CADENCE_MS.full * 2 + 1);
		expect(widget.animating).toBe(true);

		const rendersBeforeOff = tui.renders;
		policy.setSetting("off");
		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);
		expect(tui.renders).toBe(rendersBeforeOff + 1);

		const rows = widget.render(80);
		const rendersAfterStaticFrame = tui.renders;
		scheduler.advance(TIER_CADENCE_MS.full * 10 + 1);
		expect(tui.renders).toBe(rendersAfterStaticFrame);
		expect(widget.render(80)).toEqual(rows);

		widget.dispose();
	});

	it("unsubscribes from both host and policy on dispose and stays idempotent", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const widget = new StaticWidget({ tui: new CountingHost(), host, policy });

		expect(policy.listenerCount).toBe(2);
		expect(host.subscriberCount).toBe(1);

		widget.dispose();
		expect(policy.listenerCount).toBe(1);
		expect(host.subscriberCount).toBe(0);

		policy.setSetting("off");
		policy.setSetting("full");
		expect(host.subscriberCount).toBe(0);

		widget.dispose();
		expect(policy.listenerCount).toBe(1);
	});
});

describe("fail-open error boundary", () => {
	it("quarantines a throwing listener without stopping sibling frames", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		let throwerCalls = 0;
		let siblingFrames = 0;
		host.subscribe(() => {
			throwerCalls++;
			throw new Error("broken animation");
		});
		host.subscribe(() => {
			siblingFrames++;
		});

		expect(() => scheduler.advance(TIER_CADENCE_MS.full * 2 + 1)).not.toThrow();
		expect(siblingFrames).toBe(2);
		expect(throwerCalls).toBe(1);
		expect(host.subscriberCount).toBe(1);
	});

	it("stops the shared timer when the last listener is quarantined", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		host.subscribe(() => {
			throw new Error("broken animation");
		});

		expect(() => scheduler.advance(TIER_CADENCE_MS.full + 1)).not.toThrow();
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);
		expect(host.running).toBe(false);
	});

	it("disposes a widget whose frame hook throws", () => {
		class ThrowingWidget extends AnimatedWidget {
			override onFrame(): void {
				throw new Error("broken widget");
			}

			renderFrame(): readonly string[] {
				return ["static"];
			}
		}

		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const tui = new CountingHost();
		const widget = new ThrowingWidget({ tui, host, policy });

		expect(() => scheduler.advance(TIER_CADENCE_MS.full + 1)).not.toThrow();
		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(policy.listenerCount).toBe(1);

		const rendersAfterFailure = tui.renders;
		scheduler.advance(TIER_CADENCE_MS.full * 2 + 1);
		expect(tui.renders).toBe(rendersAfterFailure);
	});
});
