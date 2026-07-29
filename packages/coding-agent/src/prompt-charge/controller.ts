import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { InputEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
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
interface PromptChargeContextBase {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: PromptChargeTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type PromptChargeEditorSignal =
	| {
			/** Allocation-free editor length signal used by the production adapter. */
			getEditorTextLength: () => number;
			/** Legacy/test adapter retained for existing external contexts; never used when the length signal exists. */
			getEditorText?: () => string;
	  }
	| {
			getEditorTextLength?: undefined;
			/** Legacy fallback for contexts that have not adopted the allocation-free length signal. */
			getEditorText: () => string;
	  };

export type PromptChargeContext = PromptChargeContextBase & PromptChargeEditorSignal;

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "off" };

function editorTextLengthAccessor(ctx: PromptChargeContext): () => number {
	if (ctx.getEditorTextLength) return ctx.getEditorTextLength;
	return () => ctx.getEditorText().length;
}

/**
 * Drives Prompt Charge: unlike every prior Wave 2 feature, there is no
 * `ExtensionEvent` to react to while the user types — a full sweep of
 * `extensibility/extensions/types.ts`'s `ExtensionEvent` union has nothing
 * fired per keystroke (the only `input` event fires once, at submit). So
 * this controller mounts unconditionally on `session_start` (the widget then
 * polls `ExtensionContext.ui.getEditorTextLength()` itself, once per animation
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

	/** Clear the live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<PromptChargeContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: PromptChargeContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderPromptChargeOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		const getEditorTextLength = editorTextLengthAccessor(ctx);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new PromptChargeWidget({ tui, host, policy, state, theme, clock, getEditorTextLength }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}
}
