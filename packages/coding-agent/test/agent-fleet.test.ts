import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import {
	type AgentFleetContext,
	AgentFleetController,
	type AgentFleetRegistrySource,
} from "@oh-my-pi/pi-coding-agent/agent-fleet/controller";
import {
	brightnessFor,
	doneBrightness,
	driftSeed,
	FADE_DURATION_MS,
	FAILED_LINGER_MS,
	failedBrightness,
	fireflyGlyph,
	isPrunable,
	restBrightness,
	wobblePhase,
	workingBrightness,
} from "@oh-my-pi/pi-coding-agent/agent-fleet/firefly";
import {
	type AgentFleetRefSource,
	type AgentFleetRegistryEventSource,
	AgentFleetState,
} from "@oh-my-pi/pi-coding-agent/agent-fleet/state";
import {
	type AgentFleetTheme,
	AgentFleetWidget,
	renderAgentFleetOffText,
	renderAgentFleetRow,
} from "@oh-my-pi/pi-coding-agent/agent-fleet/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: AgentFleetTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: AgentFleetTheme = { fg: (color, text) => `${color}:${text}` };

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

function ref(id: string, overrides: Partial<AgentFleetRefSource> = {}): AgentFleetRefSource {
	return { id, displayName: id, kind: "sub", status: "running", ...overrides };
}

function event(
	type: AgentFleetRegistryEventSource["type"],
	id: string,
	overrides: Partial<AgentFleetRefSource> = {},
): AgentFleetRegistryEventSource {
	return { type, ref: ref(id, overrides) };
}

