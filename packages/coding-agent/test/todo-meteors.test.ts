import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { TodoReminderEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type TodoMeteorsContext, TodoMeteorsController } from "@oh-my-pi/pi-coding-agent/todo-meteors/controller";
import {
	combineBrightness,
	emberGlyph,
	emberRestBrightness,
	METEOR_ARC_DURATION_MS,
	meteorColumn,
	meteorDone,
	meteorGlyph,
	meteorProgress,
	urgencyPulse,
} from "@oh-my-pi/pi-coding-agent/todo-meteors/ember";
import { type TodoMeteorPhaseSource, TodoMeteorState } from "@oh-my-pi/pi-coding-agent/todo-meteors/state";
import {
	renderTodoMeteorsOffText,
	renderTodoMeteorsRow,
	type TodoMeteorsTheme,
	TodoMeteorsWidget,
} from "@oh-my-pi/pi-coding-agent/todo-meteors/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: TodoMeteorsTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: TodoMeteorsTheme = { fg: (color, text) => `${color}:${text}` };

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

function phases(
	...tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned" }>
): TodoMeteorPhaseSource[] {
	return [{ name: "Phase 1", tasks }];
}

describe("todo meteors ember/meteor math (pure)", () => {
	it("meteorProgress is 0 before launch, ramps linearly, and clamps at 1", () => {
		expect(meteorProgress(1000, 500)).toBe(0);
		expect(meteorProgress(1000, 1000)).toBe(0);
		expect(meteorProgress(1000, 1000 + METEOR_ARC_DURATION_MS / 2)).toBeCloseTo(0.5, 5);
		expect(meteorProgress(1000, 1000 + METEOR_ARC_DURATION_MS)).toBe(1);
		expect(meteorProgress(1000, 10_000)).toBe(1);
	});

	it("meteorDone flips exactly at the arc duration boundary", () => {
		expect(meteorDone(0, METEOR_ARC_DURATION_MS - 1)).toBe(false);
		expect(meteorDone(0, METEOR_ARC_DURATION_MS)).toBe(true);
		expect(meteorDone(0, METEOR_ARC_DURATION_MS + 1)).toBe(true);
	});

	it("meteorGlyph and meteorColumn are monotonic along the arc", () => {
		const glyphs = [0, 0.4, 0.8, 1].map(meteorGlyph);
		const uniqueInOrder = [...new Set(glyphs)];
		expect(uniqueInOrder).toEqual([...glyphs].filter((g, i) => glyphs.indexOf(g) === i));
		expect(new Set(glyphs).size).toBeGreaterThan(1);

		expect(meteorColumn(0, 10)).toBe(0);
		expect(meteorColumn(1, 10)).toBe(9); // clamps inside the lane, never runs off the end
		expect(meteorColumn(0.5, 10)).toBeGreaterThan(meteorColumn(0.1, 10));
	});

	it("emberRestBrightness reads in_progress brighter than pending — the priority proxy since TodoItem carries no priority field", () => {
		expect(emberRestBrightness("in_progress")).toBeGreaterThan(emberRestBrightness("pending"));
	});

	it("urgencyPulse is 0 with no reminder pressure and rises with attempt/maxAttempts", () => {
		expect(urgencyPulse(0, 3, 500)).toBe(0);
		expect(urgencyPulse(1, 0, 500)).toBe(0);
		// Sample across a full period and take the peak: higher attempt pressure raises the ceiling.
		const peak = (attempt: number, maxAttempts: number) =>
			Math.max(...Array.from({ length: 20 }, (_, i) => urgencyPulse(attempt, maxAttempts, i * 25)));
		expect(peak(3, 3)).toBeGreaterThan(peak(1, 3));
	});

	it("urgencyPulse is periodic, not monotonically increasing over time", () => {
		const samples = Array.from({ length: 40 }, (_, i) => urgencyPulse(2, 3, i * 25));
		expect(Math.max(...samples)).toBeGreaterThan(Math.min(...samples.filter(v => v > 0)) - 1);
		expect(samples.some((v, i) => i > 0 && v < samples[i - 1])).toBe(true); // it comes back down
	});

	it("combineBrightness only ever brightens, never dims below the resting level", () => {
		expect(combineBrightness(0.4, 0)).toBe(0.4);
		expect(combineBrightness(0.4, 1)).toBe(1);
		expect(combineBrightness(1, 1)).toBe(1);
		expect(combineBrightness(0.4, 0.5)).toBeGreaterThan(0.4);
	});

	it("emberGlyph is monotonic non-decreasing along the brightness ramp", () => {
		const samples = [0, 0.3, 0.6, 0.9, 1].map(emberGlyph);
		const uniqueInOrder = [...new Set(samples)];
		expect(uniqueInOrder).toEqual([...samples].filter((g, i) => samples.indexOf(g) === i));
		expect(new Set(samples).size).toBeGreaterThan(1);
	});
});

