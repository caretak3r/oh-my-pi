import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type PromptChargeContext, PromptChargeController } from "./controller";

export * from "./charge";
export * from "./controller";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toPromptChargeContext(ctx: ExtensionContext): PromptChargeContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(),
		theme: ctx.ui.theme,
		getEditorText: () => ctx.ui.getEditorText(),
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Prompt Charge: the input caret glows as a longer prompt is typed,
 * releasing in a brief flash on submit. Grounded on
 * `ExtensionContext.ui.getEditorText()` — there is no per-keystroke
 * `ExtensionEvent` anywhere in this codebase (a full sweep of
 * `extensibility/shared-events.ts` and `extensibility/extensions/types.ts`'s
 * `ExtensionEvent` union turns up nothing fired while typing; the only
 * `input` event fires once, at submit), so the widget polls
 * `getEditorText()` itself every animation frame rather than reacting to a
 * pushed event — the first Wave 2 feature to do so. Built on the shared
 * `@oh-my-pi/pi-animation` kit: mounted unconditionally on `session_start`
 * (an idle 0%-charge caret is itself the correct resting state to show from
 * the first frame, mirroring Breathing Border's unconditional `agent_start`
 * mount) and torn down on `session_shutdown`.
 */
export const createPromptChargeExtension: ExtensionFactory = api => {
	const controller = new PromptChargeController();
	api.on("session_start", (_event, ctx) => controller.mount(toPromptChargeContext(ctx)));
	api.on("input", (event, ctx) => controller.onInput(event, toPromptChargeContext(ctx)));
	api.on("session_shutdown", (_event, ctx) => controller.dispose(toPromptChargeContext(ctx)));
};
