import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { isSettingsInitialized, settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type RetryRadarContext, RetryRadarController } from "./controller";

export * from "./controller";
export * from "./ring";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	if (!isSettingsInitialized()) return "full";
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toRadarContext(ctx: ExtensionContext): RetryRadarContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Retry Radar: a draining countdown ring shown while the agent backs off between
 * auto-retries. Consumes the shared `@oh-my-pi/pi-animation` kit — one
 * `AnimationHost` per retry episode, mounted as an ambient widget and disposed
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
};