describe("todo meteors state", () => {
	it("derives embers from pending/in_progress tasks only, excluding completed and abandoned", () => {
		const state = new TodoMeteorState();
		state.applyPhases(
			phases(
				{ content: "a", status: "pending" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "completed" },
				{ content: "d", status: "abandoned" },
			),
			[],
			0,
		);
		const snapshot = state.snapshot();
		expect(snapshot.embers.map(e => e.content)).toEqual(["a", "b"]);
		expect(snapshot.doneCount).toBe(1);
		expect(snapshot.totalCount).toBe(4);
	});

	it("a completedTasks transition spawns exactly one meteor and removes the ember", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }, { content: "b", status: "pending" }), [], 0);
		expect(state.snapshot().embers).toHaveLength(2);

		state.applyPhases(
			phases({ content: "a", status: "completed" }, { content: "b", status: "pending" }),
			[{ phase: "Phase 1", content: "a" }],
			1000,
		);
		const snapshot = state.snapshot();
		expect(snapshot.embers.map(e => e.content)).toEqual(["b"]);
		expect(snapshot.meteors).toHaveLength(1);
		expect(snapshot.meteors[0]).toMatchObject({ content: "a", launchedAt: 1000 });
	});

	it("a task that disappears WITHOUT a completedTasks entry (abandoned/removed) is dropped silently, no meteor", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }, { content: "b", status: "pending" }), [], 0);
		state.applyPhases(phases({ content: "b", status: "abandoned" }), [], 1000);
		const snapshot = state.snapshot();
		expect(snapshot.embers).toHaveLength(0);
		expect(snapshot.meteors).toHaveLength(0);
	});

	it("pruneMeteors removes only meteors whose arc has finished by elapsedMs", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "completed" }), [{ phase: "Phase 1", content: "a" }], 0);
		expect(state.pruneMeteors(METEOR_ARC_DURATION_MS - 1)).toBe(false);
		expect(state.snapshot().meteors).toHaveLength(1);
		expect(state.pruneMeteors(METEOR_ARC_DURATION_MS)).toBe(true);
		expect(state.snapshot().meteors).toHaveLength(0);
	});

	it("applyReminder records attempt/maxAttempts and reports whether it changed", () => {
		const state = new TodoMeteorState();
		expect(state.applyReminder(1, 3)).toBe(true);
		expect(state.snapshot()).toMatchObject({ attempt: 1, maxAttempts: 3 });
		expect(state.applyReminder(1, 3)).toBe(false); // identical reading: no change
		expect(state.applyReminder(2, 3)).toBe(true);
	});

	it("preserves ember insertion order across updates rather than reshuffling on status change", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }, { content: "b", status: "pending" }), [], 0);
		state.applyPhases(phases({ content: "a", status: "pending" }, { content: "b", status: "in_progress" }), [], 100);
		expect(state.snapshot().embers.map(e => e.content)).toEqual(["a", "b"]);
	});
});

