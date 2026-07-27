import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { MessageEndEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
import { CostCandleState } from "./state";
import { type CostCandleTheme, CostCandleWidget, renderCostCandleOffText } from "./widget";

const WIDGET_KEY = "cost-candle";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/** The minimal cost figure this controller reads off a finalized assistant message's already-settled `usage.cost`. */
interface AssistantCostSample {
	role: "assistant";
	costUsd: number;
}

/** Narrow a `message_end` event's message to an assistant message's total cost. `undefined` for any other role. */
function toAssistantCostSample(message: MessageEndEvent["message"]): AssistantCostSample | undefined {
	if (message.role !== "assistant") return undefined;
	return { role: "assistant", costUsd: message.usage.cost.total };
}

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface CostCandleContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: CostCandleTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "static" };

/**
 * Drives Cost Candle: reads `usage.cost.total` — already a settled USD
 * figure computed by `calculateCost` inline in every provider stream
 * implementation, see `packages/catalog/src/models.ts` — off every finalized
 * assistant `message_end`, both accumulating it into the session's total
 * spend (which burns the candle's wax down) and stamping a decaying
 * flame-gutter disturbance sized to that single message's cost. Mounts on
 * the first such message seen this session. Motion gating goes through the
 * kit's {@link MotionPolicy}; a resolved tier of `off` renders the bead's
 * "$total · $avg/msg" static line instead of an animated widget, repainted
 * directly on each event since there is no frame clock in that mode.
 */
export class CostCandleController {
	#scheduler: FrameScheduler;
	#state = new CostCandleState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): CostCandleState {
		return this.#state;
	}

	onMessageEnd(event: MessageEndEvent, ctx: CostCandleContext): void {
		const sample = toAssistantCostSample(event.message);
		if (!sample) return;
		if (!ctx.hasUI) return;
		const changed = this.#state.recordMessageCost(sample.costUsd, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static" && changed) {
			ctx.setWidget(WIDGET_KEY, [renderCostCandleOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Clear the live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<CostCandleContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: CostCandleContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderCostCandleOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new CostCandleWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}
}
