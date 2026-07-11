import type { FrameScheduler, MotionSetting } from "@oh-my-pi/pi-animation";
import { AnimationHost, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { AutoRetryEndEvent, AutoRetryStartEvent } from "../extensibility/shared-events";
import { shortReason } from "./ring";
import { type RetryRadarState, type RetryRadarTheme, RetryRadarWidget, renderRetryLine } from "./widget";

const WIDGET_KEY = "retry-radar";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };
/** Width used for the static (non-TTY / motion-`off`) fallback line. */
const STATIC_WIDTH = 60;
/** How long the green/red terminal frame lingers before the widget is cleared. */
const DEFAULT_SETTLE_MS = 900;

/**
 * Cancellable one-shot timer seam so tests can settle synchronously without real
 * clocks. Returns a cancel function.
 */
export type RetryTimer = (ms: number, fn: () => void) => () => void;

const defaultTimer: RetryTimer = (ms, fn) => {
	let cancelled = false;
	void Bun.sleep(ms).then(() => {
		if (!cancelled) fn();
	});
	return () => {
		cancelled = true;
	};
};

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from the
 * full context (and unit-testable with a plain object).
 */
export interface RetryRadarContext {
	/** False in print/RPC modes with no widget surface — the radar stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: RetryRadarTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

interface AnimatedActive {
	mode: "animated";
	state: RetryRadarState;
	host: AnimationHost;
}
interface StaticActive {
	mode: "static";
	state: RetryRadarState;
}
type ActiveEpisode = AnimatedActive | StaticActive;

/**
 * Drives the auto-retry countdown ring: mounts an animated ring on
 * `auto_retry_start`, settles it green/red on `auto_retry_end`, then clears it —
 * disposing the shared {@link AnimationHost} so no frame-clock subscription
 * leaks. Motion gating goes through the kit's {@link MotionPolicy}; a resolved
 * tier of `off` (setting off, non-TTY, `NO_COLOR`/`CI`/dumb terminal) renders a
 * single static status line instead of an animated widget.
 */
export class RetryRadarController {
	#scheduler: FrameScheduler | undefined;
	#settleMs: number;
	#timer: RetryTimer;
	#active: ActiveEpisode | undefined;
	#cancelSettle: (() => void) | undefined;

	constructor(options: { scheduler?: FrameScheduler; settleMs?: number; timer?: RetryTimer } = {}) {
		this.#scheduler = options.scheduler;
		this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
		this.#timer = options.timer ?? defaultTimer;
	}

	onStart(event: AutoRetryStartEvent, ctx: RetryRadarContext): void {
		this.#cancelPendingSettle();
		this.#teardownActive(ctx);
		if (!ctx.hasUI) return;

		const state: RetryRadarState = {
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			reason: shortReason(event.errorMessage),
			phase: "waiting",
		};

		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			this.#active = { mode: "static", state };
			ctx.setWidget(WIDGET_KEY, [renderRetryLine(state, 0, STATIC_WIDTH, ctx.theme)], WIDGET_OPTIONS);
			return;
		}

		const host = new AnimationHost({ policy, scheduler: this.#scheduler });
		this.#active = { mode: "animated", state, host };
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new RetryRadarWidget({ tui, host, policy, state, theme }),
			WIDGET_OPTIONS,
		);
	}

	onEnd(event: AutoRetryEndEvent, ctx: RetryRadarContext): void {
		const active = this.#active;
		if (!active) return;
		this.#cancelPendingSettle();

		active.state.phase = event.success ? "recovered" : "gaveup";
		active.state.finalError = event.finalError;

		// Static line has no frame clock, so repaint the terminal state directly.
		// Animated widgets re-render the terminal frame on the next host tick.
		if (active.mode === "static") {
			ctx.setWidget(
				WIDGET_KEY,
				[renderRetryLine(active.state, active.state.delayMs, STATIC_WIDTH, ctx.theme)],
				WIDGET_OPTIONS,
			);
		}

		this.#cancelSettle = this.#timer(this.#settleMs, () => {
			this.#cancelSettle = undefined;
			this.#teardownActive(ctx);
		});
	}

	/** Tear down any live episode: dispose the host and clear the widget. Idempotent. */
	dispose(ctx: RetryRadarContext): void {
		this.#cancelPendingSettle();
		this.#teardownActive(ctx);
	}

	#teardownActive(ctx: RetryRadarContext): void {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		if (active.mode === "animated") active.host.dispose();
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#cancelPendingSettle(): void {
		this.#cancelSettle?.();
		this.#cancelSettle = undefined;
	}
}
