import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type DiffBloomContext, DiffBloomController } from "./controller";

export * from "./bloom";
export * from "./controller";
export * from "./state";
export * from "./widget";

function toDiffBloomContext(ctx: ExtensionContext): DiffBloomContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Diff Bloom: each real, non-empty diff an `edit` tool call lands blooms
 * green (added lines) and red (removed lines) on an `aboveEditor` strip,
 * then wipes clear — grounded in `EditToolDetails.diff` off the `edit`
 * tool's `tool_result`, parsed with the same `getDiffStats` helper the
 * TUI's own tool renderer uses. Built on the shared `@oh-my-pi/pi-animation`
 * kit: a widget subscription mounted fresh on the first edit seen while
 * unmounted and removed once it wipes clear, while the session-owned host
 * remains available to the rest of the animation family.
 */
export const createDiffBloomExtension: ExtensionFactory = api => {
	const controller = new DiffBloomController();
	api.on("tool_result", (event, ctx) => {
		controller.onToolResult(event, toDiffBloomContext(ctx));
	});
	registerAnimatedFeatureLifecycle(api, {
		toContext: toDiffBloomContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
