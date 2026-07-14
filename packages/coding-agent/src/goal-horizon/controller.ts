import type { BackpressureSignal, FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { GoalUpdatedEvent } from "../extensibility/shared-events";
import { GoalHorizonState } from "./state";
import { type GoalHorizonTheme, GoalHorizonWidget, renderGoalHorizonOffText } from "./widget";

const WIDGET_KEY = "goal-horizon";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface GoalHorizonContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: GoalHorizonTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "static" };

/**
 * The {@link AnimationHost} backpressure field must be wired at construction,
 * before the widget factory supplies the real `tui` — this adapter lets the
 * host read a live signal once {@link attach} runs from inside that factory.
 */
function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: Pick<TUI, "renderUnderPressure">): void } {
	let live: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return live?.underPressure ?? false;
			},
		},
		attach(tui) {
			live = backpressureFromTui(tui);
		},
	};
}

/**
 * Drives Goal Horizon: reads `Goal`/`GoalModeState` off every `goal_updated`
 * event (`extensibility/shared-events.ts`) — emitted by `GoalRuntime`
 * roughly once per tool call while a `/goal` is active (see
 * `goals/runtime.ts`'s `#commitState`) — into a sunrise-gradient bar of
 * `tokensUsed / tokenBudget`, with a synthetic milestone flare at
 * 25/50/75/100% crossed. Mounts on the first `goal_updated` event seen this
 * session (which always carries a real goal — the runtime never emits a
 * bare `null` before some accounting state has been created). Motion gating
 * goes through the kit's {@link MotionPolicy}; a resolved tier of `off`
 * renders the bead's "🌅 objective NN% (used/budget tok)" static line
 * instead of an animated widget, repainted directly on each event since
 * there is no frame clock in that mode.
 */
export class GoalHorizonController {
	#scheduler: FrameScheduler;
	#state = new GoalHorizonState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): GoalHorizonState {
		return this.#state;
	}

	onGoalUpdated(event: GoalUpdatedEvent, ctx: GoalHorizonContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyGoal(event.goal, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderGoalHorizonOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<GoalHorizonContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: GoalHorizonContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderGoalHorizonOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new GoalHorizonWidget({ tui, host, policy, state, theme, clock });
			},
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
}
