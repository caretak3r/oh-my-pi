import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type BreathingBorderContext, BreathingBorderController } from "./controller";

export * from "./breath";
export * from "./controller";
export * from "./state";
export * from "./widget";

function toBreathingBorderContext(ctx: ExtensionContext): BreathingBorderContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Breathing Border: while the agent works, a faint luminance pulse breathes
 * along an `aboveEditor` border strip on a ~4s inhale/exhale — ambient
 * presence, felt not seen. On `agent_end` it winds down in one slow exhale
 * then goes perfectly still. `turn_start`/`turn_end` modulate the breath
 * cadence from the just-finished turn's duration. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` for the whole session,
 * mounted on the first `agent_start` seen, and torn back down to a static
 * widget once the post-`agent_end` exhale settles — this is the reference
 * demo for the kit's off/subtle/full motion ladder and its backpressure gate.
 */
export const createBreathingBorderExtension: ExtensionFactory = api => {
	const controller = new BreathingBorderController();
	api.on("agent_start", (event, ctx) => {
		controller.onAgentStart(event, toBreathingBorderContext(ctx));
	});
	api.on("agent_end", (event, ctx) => {
		controller.onAgentEnd(event, toBreathingBorderContext(ctx));
	});
	api.on("turn_start", (event, ctx) => {
		controller.onTurnStart(event, toBreathingBorderContext(ctx));
	});
	api.on("turn_end", (event, ctx) => {
		controller.onTurnEnd(event, toBreathingBorderContext(ctx));
	});
};
