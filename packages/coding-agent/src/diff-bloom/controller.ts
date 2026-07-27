import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import { isToolResultEventType, type ToolResultEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
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
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: DiffBloomTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "off" };

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
 * controller removes the widget entirely; the UI drops that subscription
 * while the shared session host remains available to siblings. A later edit
 * remounts fresh.
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

	/** Clear any live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<DiffBloomContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: DiffBloomContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderDiffBloomOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		const onSettled = () => this.#teardownToNothing(ctx, host);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new DiffBloomWidget({ tui, host, policy, state, theme, clock, onSettled }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}

	/** Fires once, from the widget's `onSettled` callback, on the `blooming` -> `idle` transition. Guards against a stale callback from an already-superseded mount (e.g. a fresh edit remounted before this one settled). */
	#teardownToNothing(ctx: Pick<DiffBloomContext, "setWidget">, host: AnimationHost): void {
		if (this.#mount?.mode !== "animated" || this.#mount.host !== host) return;
		if (this.#mount.owned) host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}
}
