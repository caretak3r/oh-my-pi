import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { AgentRegistry } from "../registry/agent-registry";
import { type AgentFleetContext, AgentFleetController } from "./controller";

export * from "./controller";
export * from "./firefly";
export * from "./state";
export * from "./widget";

function toAgentFleetContext(ctx: ExtensionContext): AgentFleetContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Agent Fleet: spawned subagents drift across a `belowEditor` strip as
 * fireflies — bright while `running`, fading once `idle`/`parked` (done),
 * blinking red while `aborted` (failed). Grounded on the shared
 * `AgentRegistry` (`registry/agent-registry.ts`), the same live roster every
 * subagent spawn/finish/abort already flows through — not the `Agent`/`task`
 * tool's own `tool_call`/`tool_result` events, which only bookend a
 * subagent's lifetime and would miss the registry's richer `idle` vs
 * `parked` vs `aborted` distinction. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` mounted lazily on the
 * first subagent this session observes, matching Tool Constellation's
 * "spawn lazily on first fire" precedent.
 */
export const createAgentFleetExtension: ExtensionFactory = api => {
	const controller = new AgentFleetController({ registry: AgentRegistry.global() });
	api.on("session_start", (_event, ctx) => controller.watch(toAgentFleetContext(ctx)));
	api.on("session_shutdown", (_event, ctx) => controller.dispose(toAgentFleetContext(ctx)));
};
