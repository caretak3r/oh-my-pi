import type { BackpressureSignal, FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { AutoCompactionEndEvent } from "../extensibility/extensions/types";
import { MemoryCrystalsState } from "./state";
import { type MemoryCrystalsTheme, MemoryCrystalsWidget, renderMemoryCrystalsOffText } from "./widget";

const WIDGET_KEY = "memory-crystals";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "belowEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface MemoryCrystalsContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: MemoryCrystalsTheme;
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
 * Drives Memory Crystals: each `auto_compaction_end` event whose `result` is
 * defined crystallizes into one gem dropped into a persistent tray.
 *
 * **Re-grounded from the idea doc's literal claim** (the same "verify each
 * grounding signal is real" rule Agent Fleet's doc already established): the
 * idea names `auto_compaction_end.result` as a source of "number of messages
 * compacted" and token-count deltas. Tracing every emission site in
 * `agent-session.ts` shows `result` is `undefined` on every `handoff`/`shake`
 * action, and on every `aborted`/`skipped`/`errorMessage` path — it is only
 * ever populated on a clean `context-full`/`snapcompact` success. Where
 * present, it carries `summary`/`shortSummary`/`tokensBefore` — no message
 * count and no `tokensAfter` (there is no after-figure in the payload at
 * all). So this controller: (1) treats an `undefined` result as "nothing to
 * crystallize" rather than trying to synthesize a lesser crystal from
 * `action`/`aborted`/`skipped` flags alone, and (2) sizes each crystal's
 * magnitude off `tokensBefore` (the one real number available) rather than a
 * before/after delta or a message count, neither of which the payload can
 * supply.
 *
 * Mounts on the first successful compaction seen this session, matching
 * Tool Constellation's/Cost Candle's "spawn lazily on first real signal"
 * precedent — a session with no compactions shows nothing at all.
 */
export class MemoryCrystalsController {
	#scheduler: FrameScheduler;
	#state = new MemoryCrystalsState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): MemoryCrystalsState {
		return this.#state;
	}

	onAutoCompactionEnd(event: AutoCompactionEndEvent, ctx: MemoryCrystalsContext): void {
		if (!event.result) return;
		if (!ctx.hasUI) return;
		this.#state.applyCompactionEnd(
			event.result.tokensBefore,
			event.result.summary,
			event.action,
			this.#scheduler.now(),
		);

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderMemoryCrystalsOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<MemoryCrystalsContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: MemoryCrystalsContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderMemoryCrystalsOffText(this.#state.snapshot())], WIDGET_OPTIONS);
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
				return new MemoryCrystalsWidget({ tui, host, policy, state, theme, clock });
			},
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
}