describe("todo meteors rendering (pure)", () => {
	it("is byte-stable across repeated calls with the same snapshot and elapsed time", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }), [], 0);
		const snapshot = state.snapshot();
		const first = renderTodoMeteorsRow(snapshot, 500, idTheme, "full");
		const second = renderTodoMeteorsRow(snapshot, 500, idTheme, "full");
		expect(first).toEqual(second);
	});

	it("renders a placeholder when there are no open todos", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases(), [], 0);
		const rows = renderTodoMeteorsRow(state.snapshot(), 0, idTheme, "full");
		expect(rows[0]).toContain("no open todos");
	});

	it("full tier draws a meteor lane when a meteor is in flight; subtle tier never does", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "completed" }), [{ phase: "Phase 1", content: "a" }], 0);
		const full = renderTodoMeteorsRow(state.snapshot(), 100, idTheme, "full");
		const subtle = renderTodoMeteorsRow(state.snapshot(), 100, idTheme, "subtle");
		expect(full).toHaveLength(2);
		expect(subtle).toHaveLength(1);
	});

	it("the meteor lane clears once the arc finishes and pruneMeteors has run", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "completed" }), [{ phase: "Phase 1", content: "a" }], 0);
		state.pruneMeteors(METEOR_ARC_DURATION_MS);
		const rows = renderTodoMeteorsRow(state.snapshot(), METEOR_ARC_DURATION_MS, idTheme, "full");
		expect(rows).toHaveLength(1); // no meteor line once nothing is in flight
	});

	it("collapses embers past the display cap into a '+N' trailer", () => {
		const state = new TodoMeteorState();
		state.applyPhases(
			phases(...Array.from({ length: 14 }, (_, i) => ({ content: `t${i}`, status: "pending" as const }))),
			[],
			0,
		);
		const rows = renderTodoMeteorsRow(state.snapshot(), 0, idTheme, "subtle");
		expect(rows[0]).toContain("+2");
	});

	it("colors an in_progress ember differently from a pending one — the priority ordering proxy", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }, { content: "b", status: "in_progress" }), [], 0);
		const rows = renderTodoMeteorsRow(state.snapshot(), 0, taggedTheme, "subtle");
		expect(rows[0]).toContain("dim:");
		expect(rows[0]).toContain("accent:");
	});

	it("urgency pulse brightens an ember's glyph as attempt rises, at full tier only", () => {
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }), [], 0);
		state.applyReminder(3, 3);
		// Sample near the pulse peak (a quarter into its period) so the comparison isn't a coin flip.
		const withUrgency = renderTodoMeteorsRow(state.snapshot(), 125, idTheme, "full")[0];
		const noUrgency = renderTodoMeteorsRow(state.snapshot(), 125, idTheme, "subtle")[0]; // subtle never applies the pulse
		expect(withUrgency).not.toEqual(noUrgency);
	});

	it("off-tier text reports 'N/M done', or 'no todos' before anything is tracked", () => {
		const empty = new TodoMeteorState();
		expect(renderTodoMeteorsOffText(empty.snapshot())).toBe("no todos");

		const state = new TodoMeteorState();
		state.applyPhases(
			phases(
				{ content: "a", status: "completed" },
				{ content: "b", status: "pending" },
				{ content: "c", status: "in_progress" },
			),
			[],
			0,
		);
		expect(renderTodoMeteorsOffText(state.snapshot())).toBe("1/3 done");
	});
});

describe("todo meteors widget lifecycle", () => {
	it("subscribes on mount, prunes finished meteors via onFrame, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "completed" }), [{ phase: "Phase 1", content: "a" }], 0);
		const widget = new TodoMeteorsWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);
		expect(state.snapshot().meteors).toHaveLength(1);

		const initial = widget.render(80);
		expect(initial).toHaveLength(2); // meteor lane present

		scheduler.advance(METEOR_ARC_DURATION_MS); // onFrame prunes the finished meteor
		expect(state.snapshot().meteors).toHaveLength(0);
		const after = widget.render(80);
		expect(after).not.toEqual(initial);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new TodoMeteorState();
		state.applyPhases(phases({ content: "a", status: "pending" }), [], 0);
		const widget = new TodoMeteorsWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).not.toBe(""); // one ember glyph rendered, off tier never subscribes
	});
});

