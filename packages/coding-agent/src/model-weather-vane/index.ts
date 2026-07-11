import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type ModelWeatherVaneContext, ModelWeatherVaneController } from "./controller";

export * from "./controller";
export * from "./state";
export * from "./vane";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toModelWeatherVaneContext(ctx: ExtensionContext): ModelWeatherVaneContext {
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
 * Model Weather Vane: a compass emblem whose direction and color are a
 * deterministic hash of the active model's id, swinging through intermediate
 * directions when a mid-session switch is detected before settling on the
 * new model's emblem. Grounded on `AssistantMessage.model`/`.provider` —
 * both required, always-populated fields, see `packages/ai/src/types.ts` —
 * read off every `message_start` event (fired exactly once per response).
 * No dedicated model-switch `ExtensionEvent` exists anywhere in this
 * codebase (confirmed by a full sweep of `extensibility/shared-events.ts`
 * and `extensibility/extensions/types.ts`'s `ExtensionEvent` union); this
 * feature detects a switch by diffing consecutive assistant messages' model
 * ids, the same "pull the real per-call field, don't wait on a push event
 * that doesn't exist" precedent Context Constellation set for
 * `getContextUsage()`. Built on the shared `@oh-my-pi/pi-animation` kit: one
 * `AnimationHost` mounted lazily on the first assistant message this session
 * observes, matching Cost Candle's "spawn lazily on first fire" precedent.
 */
export const createModelWeatherVaneExtension: ExtensionFactory = api => {
	const controller = new ModelWeatherVaneController();
	api.on("message_start", (event, ctx) => controller.onMessageStart(event, toModelWeatherVaneContext(ctx)));
};
