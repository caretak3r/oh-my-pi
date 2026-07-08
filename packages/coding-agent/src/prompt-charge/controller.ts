import type { FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { InputEvent } from "../extensibility/extensions/types";
import { chargeFraction } from "./charge";
import { PromptChargeState } from "./state";
import { type PromptChargeTheme, PromptChargeWidget, renderPromptChargeOffText } from "./widget";

const WIDGET_KEY = "prompt-charge";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface PromptChargeContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: PromptChargeTheme;
	/** `ExtensionContext.ui.getEditorText` — the only real signal this feature is grounded on. */
	getEditorText(): string;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "off" };

/**
 * Drives Prompt Charge: unlike every prior Wave 2 feature, there is no
 * `ExtensionEvent` to react to while the user types — a full sweep of
 * `extensibility/extensions/types.ts`'s `ExtensionEvent` union has nothing
 * fired per keystroke (the only `input` event fires once, at submit). So
 * this controller mounts unconditionally on `session_start` (the widget then
 * polls `ExtensionContext.ui.getEditorText()` itself, once per animation
 * frame — see `widget.ts`'s `onFrame`) rather than lazily on a first
 * data-bearing event the way Cost Candle/Model Weather Vane do, since an
 * idle 0%-charge caret is itself the correct resting state to show from the
 * very first frame, mirroring Breathing Border's unconditional
 * `agent_start` mount. The real `input` event (submit) starts a release
 * burst captured at the exact charge the submitted text implies
 * (`event.text.length`, the authoritative submitted length — not a
 * possibly-one-frame-stale poll). Motion gating goes through the shared
 * kit's {@link MotionPolicy}; a resolved tier of `off` renders a static line
 * instead, refreshed only on submit (there is no frame clock in that mode to
 * refresh it while typing).
 */
export class PromptChargeController {
	#scheduler: FrameScheduler;
	#state = new PromptChargeState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): PromptChargeState {
		return this.#state;
	}

	/** Mount the widget once, unconditionally. Call from `session_start`. Idempotent; stays dormant with no UI surface. */
	mount(ctx: PromptChargeContext): void {
		if (this.#mount || !ctx.hasUI) return;
		this.#mount = this.#mountWidget(ctx);
	}

	/** The real, once-per-submit signal: starts a release burst from the submitted text's implied charge. */
	onInput(event: InputEvent, ctx: PromptChargeContext): void {
		if (!ctx.hasUI) return;
		const chargeAtRelease = chargeFraction(event.text.length);
		this.#state.release(chargeAtRelease, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "off") {
			ctx.setWidget(WIDGET_KEY, [renderPromptChargeOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<PromptChargeContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: PromptChargeContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderPromptChargeOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const host = new AnimationHost({ policy, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		const getEditorText = ctx.getEditorText;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new PromptChargeWidget({ tui, host, policy, state, theme, clock, getEditorText }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
}