describe("todo meteors controller", () => {
	function recordingContext(overrides: Partial<TodoMeteorsContext> = {}): {
		ctx: TodoMeteorsContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: TodoMeteorsContext = {
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

	function toolResult(details: unknown, overrides: Record<string, unknown> = {}): ToolResultEvent {
		return {
			type: "tool_result",
			toolCallId: "tc1",
			toolName: "todo",
			input: {},
			content: [],
			isError: false,
			details,
			...overrides,
		} as ToolResultEvent;
	}

	function reminder(attempt: number, maxAttempts: number): TodoReminderEvent {
		return { type: "todo_reminder", todos: [], attempt, maxAttempts };
	}

	it("mounts an animated widget on the first valid todo tool_result and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new TodoMeteorsController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }],
				storage: "session",
			}),
			ctx,
		);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: TodoMeteorsTheme) => TodoMeteorsWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "completed" }] }],
				storage: "session",
				completedTasks: [{ phase: "Phase 1", content: "a" }],
			}),
			ctx,
		);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().meteors).toHaveLength(1);
	});

	it("ignores tool_result events for other tools, errored todo results, and malformed details", () => {
		const controller = new TodoMeteorsController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(toolResult({ phases: [] }, { toolName: "bash" }), ctx);
		controller.onToolResult(toolResult({ phases: [] }, { isError: true }), ctx);
		controller.onToolResult(toolResult({ not: "phases" }), ctx);
		expect(calls).toHaveLength(0);
	});

	it("todo_reminder updates urgency without remounting an already-animated widget", () => {
		const controller = new TodoMeteorsController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }],
				storage: "session",
			}),
			ctx,
		);
		controller.onTodoReminder(reminder(2, 3), ctx);
		expect(calls).toHaveLength(1); // still just the one mount call
		expect(controller.state.snapshot()).toMatchObject({ attempt: 2, maxAttempts: 3 });
	});

	it("renders and updates a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new TodoMeteorsController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }],
				storage: "session",
			}),
			ctx,
		);
		expect((calls[0].content as string[])[0]).toBe("0/1 done"); // state.applyPhases already ran before the mount-time render
		expect(scheduler.running).toBe(false);

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "completed" }] }],
				storage: "session",
				completedTasks: [{ phase: "Phase 1", content: "a" }],
			}),
			ctx,
		);
		expect((calls[calls.length - 1].content as string[])[0]).toBe("1/1 done");
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new TodoMeteorsController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }],
				storage: "session",
			}),
			ctx,
		);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new TodoMeteorsController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }],
				storage: "session",
			}),
			ctx,
		);
		controller.onTodoReminder(reminder(1, 3), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new TodoMeteorsController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			toolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }],
				storage: "session",
			}),
			ctx,
		);
		const factory = calls[0].content as (tui: typeof noopTui, theme: TodoMeteorsTheme) => TodoMeteorsWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});

	it("dispose is idempotent and a pre-mount dispose is a no-op", () => {
		const controller = new TodoMeteorsController();
		const { ctx, calls } = recordingContext();

		// Never mounted — dispose must not call setWidget at all.
		controller.dispose(ctx);
		expect(calls).toHaveLength(0);

		controller.onToolResult(
			toolResult({ phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }] }),
			ctx,
		);
		controller.dispose(ctx);
		const afterFirstDispose = calls.length;
		controller.dispose(ctx);
		expect(calls).toHaveLength(afterFirstDispose);
	});

	it("remounts after dispose on the next event rather than staying dormant", () => {
		const controller = new TodoMeteorsController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			toolResult({ phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }] }),
			ctx,
		);
		controller.dispose(ctx);
		const beforeRemount = calls.length;
		controller.onToolResult(
			toolResult({ phases: [{ name: "Phase 1", tasks: [{ content: "b", status: "pending" }] }] }),
			ctx,
		);
		expect(calls.length).toBeGreaterThan(beforeRemount);
		expect(calls[calls.length - 1].content).not.toBeUndefined();
	});
});

