import type { BackpressureSignal, FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import { isToolResultEventType, type ToolResultEvent } from "../extensibility/extensions/types";
import { getDiffStats } from "../tools/render-utils";
import { DiffBloomState } from "./state";
import { type DiffBloomTheme, DiffBloomWidget, renderDiffBloomOffText } from "./widget";

const WIDGET_KEY = "diff-bloom";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface DiffBloomContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: DiffBloomTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "off" };

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
 * Drives Diff Bloom: each `edit` tool's `tool_result` — the only builtin
 * tool whose result carries a real, always-populated unified diff
 * (`EditToolDetails.diff`) — (re)starts a single grow-then-wipe bloom whose
 * added/removed segment sizes come from {@link getDiffStats}, the same
 * diff-stats parser the TUI's own tool-result renderer uses
 * (`edit/renderer.ts`'s `formatDiffStatsSuffix`). `write` tool results are
 * deliberately NOT wired: `WriteToolResultEvent.details` is typed
 * `undefined` on the extension-facing event (`extensions/types.ts`) — the
 * only content extensions see is a human-readable "Successfully wrote N
 * bytes" string, and parsing that would be exactly the kind of invented
 * field prior Wave 2 features (Memory Crystals' dropped "messages
 * compacted" dimension) were scoped away from. Mounts fresh on the first
 * edit seen this session (or a later one, if a prior bloom already fully
 * wiped clear and tore its mount down). Motion gating goes through the
 * shared kit's {@link MotionPolicy}; a resolved tier of `off` instead
 * renders a static line naming the path and added/removed counts, refreshed
 * on each bloom. Once the bloom settles (the {@link DiffBloomState.settleIfDone}
 * transition, surfaced via the widget's `onSettled` callback), the
 * controller disposes the animated host and removes the widget entirely — a
 * settled bloom leaves zero subscriptions and no lingering visual. A later
 * edit remounts fresh.
 */
export class DiffBloomController {
	#scheduler: FrameScheduler;
	#state = new DiffBloomState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): DiffBloomState {
		return this.#state;
	}

	onToolResult(event: ToolResultEvent, ctx: DiffBloomContext): void {
		if (!ctx.hasUI) return;
		if (!isToolResultEventType("edit", event)) return;
		// A thrown-error result always carries `details: undefined` (see
		// `extensions/wrapper.ts`'s catch branch), and a no-op edit (e.g. a
		// pure rename with no line-level change) parses to zero added/removed —
		// both cases have nothing real to bloom, so skip rather than mounting
		// on an empty signal.
		const diff = event.details?.diff;
		if (!diff) return;
		const { added, removed } = getDiffStats(diff);
		if (added === 0 && removed === 0) return;
		const path = event.details?.path ?? event.details?.perFileResults?.[0]?.path;
		this.#state.applyBloom(path, added, removed, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "off") {
			ctx.setWidget(WIDGET_KEY, [renderDiffBloomOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders the restarted bloom from the mutated state.
	}

	/** Tear down any live mount (animated host, if one exists) and clear the widget. Idempotent. */
	dispose(ctx: Pick<DiffBloomContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: DiffBloomContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderDiffBloomOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		const onSettled = () => this.#teardownToNothing(ctx, host);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new DiffBloomWidget({ tui, host, policy, state, theme, clock, onSettled });
			},
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}

	/** Fires once, from the widget's `onSettled` callback, on the `blooming` -> `idle` transition. Guards against a stale callback from an already-superseded mount (e.g. a fresh edit remounted before this one settled). */
	#teardownToNothing(ctx: Pick<DiffBloomContext, "setWidget">, host: AnimationHost): void {
		if (this.#mount?.mode !== "animated" || this.#mount.host !== host) return;
		host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}
}
