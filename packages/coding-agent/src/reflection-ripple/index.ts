import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type ReflectionRippleContext, ReflectionRippleController } from "./controller";

export * from "./controller";
export * from "./ripple";
export * from "./state";
export * from "./widget";

function toReflectionRippleContext(ctx: ExtensionContext): ReflectionRippleContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
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
 * `@oh-my-pi/pi-animation` kit: a widget subscription mounted fresh on each
 * trigger seen while unmounted and removed once it settles, while the
 * session-owned host remains available to the rest of the animation family.
 */
export const createReflectionRippleExtension: ExtensionFactory = api => {
	const controller = new ReflectionRippleController();
	api.on("ttsr_triggered", (event, ctx) => {
		controller.onTtsrTriggered(event, toReflectionRippleContext(ctx));
	});
	registerAnimatedFeatureLifecycle(api, {
		toContext: toReflectionRippleContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
