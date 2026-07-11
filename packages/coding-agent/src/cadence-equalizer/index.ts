import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type CadenceEqualizerContext, CadenceEqualizerController } from "./controller";

export * from "./bars";
export * from "./controller";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toCadenceEqualizerContext(ctx: ExtensionContext): CadenceEqualizerContext {
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
 * Cadence Equalizer: a multi-band VU-style meter for live token throughput,
 * grounded on the same `tokensPerSecond` provider (`token-rate.ts`) as
 * Token Tide. A `belowEditor` widget where {@link BAND_COUNT} bands each
 * track the identical signal through a differently-tuned exponential
 * moving average — a fast band that jitters with every burst, a slow band
 * that lags and smooths — so the bars visibly dance relative to each other
 * rather than moving in lockstep as one filled bar would. Each band also
 * keeps a peak-hold marker (a classic hardware VU-meter cue absent from
 * Token Tide) that snaps up on a new high and decays slowly, leaving a
 * faint cap over a band that's coasting down from a recent spike.
 */
export const createCadenceEqualizerExtension: ExtensionFactory = api => {
	const controller = new CadenceEqualizerController();
	api.on("message_start", (event, ctx) => {
		controller.onMessageStart(event, toCadenceEqualizerContext(ctx));
	});
	api.on("message_update", (event, ctx) => {
		controller.onMessageUpdate(event, toCadenceEqualizerContext(ctx));
	});
	api.on("message_end", (event, ctx) => {
		controller.onMessageEnd(event, toCadenceEqualizerContext(ctx));
	});
};