/** In-memory fake registry: mirrors `AgentRegistry.onChange` without touching the real process-global singleton. */
function fakeRegistry(): AgentFleetRegistrySource & {
	emit(evt: AgentFleetRegistryEventSource): void;
	readonly listenerCount: number;
} {
	const listeners = new Set<(evt: AgentFleetRegistryEventSource) => void>();
	return {
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(evt) {
			for (const listener of [...listeners]) listener(evt);
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}

describe("agent fleet firefly math (pure)", () => {
	it("driftSeed is deterministic and varies across ids", () => {
		expect(driftSeed("a1")).toBe(driftSeed("a1"));
		expect(driftSeed("a1")).not.toBe(driftSeed("a2"));
		expect(driftSeed("a1")).toBeGreaterThanOrEqual(0);
		expect(driftSeed("a1")).toBeLessThan(1);
	});

	it("wobblePhase cycles through all three states over one period and is deterministic", () => {
		const samples = Array.from({ length: 40 }, (_, i) => wobblePhase(0.1, i * 50));
		expect(new Set(samples)).toEqual(new Set([-1, 0, 1]));
		expect(wobblePhase(0.1, 500)).toBe(wobblePhase(0.1, 500));
	});

	it("wobblePhase phase-shifts differently seeded fireflies so they don't move in lockstep", () => {
		const seriesA = Array.from({ length: 20 }, (_, i) => wobblePhase(0.05, i * 50));
		const seriesB = Array.from({ length: 20 }, (_, i) => wobblePhase(0.85, i * 50));
		expect(seriesA).not.toEqual(seriesB);
	});

	it("workingBrightness stays in [0.5, 1] and is periodic, not monotonic", () => {
		const samples = Array.from({ length: 40 }, (_, i) => workingBrightness(i * 50));
		for (const s of samples) {
			expect(s).toBeGreaterThanOrEqual(0.5);
			expect(s).toBeLessThanOrEqual(1);
		}
		expect(samples.some((v, i) => i > 0 && v < samples[i - 1])).toBe(true); // comes back down
	});

	it("doneBrightness fades linearly from 1 to 0 over FADE_DURATION_MS and clamps", () => {
		expect(doneBrightness(0)).toBe(1);
		expect(doneBrightness(FADE_DURATION_MS / 2)).toBeCloseTo(0.5, 5);
		expect(doneBrightness(FADE_DURATION_MS)).toBe(0);
		expect(doneBrightness(FADE_DURATION_MS * 2)).toBe(0); // clamps, doesn't go negative
	});

	it("failedBrightness blinks while its envelope decays to zero by FAILED_LINGER_MS", () => {
		expect(failedBrightness(0)).toBeGreaterThan(0);
		expect(failedBrightness(FAILED_LINGER_MS)).toBe(0);
		expect(failedBrightness(FAILED_LINGER_MS * 2)).toBe(0);
		// Blink toggles within a single period near the start (envelope ~1).
		const early = Array.from({ length: 8 }, (_, i) => failedBrightness(i * 50));
		expect(new Set(early).size).toBeGreaterThan(1);
	});

	it("brightnessFor dispatches to the right curve per status", () => {
		expect(brightnessFor("working", 0, 0)).toBe(workingBrightness(0));
		expect(brightnessFor("done", 0, 500)).toBe(doneBrightness(500));
		expect(brightnessFor("failed", 0, 500)).toBe(failedBrightness(500));
	});

	it("restBrightness orders working > failed > done, with no time dependence", () => {
		expect(restBrightness("working")).toBeGreaterThan(restBrightness("failed"));
		expect(restBrightness("failed")).toBeGreaterThan(restBrightness("done"));
	});

	it("isPrunable: working is never prunable; done/failed prune exactly at their duration boundary", () => {
		expect(isPrunable("working", 10 ** 9)).toBe(false);
		expect(isPrunable("done", FADE_DURATION_MS - 1)).toBe(false);
		expect(isPrunable("done", FADE_DURATION_MS)).toBe(true);
		expect(isPrunable("failed", FAILED_LINGER_MS - 1)).toBe(false);
		expect(isPrunable("failed", FAILED_LINGER_MS)).toBe(true);
	});

	it("fireflyGlyph is monotonic non-decreasing along the brightness ramp", () => {
		const samples = [0, 0.3, 0.6, 0.9, 1].map(fireflyGlyph);
		const uniqueInOrder = [...new Set(samples)];
		expect(uniqueInOrder).toEqual([...samples].filter((g, i) => samples.indexOf(g) === i));
		expect(new Set(samples).size).toBeGreaterThan(1);
	});
});

describe("agent fleet state", () => {
	it("ignores registry events for main/advisor kinds", () => {
		const state = new AgentFleetState();
		expect(state.applyRegistryEvent(event("registered", "Main", { kind: "main" }), 0)).toBe(false);
		expect(state.applyRegistryEvent(event("registered", "adv1", { kind: "advisor" }), 0)).toBe(false);
		expect(state.snapshot().fireflies).toHaveLength(0);
	});

	it("a registered sub event adds a firefly stamped with the current clock reading", () => {
		const state = new AgentFleetState();
		expect(state.applyRegistryEvent(event("registered", "a1"), 1000)).toBe(true);
		const snapshot = state.snapshot();
		expect(snapshot.fireflies).toHaveLength(1);
		expect(snapshot.fireflies[0]).toMatchObject({
			id: "a1",
			status: "working",
			spawnedAt: 1000,
			statusChangedAt: 1000,
		});
		expect(snapshot.workingCount).toBe(1);
	});

	it("status_changed transitions working -> done -> failed, resetting statusChangedAt each time", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		expect(state.applyRegistryEvent(event("status_changed", "a1", { status: "idle" }), 500)).toBe(true);
		expect(state.snapshot().fireflies[0]).toMatchObject({ status: "done", statusChangedAt: 500 });
		expect(state.applyRegistryEvent(event("status_changed", "a1", { status: "aborted" }), 900)).toBe(true);
		expect(state.snapshot().fireflies[0]).toMatchObject({ status: "failed", statusChangedAt: 900 });
	});

	it("idle and parked both map to done", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		state.applyRegistryEvent(event("status_changed", "a1", { status: "parked" }), 100);
		expect(state.snapshot().fireflies[0].status).toBe("done");
	});

	it("a status_changed with no matching identical status reports no change", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		expect(state.applyRegistryEvent(event("status_changed", "a1", { status: "running" }), 200)).toBe(false);
	});

	it("status_changed for an unseen id upserts implicitly (recovers from a missed registered event)", () => {
		const state = new AgentFleetState();
		expect(state.applyRegistryEvent(event("status_changed", "a1", { status: "idle" }), 300)).toBe(true);
		expect(state.snapshot().fireflies[0]).toMatchObject({ id: "a1", status: "done" });
	});

	it("removed deletes the firefly immediately, bypassing any fade", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		expect(state.applyRegistryEvent(event("removed", "a1"), 1)).toBe(true);
		expect(state.snapshot().fireflies).toHaveLength(0);
		// removing an id we never tracked is a no-op
		expect(state.applyRegistryEvent(event("removed", "ghost"), 1)).toBe(false);
	});

	it("pruneFireflies removes only fireflies whose fade/blink-out has finished", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		state.applyRegistryEvent(event("status_changed", "a1", { status: "idle" }), 0);
		expect(state.pruneFireflies(FADE_DURATION_MS - 1)).toBe(false);
		expect(state.snapshot().fireflies).toHaveLength(1);
		expect(state.pruneFireflies(FADE_DURATION_MS)).toBe(true);
		expect(state.snapshot().fireflies).toHaveLength(0);
	});

	it("a working firefly is never pruned regardless of elapsed time", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		expect(state.pruneFireflies(10 ** 9)).toBe(false);
		expect(state.snapshot().fireflies).toHaveLength(1);
	});

	it("preserves firefly insertion order and tallies counts by status", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		state.applyRegistryEvent(event("registered", "a2"), 0);
		state.applyRegistryEvent(event("registered", "a3"), 0);
		state.applyRegistryEvent(event("status_changed", "a2", { status: "idle" }), 0);
		state.applyRegistryEvent(event("status_changed", "a3", { status: "aborted" }), 0);
		const snapshot = state.snapshot();
		expect(snapshot.fireflies.map(f => f.id)).toEqual(["a1", "a2", "a3"]);
		expect(snapshot.workingCount).toBe(1);
		expect(snapshot.doneCount).toBe(1);
		expect(snapshot.failedCount).toBe(1);
	});
});

