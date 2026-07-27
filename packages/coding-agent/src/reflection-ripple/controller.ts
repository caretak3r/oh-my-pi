import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { TtsrTriggeredEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
import { ReflectionRippleState } from "./state";
import { type ReflectionRippleTheme, ReflectionRippleWidget, renderReflectionRippleOffText } from "./widget";

const WIDGET_KEY = "reflection-ripple";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface ReflectionRippleContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: ReflectionRippleTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "off" };

/**
 * Drives Reflection Ripple: each `ttsr_triggered` event — TTSR interrupting
 * generation to inject a matched rule, see `agent-session.ts`'s
 * `#handleTtsrMatches` — (re)starts a single expanding-and-fading ripple plus
 * a "taking a breath" dim, both driven off the shared clock rather than the
 * event's own state. Mounts fresh on the first trigger seen this session (or
 * a later one, if a prior ripple already fully settled and tore its mount
 * down). Motion gating goes through the shared kit's {@link MotionPolicy}; a
 * resolved tier of `off` instead renders a static line naming the matched
 * rule(s), refreshed on each trigger. Once the ripple settles (the
 * `ReflectionRippleState.settleIfDone` transition, surfaced via the widget's
 * `onSettled` callback), the controller removes the widget entirely. The UI
 * drops that subscription while the shared session host remains available
 * to siblings. A later trigger remounts fresh.
 */
export class ReflectionRippleController {
	#scheduler: FrameScheduler;
	#state = new ReflectionRippleState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): ReflectionRippleState {
		return this.#state;
	}

	onTtsrTriggered(event: TtsrTriggeredEvent, ctx: ReflectionRippleContext): void {
		if (!ctx.hasUI) return;
		const ruleNames = event.rules.map(rule => rule.name);
		this.#state.applyTrigger(ruleNames, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "off") {
			ctx.setWidget(WIDGET_KEY, [renderReflectionRippleOffText(ruleNames)], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders the restarted ripple from the mutated state.
	}

	/** Clear any live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<ReflectionRippleContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: ReflectionRippleContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderReflectionRippleOffText(this.#state.snapshot().ruleNames)], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		const onSettled = () => this.#teardownToNothing(ctx, host);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new ReflectionRippleWidget({ tui, host, policy, state, theme, clock, onSettled }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}

	/** Fires once, from the widget's `onSettled` callback, on the `rippling` -> `idle` transition. Guards against a stale callback from an already-superseded mount (e.g. a fresh trigger remounted before this one settled). */
	#teardownToNothing(ctx: Pick<ReflectionRippleContext, "setWidget">, host: AnimationHost): void {
		if (this.#mount?.mode !== "animated" || this.#mount.host !== host) return;
		if (this.#mount.owned) host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}
}
