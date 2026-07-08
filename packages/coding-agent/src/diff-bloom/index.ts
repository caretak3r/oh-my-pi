import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type DiffBloomContext, DiffBloomController } from "./controller";

export * from "./bloom";
export * from "./controller";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toDiffBloomContext(ctx: ExtensionContext): DiffBloomContext {
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
 * Diff Bloom: each real, non-empty diff an `edit` tool call lands blooms
 * green (added lines) and red (removed lines) on an `aboveEditor` strip,
 * then wipes clear — grounded in `EditToolDetails.diff` off the `edit`
 * tool's `tool_result`, parsed with the same `getDiffStats` helper the
 * TUI's own tool renderer uses. Built on the shared `@oh-my-pi/pi-animation`
 * kit: one `AnimationHost` per bloom, mounted fresh on the first edit seen
 * while unmounted, and torn all the way back down (host disposed, widget
 * removed) once it wipes clear.
 */
export const createDiffBloomExtension: ExtensionFactory = api => {
	const controller = new DiffBloomController();
	api.on("tool_result", (event, ctx) => {
		controller.onToolResult(event, toDiffBloomContext(ctx));
	});
};
