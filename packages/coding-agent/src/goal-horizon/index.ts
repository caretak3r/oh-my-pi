import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type GoalHorizonContext, GoalHorizonController } from "./controller";

export * from "./controller";
export * from "./horizon";
export * from "./state";
export * from "./widget";

function toGoalHorizonContext(ctx: ExtensionContext): GoalHorizonContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Goal Horizon: a sunrise-gradient bar tracking `tokensUsed / tokenBudget`
 * on the currently active `/goal`, with a synthetic milestone flare at
 * 25/50/75/100% crossed. Grounded in the real `goal_updated` event and the
 * real `Goal`/`GoalModeState` types (`extensibility/shared-events.ts`,
 * `goals/state.ts`) — but the idea doc's "milestones flare" clause has zero
 * backing in that data model (no milestone concept exists anywhere in this
 * codebase); the milestone thresholds and flare are invented entirely by
 * this feature and documented as such. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` mounted lazily on the
 * first `goal_updated` event this session observes, matching Cost Candle's
 * "spawn lazily on first fire" precedent.
 */
export const createGoalHorizonExtension: ExtensionFactory = api => {
	const controller = new GoalHorizonController();
	api.on("goal_updated", (event, ctx) => controller.onGoalUpdated(event, toGoalHorizonContext(ctx)));
	registerAnimatedFeatureLifecycle(api, {
		toContext: toGoalHorizonContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
