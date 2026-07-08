import type { FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { TodoReminderEvent, ToolResultEvent } from "../extensibility/extensions/types";
import { type TodoMeteorCompletionSource, type TodoMeteorPhaseSource, TodoMeteorState } from "./state";
import { renderTodoMeteorsOffText, type TodoMeteorsTheme, TodoMeteorsWidget } from "./widget";

const WIDGET_KEY = "todo-meteors";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/** The subset of the `todo` tool's result `details` this controller reads. `details` is typed `unknown` on the shared `tool_result` event for non-builtin tools, so this is narrowed at runtime by {@link readTodoDetails}. */
interface TodoToolResultDetailsSource {
	readonly phases: readonly TodoMeteorPhaseSource[];
	readonly completedTasks?: readonly TodoMeteorCompletionSource[];
}

/** Narrow a `tool_result` event's `details` to the `todo` tool's own shape. Runtime guard mirrors the check the engine itself uses before calling `setTodoPhases` (`agent-session.ts`: `Array.isArray(details?.phases)`). */
function readTodoDetails(details: unknown): TodoToolResultDetailsSource | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = details as { phases?: unknown; completedTasks?: unknown };
	if (!Array.isArray(candidate.phases)) return undefined;
	return {
		phases: candidate.phases as TodoMeteorPhaseSource[],
		completedTasks: Array.isArray(candidate.completedTasks)
			? (candidate.completedTasks as TodoMeteorCompletionSource[])
			: undefined,
	};
}

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface TodoMeteorsContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: TodoMeteorsTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "static" };

/**
 * Drives Todo Meteors: reads the authoritative phase list — and the engine's
 * own completion diff — off every successful `todo` tool `tool_result`, and
 * layers reminder pressure from `todo_reminder` (`attempt`/`maxAttempts`) on
 * top as an urgency pulse. Mounts on the first such event seen this session.
 * Motion gating goes through the kit's {@link MotionPolicy}; a resolved tier
 * of `off` renders the bead's `N/M done` static line instead of an animated
 * widget, repainted directly on each event since there is no frame clock in
 * that mode.
 *
 * Completions come from the `todo` tool's own `details.completedTasks` —
 * populated by the engine's `getCompletionTransitions` diff — rather than
 * this controller re-diffing phases itself: that diff is already the ground
 * truth the internal strike-through UI relies on, so reusing it avoids a
 * second, possibly-diverging notion of "just completed". `todo_reminder`'s
 * own `todos` array is deliberately NOT used as the ember source: the engine
 * filters it to `pending`/`in_progress` tasks only, and only emits it when
 * the agent stops with incomplete work — a session where every todo
 * completes without ever triggering a nag would never populate a single
 * ember if that were the sole signal.
 */
export class TodoMeteorsController {
	#scheduler: FrameScheduler;
	#state = new TodoMeteorState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): TodoMeteorState {
		return this.#state;
	}

	onToolResult(event: ToolResultEvent, ctx: TodoMeteorsContext): void {
		if (event.toolName !== "todo" || event.isError) return;
		const details = readTodoDetails(event.details);
		if (!details) return;
		this.#handleEvent(ctx, () =>
			this.#state.applyPhases(details.phases, details.completedTasks ?? [], this.#scheduler.now()),
		);
	}

	onTodoReminder(event: TodoReminderEvent, ctx: TodoMeteorsContext): void {
		this.#handleEvent(ctx, () => this.#state.applyReminder(event.attempt, event.maxAttempts));
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<TodoMeteorsContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#handleEvent(ctx: TodoMeteorsContext, apply: () => boolean): void {
		if (!ctx.hasUI) return;
		const changed = apply();
		// Prune eagerly on every event too, not just per animated frame: the
		// static/off tier has no frame clock to pick a finished meteor up on
		// its own, and this keeps state.snapshot() honest for tests either way.
		this.#state.pruneMeteors(this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static" && changed) {
			ctx.setWidget(WIDGET_KEY, [renderTodoMeteorsOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	#mountWidget(ctx: TodoMeteorsContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderTodoMeteorsOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const host = new AnimationHost({ policy, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new TodoMeteorsWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
}
