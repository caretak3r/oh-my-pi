import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type MemoryCrystalsContext, MemoryCrystalsController } from "./controller";

export * from "./controller";
export * from "./crystal";
export * from "./state";
export * from "./widget";

function toMemoryCrystalsContext(ctx: ExtensionContext): MemoryCrystalsContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Memory Crystals: each successful auto-compaction (`auto_compaction_end`
 * with a defined `result` — only the `context-full`/`snapcompact` success
 * paths ever populate one; `handoff`/`shake`/aborted/skipped paths carry
 * `result: undefined` and are ignored, see `controller.ts`'s re-grounding
 * note) crystallizes into a gem that drops into a persistent tray below the
 * editor. Gem size/color scale with the compaction's `tokensBefore`
 * magnitude against a fixed reference ceiling, mirroring Cost Candle's/Token
 * Tide's normalization pattern. Built on the shared `@oh-my-pi/pi-animation`
 * kit: one `AnimationHost` mounted lazily on the first successful
 * compaction this session observes.
 */
export const createMemoryCrystalsExtension: ExtensionFactory = api => {
	const controller = new MemoryCrystalsController();
	api.on("auto_compaction_end", (event, ctx) => controller.onAutoCompactionEnd(event, toMemoryCrystalsContext(ctx)));
};
