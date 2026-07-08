import type { FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { MessageStartEvent } from "../extensibility/extensions/types";
import { ModelWeatherVaneState } from "./state";
import { type ModelWeatherVaneTheme, ModelWeatherVaneWidget, renderModelWeatherVaneOffText } from "./widget";

const WIDGET_KEY = "model-weather-vane";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "belowEditor" };

/** The minimal model/provider sample this controller reads off a `message_start` event's assistant message. */
interface AssistantModelSample {
	role: "assistant";
	modelId: string;
	provider: string;
}

/** Narrow a `message_start` event's message to an assistant message's model/provider. `undefined` for any other role. */
function toAssistantModelSample(message: MessageStartEvent["message"]): AssistantModelSample | undefined {
	if (message.role !== "assistant") return undefined;
	return { role: "assistant", modelId: message.model, provider: message.provider };
}

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface ModelWeatherVaneContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: ModelWeatherVaneTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "static" };

/**
 * Drives Model Weather Vane: reads `AssistantMessage.model`/`.provider` —
 * both required, always-populated fields (`packages/ai/src/types.ts`) — off
 * every `message_start` event whose message is an assistant message (fired
 * exactly once per response, before its stream body is consumed; see
 * `packages/agent/src/agent-loop.ts`'s `case "start"`). No dedicated
 * model-switch event exists anywhere in the extension surface — this is the
 * finest-grained real signal available, diffed turn-to-turn to detect a
 * genuine mid-session switch (auth fallback, `/model`, plan-mode
 * auto-switch, context-promotion, ...) rather than polling a snapshot field.
 * Mounts on the first assistant message seen this session. Motion gating
 * goes through the kit's {@link MotionPolicy}; a resolved tier of `off`
 * renders the bead's "🧭 model-id (provider)" static line instead of an
 * animated widget, repainted directly on each switch since there is no frame
 * clock in that mode.
 */
export class ModelWeatherVaneController {
	#scheduler: FrameScheduler;
	#state = new ModelWeatherVaneState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): ModelWeatherVaneState {
		return this.#state;
	}

	onMessageStart(event: MessageStartEvent, ctx: ModelWeatherVaneContext): void {
		const sample = toAssistantModelSample(event.message);
		if (!sample) return;
		if (!ctx.hasUI) return;
		const switched = this.#state.recordAssistantMessage(sample.modelId, sample.provider, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static" && switched) {
			ctx.setWidget(WIDGET_KEY, [renderModelWeatherVaneOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<ModelWeatherVaneContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: ModelWeatherVaneContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderModelWeatherVaneOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const host = new AnimationHost({ policy, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new ModelWeatherVaneWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
}
