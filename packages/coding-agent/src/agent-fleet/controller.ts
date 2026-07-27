import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { SessionAnimationHandle } from "../modes/session-animation";
import { type AgentFleetRegistryEventSource, AgentFleetState } from "./state";
import { type AgentFleetTheme, AgentFleetWidget, renderAgentFleetOffText } from "./widget";

const WIDGET_KEY = "agent-fleet";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "belowEditor" };

/** The subset of `AgentRegistry` this controller needs — just the change subscription. Decoupled from the concrete class so tests can inject an in-memory fake instead of touching the real process-global singleton. */
export interface AgentFleetRegistrySource {
	onChange(listener: (event: AgentFleetRegistryEventSource) => void): () => void;
}

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface AgentFleetContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: AgentFleetTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "static" };

/**
 * Drives Agent Fleet: subscribes once to the shared `AgentRegistry`'s change
 * stream (not an extension `ctx.on(...)` event — subagent lifecycle isn't
 * part of the `ExtensionContext` event union, it's a direct process-global
 * registry, same seam `collab/host.ts` and `tan-command-controller.ts`
 * already read from) and mounts lazily on the first `sub`-kind agent it
 * observes, mirroring Tool Constellation's "stars spawn lazily on first
 * fire" precedent — a session that never spawns a subagent shows nothing.
 * `ExtensionContext` is rebuilt fresh on every extension-event dispatch (see
 * `extensions/runner.ts#createContext`), so `watch` captures one mapped
 * snapshot from `session_start` and reuses it for the lifetime of the
 * subscription — safe because `ctx.ui` is the same stable object underneath
 * every dispatch, so `setWidget` calls made from a much-later registry event
 * still route to the live UI.
 */
export class AgentFleetController {
	#scheduler: FrameScheduler;
	#registry: AgentFleetRegistrySource;
	#state = new AgentFleetState();
	#mount: Mount | undefined;
	#unsubscribeRegistry: (() => void) | undefined;

	constructor(options: { registry: AgentFleetRegistrySource; scheduler?: FrameScheduler }) {
		this.#registry = options.registry;
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): AgentFleetState {
		return this.#state;
	}

	/** Whether the registry subscription is currently live. */
	get watching(): boolean {
		return this.#unsubscribeRegistry !== undefined;
	}

	/** Start watching the registry for subagent lifecycle events. Call once, from `session_start`. Idempotent; stays dormant with no UI surface. */
	watch(ctx: AgentFleetContext): void {
		if (this.#unsubscribeRegistry || !ctx.hasUI) return;
		this.#unsubscribeRegistry = this.#registry.onChange(event => this.#handleRegistryEvent(event, ctx));
	}

	/** Tear down the registry subscription and clear any live widget without disposing the session host. Idempotent. */
	dispose(ctx: Pick<AgentFleetContext, "setWidget">): void {
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#handleRegistryEvent(event: AgentFleetRegistryEventSource, ctx: AgentFleetContext): void {
		const now = this.#scheduler.now();
		const eventChanged = this.#state.applyRegistryEvent(event, now);
		// Prune eagerly on every event too, not just per animated frame: the
		// static/off tier has no frame clock to pick a finished firefly up on
		// its own.
		const pruned = this.#state.pruneFireflies(now);
		if (!eventChanged && !pruned) return;

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderAgentFleetOffText(this.#state.snapshot(), ctx.theme)], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	#mountWidget(ctx: AgentFleetContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderAgentFleetOffText(this.#state.snapshot(), ctx.theme)], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new AgentFleetWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}
}