describe("todo meteors hardening edge cases", () => {
	it("meteorGlyph and emberGlyph fall back to the dimmest glyph for NaN rather than rendering undefined", () => {
		expect(meteorGlyph(Number.NaN)).toBe(meteorGlyph(0));
		expect(emberGlyph(Number.NaN)).toBe(emberGlyph(0));
	});

	it("meteorProgress and meteorDone propagate NaN for a non-finite launch timestamp rather than throwing", () => {
		expect(Number.isNaN(meteorProgress(Number.NaN, 100))).toBe(true);
		// NaN comparisons are always false, so a NaN-launched meteor is never
		// reported done — it would linger forever rather than crash; pruneMeteors
		// (state.ts) is unaffected in practice since launchedAt is always a real
		// scheduler reading, never a caller-supplied NaN.
		expect(meteorDone(Number.NaN, 100)).toBe(false);
	});

	it("meteorColumn clamps to 0 for non-positive/fractional widths and never throws", () => {
		expect(meteorColumn(0.5, 0)).toBe(0);
		expect(meteorColumn(0.5, -5)).toBe(0);
	});

	it("meteorColumn is NaN for NaN progress, which drops the meteor from the rendered lane rather than corrupting it", () => {
		const column = meteorColumn(Number.NaN, 24);
		expect(Number.isNaN(column)).toBe(true);
		const lane = new Array<string>(24).fill(" ");
		lane[column] = meteorGlyph(Number.NaN);
		// Assigning at a NaN key lands on a non-index property, invisible to join().
		expect(lane.join("")).toBe(" ".repeat(24));
	});

	it("urgencyPulse is 0 for negative attempt/maxAttempts and clamps pressure above 1 rather than exceeding it", () => {
		expect(urgencyPulse(-1, 3, 0)).toBe(0);
		expect(urgencyPulse(3, -1, 0)).toBe(0);
		expect(urgencyPulse(999, 3, 0)).toBeLessThanOrEqual(1);
	});

	it("urgencyPulse and combineBrightness produce a finite, glyph-safe result even for a NaN elapsed clock", () => {
		const pulse = urgencyPulse(1, 3, Number.NaN);
		expect(Number.isNaN(pulse)).toBe(true);
		const combined = combineBrightness(emberRestBrightness("pending"), pulse);
		expect(Number.isNaN(combined)).toBe(true);
		// The NaN flows all the way to emberGlyph, but the fallback above keeps
		// this from ever rendering the literal string "undefined".
		expect(emberGlyph(combined)).toBe(emberGlyph(0));
	});

	it("applyPhases on an empty phase list clears every ember and reports done/total as 0", () => {
		const state = new TodoMeteorState();
		state.applyPhases([{ name: "Phase 1", tasks: [{ content: "a", status: "pending" }] }], [], 0);
		const changed = state.applyPhases([], [], 100);
		expect(changed).toBe(true);
		const snap = state.snapshot();
		expect(snap.embers).toHaveLength(0);
		expect(snap.doneCount).toBe(0);
		expect(snap.totalCount).toBe(0);
	});

	it("a completedTasks entry with no matching open ember still spawns a meteor (no crash on delete-miss)", () => {
		const state = new TodoMeteorState();
		const changed = state.applyPhases([], [{ phase: "Phase 1", content: "ghost" }], 0);
		expect(changed).toBe(true);
		expect(state.snapshot().meteors).toHaveLength(1);
	});

	it("pruneMeteors on an already-empty meteor list is a no-op that reports no change", () => {
		const state = new TodoMeteorState();
		expect(state.pruneMeteors(1_000_000)).toBe(false);
	});

	it("renderTodoMeteorsRow tolerates a snapshot with meteors but zero embers and zero total count", () => {
		const state = new TodoMeteorState();
		state.applyPhases([], [{ phase: "Phase 1", content: "a" }], 0);
		const lines = renderTodoMeteorsRow(state.snapshot(), 100, idTheme, "full");
		expect(lines[0]).toBe("(no open todos)");
		expect(renderTodoMeteorsOffText(state.snapshot())).toBe("no todos");
	});
});
