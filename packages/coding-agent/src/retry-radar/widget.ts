import type { AnimatedWidgetOptions } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "../modes/theme/theme";
import { ringGlyph, ringRemaining, secondsRemaining, shortReason } from "./ring";

/**
 * Lifecycle phase of a single retry episode:
 * - `waiting`: backing off; the ring drains and the seconds count down.
 * - `recovered`: the retry succeeded; settle green.
 * - `gaveup`: retries exhausted; settle red with the final error.
 */
export type RetryPhase = "waiting" | "recovered" | "gaveup";

/**
 * Mutable model the controller owns and the widget renders. The controller
 * flips {@link RetryRadarState.phase} on `auto_retry_end` and the next frame
 * picks it up — no re-mount needed.
 */
export interface RetryRadarState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	/** Already-shortened reason token (see {@link shortReason}). */
	reason: string;
	phase: RetryPhase;
	/** Final provider error, set when `phase === "gaveup"`. */
	finalError?: string;
}

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type RetryRadarTheme = Pick<Theme, "fg">;

const CHECK = "✔";
const CROSS = "✘";

/**
 * Pure, single-line renderer shared by the animated widget and the static
 * (motion-`off`/non-TTY) fallback. `elapsedMs` is the animation phase; for the
 * static line callers pass `delayMs` to render the initial "N seconds left".
 */
export function renderRetryLine(
	state: RetryRadarState,
	elapsedMs: number,
	width: number,
	theme: RetryRadarTheme,
): string {
	const attempts = `${state.attempt}/${state.maxAttempts}`;
	if (state.phase === "recovered") {
		return truncateToWidth(theme.fg("success", `${CHECK} retry ${attempts} · recovered`), width);
	}
	if (state.phase === "gaveup") {
		const detail = state.finalError ? ` · ${shortReason(state.finalError, Math.max(8, width - 24))}` : "";
		return truncateToWidth(theme.fg("error", `${CROSS} retry ${attempts} failed${detail}`), width);
	}
	const remaining = ringRemaining(elapsedMs, state.delayMs);
	const glyph = ringGlyph(remaining);
	const secs = secondsRemaining(elapsedMs, state.delayMs);
	const reason = state.reason ? ` · ${state.reason}` : "";
	return truncateToWidth(theme.fg("warning", `${glyph} retry ${attempts}${reason} · ${secs}s`), width);
}

export interface RetryRadarWidgetOptions extends AnimatedWidgetOptions {
	state: RetryRadarState;
	theme: RetryRadarTheme;
}

/**
 * Ambient animated widget for the auto-retry countdown ring. A thin renderer
 * over the shared {@link RetryRadarState}: each frame it draws one line from the
 * model and the host-driven phase. The {@link AnimatedWidget} base owns the
 * subscribe-on-mount / unsubscribe-on-dispose lifecycle and the repaint-only-on-
 * change diff guard, so once a terminal phase freezes the output the widget
 * stops requesting repaints on its own.
 */
export class RetryRadarWidget extends AnimatedWidget {
	#state: RetryRadarState;
	#theme: RetryRadarTheme;

	constructor(options: RetryRadarWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
	}

	renderFrame(width: number): readonly string[] {
		return [renderRetryLine(this.#state, this.elapsedMs, width, this.#theme)];
	}
}
