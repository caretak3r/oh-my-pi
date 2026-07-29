import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type ToolConstellationContext, ToolConstellationController } from "./controller";

export * from "./categories";
export * from "./controller";
export * from "./sky";
export * from "./state";
export * from "./widget";

function toConstellationContext(ctx: ExtensionContext): ToolConstellationContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Tool Constellation: the session's tool activity as a living star map. Each
 * tool type is a fixed star in a small `belowEditor` night-field; firing it
 * flares the star and traces a faint ley-line from the previously-used star,
 * so over a session the shape of the work draws itself. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` for the whole session,
 * mounted on the first `tool_call` and disposed only if the extension itself
 * is torn down.
 */
export const createToolConstellationExtension: ExtensionFactory = api => {
	const controller = new ToolConstellationController();
	api.on("tool_call", (event, ctx) => {
		controller.onToolCall(event, toConstellationContext(ctx));
	});
	registerAnimatedFeatureLifecycle(api, {
		toContext: toConstellationContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
