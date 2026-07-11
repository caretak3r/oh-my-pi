import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { isSettingsInitialized, settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type ContextConstellationContext, ContextConstellationController } from "./controller";

export * from "./controller";
export * from "./sky";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	if (!isSettingsInitialized()) return "full";
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toConstellationContext(ctx: ExtensionContext): ContextConstellationContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(),
		theme: ctx.ui.theme,
		getContextUsage: () => ctx.getContextUsage(),
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Context Constellation: the context window as a small night sky that fills
 * with stars as tokens accumulate, swept clear by a comet-front wipe when
 * compaction reclaims space. Built on the shared `@oh-my-pi/pi-animation`
 * kit: one `AnimationHost` for the whole session, mounted on the first
 * `"context"` event that yields a defined usage reading and disposed only if
 * the extension itself is torn down.
 */
export const createContextConstellationExtension: ExtensionFactory = api => {
	const controller = new ContextConstellationController();
	api.on("context", (_event, ctx) => {
		controller.onContext(toConstellationContext(ctx));
	});
	api.on("auto_compaction_start", (_event, ctx) => {
		controller.onAutoCompactionStart(toConstellationContext(ctx));
	});
	api.on("auto_compaction_end", (_event, ctx) => {
		controller.onAutoCompactionEnd(toConstellationContext(ctx));
	});
};
