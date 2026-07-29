import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type RetryRadarContext, RetryRadarController } from "./controller";

export * from "./controller";
export * from "./ring";
export * from "./widget";

function toRadarContext(ctx: ExtensionContext): RetryRadarContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Retry Radar: a draining countdown ring shown while the agent backs off between
 * auto-retries. Consumes the session-shared `@oh-my-pi/pi-animation` host,
 * mounting an ambient widget subscription for each episode and removing it
 * when the retry resolves (green on recovery, red on give-up).
 */
export const createRetryRadarExtension: ExtensionFactory = api => {
	const controller = new RetryRadarController();
	api.on("auto_retry_start", (event, ctx) => {
		controller.onStart(event, toRadarContext(ctx));
	});
	api.on("auto_retry_end", (event, ctx) => {
		controller.onEnd(event, toRadarContext(ctx));
	});
	registerAnimatedFeatureLifecycle(api, {
		toContext: toRadarContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
