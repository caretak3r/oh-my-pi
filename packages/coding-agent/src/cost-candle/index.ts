import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type CostCandleContext, CostCandleController } from "./controller";

export * from "./candle";
export * from "./controller";
export * from "./state";
export * from "./widget";

function toCostCandleContext(ctx: ExtensionContext): CostCandleContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Cost Candle: accumulated spend burns a candle's wax down; an expensive
 * message gutters the flame in a wide, wild flicker that decays back to a
 * calm baseline, while a cheap one barely disturbs it. Grounded in
 * `message.usage.cost.total` — already a settled USD figure computed by
 * `calculateCost` inline in every provider stream implementation (see
 * `packages/catalog/src/models.ts`) — read off every finalized assistant
 * `message_end`. Built on the shared `@oh-my-pi/pi-animation` kit: one
 * `AnimationHost` mounted lazily on the first assistant message this session
 * observes, matching Tool Constellation's "spawn lazily on first fire"
 * precedent.
 */
export const createCostCandleExtension: ExtensionFactory = api => {
	const controller = new CostCandleController();
	api.on("message_end", (event, ctx) => controller.onMessageEnd(event, toCostCandleContext(ctx)));
	registerAnimatedFeatureLifecycle(api, {
		toContext: toCostCandleContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