describe("agent fleet rendering (pure)", () => {
	it("is byte-stable across repeated calls with the same snapshot and elapsed time", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		const snapshot = state.snapshot();
		const first = renderAgentFleetRow(snapshot, 500, idTheme, "full");
		const second = renderAgentFleetRow(snapshot, 500, idTheme, "full");
		expect(first).toEqual(second);
	});

	it("renders a placeholder when there are no fireflies", () => {
		const state = new AgentFleetState();
		const rows = renderAgentFleetRow(state.snapshot(), 0, idTheme, "full");
		expect(rows[0]).toContain("no subagents");
	});

	it("full tier pads each firefly into a 3-column wobble cell; subtle tier renders a bare glyph", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		const full = renderAgentFleetRow(state.snapshot(), 0, idTheme, "full")[0];
		const subtle = renderAgentFleetRow(state.snapshot(), 0, idTheme, "subtle")[0];
		expect(full.length).toBe(3);
		expect(subtle.length).toBe(1);
	});

	it("collapses fireflies past the display cap into a '+N' trailer", () => {
		const state = new AgentFleetState();
		for (let i = 0; i < 14; i++) state.applyRegistryEvent(event("registered", `a${i}`), 0);
		const rows = renderAgentFleetRow(state.snapshot(), 0, idTheme, "subtle");
		expect(rows[0]).toContain("+2");
	});

	it("colors working/done/failed fireflies distinctly", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		state.applyRegistryEvent(event("registered", "a2"), 0);
		state.applyRegistryEvent(event("status_changed", "a2", { status: "idle" }), 0);
		state.applyRegistryEvent(event("registered", "a3"), 0);
		state.applyRegistryEvent(event("status_changed", "a3", { status: "aborted" }), 0);
		const row = renderAgentFleetRow(state.snapshot(), 0, taggedTheme, "subtle")[0];
		expect(row).toContain("statusLineSubagents:");
		expect(row).toContain("dim:");
		expect(row).toContain("error:");
	});

	it("full tier animates brightness over time (working firefly's glyph changes across the breathing cycle)", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		const snapshot = state.snapshot();
		const samples = new Set(
			Array.from({ length: 10 }, (_, i) => renderAgentFleetRow(snapshot, i * 100, idTheme, "full")[0]),
		);
		expect(samples.size).toBeGreaterThan(1);
	});

	it("subtle tier never animates — rendering is identical across elapsed times", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		const snapshot = state.snapshot();
		const a = renderAgentFleetRow(snapshot, 0, idTheme, "subtle");
		const b = renderAgentFleetRow(snapshot, 5000, idTheme, "subtle");
		expect(a).toEqual(b);
	});

	it("off-tier text tallies by bucket, omitting empty buckets, or reports 'no subagents'", () => {
		const empty = new AgentFleetState();
		expect(renderAgentFleetOffText(empty.snapshot(), idTheme)).toBe("no subagents");

		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		state.applyRegistryEvent(event("registered", "a2"), 0);
		state.applyRegistryEvent(event("status_changed", "a2", { status: "idle" }), 0);
		expect(renderAgentFleetOffText(state.snapshot(), idTheme)).toBe("1 working · 1 done");
	});
});

