import type { ExtensionFactory } from "./extensibility/extensions";

/**
 * The cosmetic animation extension family. Registered only for interactive
 * sessions (`hasUI`): headless exec, subagents, plain rpc, and CI never load
 * these modules or their event handlers. `hasUI=false` sessions could never
 * animate anyway — `resolveMotionTier` forces the `off` tier without a UI
 * (packages/animation/src/motion-policy.ts) — so gating registration removes
 * dead import + handler cost without changing observable behavior.
 *
 * NOT gated on `display.animations`: the setting is re-read per event by the
 * extensions themselves, so a live off->full flip re-enables motion without a
 * session restart. Keep it that way.
 */
export async function loadAnimationExtensions(hasUI: boolean): Promise<ExtensionFactory[]> {
	if (!hasUI) return [];
	return [
		(await import("./retry-radar")).createRetryRadarExtension,
		(await import("./tool-constellation")).createToolConstellationExtension,
		(await import("./token-tide")).createTokenTideExtension,
		(await import("./session-bonsai")).createSessionBonsaiExtension,
		(await import("./todo-meteors")).createTodoMeteorsExtension,
		(await import("./breathing-border")).createBreathingBorderExtension,
		(await import("./agent-fleet")).createAgentFleetExtension,
		(await import("./cost-candle")).createCostCandleExtension,
		(await import("./reflection-ripple")).createReflectionRippleExtension,
		(await import("./memory-crystals")).createMemoryCrystalsExtension,
		(await import("./context-constellation")).createContextConstellationExtension,
		(await import("./diff-bloom")).createDiffBloomExtension,
		(await import("./cadence-equalizer")).createCadenceEqualizerExtension,
		(await import("./goal-horizon")).createGoalHorizonExtension,
		(await import("./model-weather-vane")).createModelWeatherVaneExtension,
		(await import("./prompt-charge")).createPromptChargeExtension,
	];
}
