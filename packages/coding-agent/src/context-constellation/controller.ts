import type { BackpressureSignal, FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
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
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: ConstellationTheme;
	/** Fresh context-usage reading for the active model, or `undefined` when no model is resolved yet. */
	getContextUsage(): ContextUsageReading | undefined;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "static" };

/**
 * The {@link AnimationHost} backpressure field must be wired at construction,
 * before the widget factory supplies the real `tui` — this adapter lets the
 * host read a live signal once {@link attach} runs from inside that factory.
 */
function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: Pick<TUI, "renderUnderPressure">): void } {
	let live: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return live?.underPressure ?? false;
			},
		},
		attach(tui) {
			live = backpressureFromTui(tui);
		},
	};
}

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

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<ContextConstellationContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
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
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new ContextConstellationWidget({ tui, host, policy, state, theme, clock });
			},
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
}
