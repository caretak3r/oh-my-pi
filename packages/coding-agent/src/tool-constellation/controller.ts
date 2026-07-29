import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { ToolCallEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
import { ConstellationState } from "./state";
import { type ConstellationTheme, renderConstellationTally, ToolConstellationWidget } from "./widget";

const WIDGET_KEY = "tool-constellation";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "belowEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface ToolConstellationContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: ConstellationTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "static" };

/**
 * Drives the tool-activity star map: mounts once, on the first `tool_call`
 * seen this session, and keeps a single shared {@link ConstellationState} for
 * the rest of the session (stars spawn lazily per tool the session actually
 * uses, so an idle session stays an empty sky). Motion gating goes through
 * the kit's {@link MotionPolicy}; a resolved tier of `off` (setting off,
 * non-TTY, `NO_COLOR`/`CI`/dumb terminal) renders a single static tally line
 * instead of an animated widget and repaints it directly on every fire —
 * there is no frame clock in that mode to pick the change up on its own.
 *
 * Fire timestamps and the widget's render clock both read the same injected
 * {@link FrameScheduler}, not the {@link AnimationHost}'s internal relative
 * clock — the host only drives repaint cadence here, so star decay math stays
 * correct regardless of exactly when the UI layer invokes the widget factory.
 */
export class ToolConstellationController {
	#scheduler: FrameScheduler;
	#state = new ConstellationState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): ConstellationState {
		return this.#state;
	}

	onToolCall(event: ToolCallEvent, ctx: ToolConstellationContext): void {
		if (!ctx.hasUI) return;
		this.#state.recordFire(event.toolName, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationTally(this.#state.categoryCounts(), ctx.theme)], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Clear the live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<ToolConstellationContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: ToolConstellationContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationTally(this.#state.categoryCounts(), ctx.theme)], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new ToolConstellationWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}
}
