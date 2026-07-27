import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { AgentEndEvent, AgentStartEvent, TurnEndEvent, TurnStartEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
import { BreathingBorderState } from "./state";
import { type BreathingBorderTheme, BreathingBorderWidget, renderBreathingBorderOffText } from "./widget";

const WIDGET_KEY = "breathing-border";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface BreathingBorderContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: BreathingBorderTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "off" } | { mode: "animated"; host: AnimationHost; owned: false } | { mode: "settled" };

/**
 * Drives the breathing border: `agent_start` (re)starts the continuous
 * inhale/exhale cycle, `agent_end` fires the single wind-down exhale, and
 * `turn_start`/`turn_end` modulate the breath cadence from the just-finished
 * turn's duration. Mounts on the first `agent_start` (or `agent_end`, in the
 * unlikely case it fires first) seen this session.
 *
 * Motion gating goes through the shared kit's {@link MotionPolicy}; a
 * resolved tier of `off` renders a fixed static border instead of an
 * animated widget. Once the wind-down exhale settles into `idle` (the
 * `BreathingBorderState.settleIfDone` transition, surfaced via the widget's
 * `onSettled` callback), the controller replaces the widget with the same
 * static row. The UI disposes the old widget subscription while the shared
 * session host remains available to sibling animations. A later
 * `agent_start` remounts fresh.
 */
export class BreathingBorderController {
	#scheduler: FrameScheduler;
	#state = new BreathingBorderState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): BreathingBorderState {
		return this.#state;
	}

	onAgentStart(_event: AgentStartEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyAgentStart(this.#scheduler.now());
		if (this.#mount === undefined || this.#mount.mode === "settled") {
			this.#mount = this.#mountWidget(ctx);
		}
	}

	onAgentEnd(_event: AgentEndEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyAgentEnd(this.#scheduler.now());
		if (this.#mount === undefined) {
			this.#mount = this.#mountWidget(ctx);
		}
	}

	onTurnStart(event: TurnStartEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyTurnStart(event.turnIndex, this.#scheduler.now());
	}

	onTurnEnd(event: TurnEndEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyTurnEnd(event.turnIndex, this.#scheduler.now());
	}

	/** Clear any live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<BreathingBorderContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: BreathingBorderContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderBreathingBorderOffText(ctx.theme)], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		const onSettled = () => this.#teardownToStatic(ctx, host);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new BreathingBorderWidget({ tui, host, policy, state, theme, clock, onSettled }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}

	/** Fires once, from the widget's `onSettled` callback, on the `exhaling` -> `idle` transition. Guards against a stale callback from an already-superseded mount (e.g. a fresh `agent_start` remounted before this one settled). */
	#teardownToStatic(ctx: Pick<BreathingBorderContext, "setWidget" | "theme">, host: AnimationHost): void {
		if (this.#mount?.mode !== "animated" || this.#mount.host !== host) return;
		if (this.#mount.owned) host.dispose();
		this.#mount = { mode: "settled" };
		ctx.setWidget(WIDGET_KEY, [renderBreathingBorderOffText(ctx.theme)], WIDGET_OPTIONS);
	}
}