describe("agent fleet widget lifecycle", () => {
	it("subscribes on mount, prunes finished fireflies via onFrame, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		state.applyRegistryEvent(event("status_changed", "a1", { status: "idle" }), 0);
		const widget = new AgentFleetWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);
		expect(state.snapshot().fireflies).toHaveLength(1);

		widget.render(80);
		scheduler.advance(FADE_DURATION_MS); // onFrame prunes the finished firefly
		expect(state.snapshot().fireflies).toHaveLength(0);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new AgentFleetState();
		state.applyRegistryEvent(event("registered", "a1"), 0);
		const widget = new AgentFleetWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).not.toBe("");
	});
});

describe("agent fleet controller", () => {
	function recordingContext(overrides: Partial<AgentFleetContext> = {}): {
		ctx: AgentFleetContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: AgentFleetContext = {
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

	it("watch() subscribes exactly once to the registry, and stays dormant with no UI surface", () => {
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry });
		const { ctx } = recordingContext({ hasUI: false });
		controller.watch(ctx);
		expect(controller.watching).toBe(false);
		expect(registry.listenerCount).toBe(0);

		const { ctx: uiCtx } = recordingContext();
		controller.watch(uiCtx);
		controller.watch(uiCtx); // idempotent
		expect(controller.watching).toBe(true);
		expect(registry.listenerCount).toBe(1);
	});

	it("mounts an animated widget on the first sub-agent registered event, ignoring main/advisor", () => {
		const scheduler = manualScheduler();
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry, scheduler });
		const { ctx, calls } = recordingContext();
		controller.watch(ctx);

		registry.emit(event("registered", "Main", { kind: "main" }));
		expect(calls).toHaveLength(0);

		registry.emit(event("registered", "a1"));
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: AgentFleetTheme) => AgentFleetWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);
	});

	it("status_changed mutates state in place without remounting an already-animated widget", () => {
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry });
		const { ctx, calls } = recordingContext();
		controller.watch(ctx);

		registry.emit(event("registered", "a1"));
		registry.emit(event("status_changed", "a1", { status: "idle" }));
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().fireflies[0].status).toBe("done");
	});

	it("renders and updates a static tally line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry, scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });
		controller.watch(ctx);

		registry.emit(event("registered", "a1"));
		expect(calls[0].content).toEqual(["1 working"]);
		expect(scheduler.running).toBe(false);

		registry.emit(event("status_changed", "a1", { status: "idle" }));
		expect(calls[calls.length - 1].content).toEqual(["1 done"]);
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry });
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });
		controller.watch(ctx);

		registry.emit(event("registered", "a1"));
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("dispose unsubscribes from the registry and tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry, scheduler });
		const { ctx, calls } = recordingContext();
		controller.watch(ctx);

		registry.emit(event("registered", "a1"));
		const factory = calls[0].content as (tui: typeof noopTui, theme: AgentFleetTheme) => AgentFleetWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);
		expect(registry.listenerCount).toBe(1);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
		expect(registry.listenerCount).toBe(0);
		expect(controller.watching).toBe(false);

		// further registry events after dispose are ignored — no leaked subscription
		registry.emit(event("registered", "a2"));
		expect(calls).toHaveLength(2); // mount + the dispose's own undefined-content call, nothing more
	});

	it("dispose is a no-op when never mounted", () => {
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry });
		const { ctx, calls } = recordingContext();
		controller.dispose(ctx);
		expect(calls).toHaveLength(0);
	});
});
