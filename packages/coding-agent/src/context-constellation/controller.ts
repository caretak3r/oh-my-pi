import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { SessionAnimationHandle } from "../modes/session-animation";
import type { ContextUsageReading } from "./state";
import { ConstellationState } from "./state";
import { type ConstellationTheme, ContextConstellationWidget, renderConstellationOffText } from "./widget";

const WIDGET_KEY = "context-constellation";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "belowEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface ContextConstellationContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: ConstellationTheme;
	/** Fresh context-usage reading for the active model, or `undefined` when no model is resolved yet. */
	getContextUsage(): ContextUsageReading | undefined;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "static" };

/**
 * Drives Context Constellation: the context window as a small night sky that
 * fills with stars as tokens accumulate, swept clear by a comet-front wipe
 * when compaction reclaims space.
 *
 * Two signals, both re-derived by pulling `ctx.getContextUsage()` rather
 * than trusting either event's payload to carry counts: the `"context"`
 * event (fired before every LLM call — `ContextEvent` carries only
 * `messages`, no usage figures) drives the normal fill-growth path, and
 * `auto_compaction_end` triggers an *immediate* re-read right after
 * compaction settles, rather than waiting for the next `"context"` event
 * (which may not fire again for a while if the session goes idle). Sweep
 * geometry is stamped from `auto_compaction_start` (whose `reason`/`action`
 * fields are always populated, unlike `auto_compaction_end.result` — see
 * Memory Crystals' controller note) as the pre-compaction cell count; the
 * following usage re-read supplies the target the sweep wipes toward, even
 * when that target turns out to equal the start (an aborted/skipped
 * compaction correctly renders no sweep motion at all).
 *
 * Mounts on the first `"context"` event that yields a defined usage reading
 * this session, matching Tool Constellation's/Cost Candle's "spawn lazily on
 * first real signal" precedent.
 */
export class ContextConstellationController {
	#scheduler: FrameScheduler;
	#state = new ConstellationState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): ConstellationState {
		return this.#state;
	}

	/** Handle the `"context"` event: re-derive fill from a fresh usage reading. */
	onContext(ctx: ContextConstellationContext): void {
		if (!ctx.hasUI) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		this.#state.applyContextUsage(usage, this.#scheduler.now());
		this.#render(ctx);
	}

	/** Handle `auto_compaction_start`: stamp the pre-compaction cell count as the sweep's starting point. */
	onAutoCompactionStart(ctx: ContextConstellationContext): void {
		if (!ctx.hasUI) return;
		this.#state.beginSweep(this.#scheduler.now());
	}

	/** Handle `auto_compaction_end`: refresh immediately so the sweep's target reflects the post-compaction reading without waiting on the next `"context"` event. */
	onAutoCompactionEnd(ctx: ContextConstellationContext): void {
		if (!ctx.hasUI) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		this.#state.applyContextUsage(usage, this.#scheduler.now());
		this.#render(ctx);
	}

	/** Clear the live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<ContextConstellationContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#render(ctx: ContextConstellationContext): void {
		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	#mountWidget(ctx: ContextConstellationContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new ContextConstellationWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}
}
