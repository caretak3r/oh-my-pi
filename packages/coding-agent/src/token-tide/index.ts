import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type TokenTideContext, TokenTideController } from "./controller";

export * from "./controller";
export * from "./scale";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toTokenTideContext(ctx: ExtensionContext): TokenTideContext {
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
 * Token Tide: an oscilloscope for live token throughput. An `aboveEditor`
 * widget that samples the existing `tokensPerSecond` provider on the shared
 * frame clock — steady streaming reads as a smooth waveform, bursty
 * generation as jagged peaks, and idle time between turns settles to a
 * near-flat line with a faint resting pulse. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` for the whole session,
 * mounted on the first streamed assistant message and disposed only if the
 * extension itself is torn down.
 */
export const createTokenTideExtension: ExtensionFactory = api => {
	const controller = new TokenTideController();
	api.on("message_start", (event, ctx) => {
		controller.onMessageStart(event, toTokenTideContext(ctx));
	});
	api.on("message_update", (event, ctx) => {
		controller.onMessageUpdate(event, toTokenTideContext(ctx));
	});
	api.on("message_end", (event, ctx) => {
		controller.onMessageEnd(event, toTokenTideContext(ctx));
	});
};
