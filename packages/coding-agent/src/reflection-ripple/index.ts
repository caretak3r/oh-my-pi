import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type ReflectionRippleContext, ReflectionRippleController } from "./controller";

export * from "./controller";
export * from "./ripple";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toReflectionRippleContext(ctx: ExtensionContext): ReflectionRippleContext {
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
 * Reflection Ripple: each time TTSR interrupts generation to inject a
 * matched rule (`ttsr_triggered`), a calm concentric ripple expands outward
 * on an `aboveEditor` strip while the row briefly dims — the agent visibly
 * "taking a breath" before it reflects — then settles back to nothing once
 * the wave and the breath both recover. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` per ripple, mounted
 * fresh on each trigger seen while unmounted, and torn all the way back down
 * (host disposed, widget removed) once it settles.
 */
export const createReflectionRippleExtension: ExtensionFactory = api => {
	const controller = new ReflectionRippleController();
	api.on("ttsr_triggered", (event, ctx) => {
		controller.onTtsrTriggered(event, toReflectionRippleContext(ctx));
	});
};
