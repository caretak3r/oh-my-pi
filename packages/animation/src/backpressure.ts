import type { TUI } from "@oh-my-pi/pi-tui";

/**
 * Read-only render-backpressure signal the animation kit consults to shed
 * frames. It is intentionally tiny: a single `underPressure` boolean the host
 * reads each tick and the {@link MotionPolicy} gates on.
 *
 * The backing data lives in the core TUI render loop (it already tracks
 * per-frame cost to drive adaptive scheduling); {@link backpressureFromTui}
 * adapts the `tui` a widget factory already receives so plugins never reach
 * into scheduler internals.
 */
export interface BackpressureSignal {
	/** True when the host renderer is under render pressure right now. */
	readonly underPressure: boolean;
}

/** A signal that is never under pressure. Useful as a default and in tests. */
export const NO_BACKPRESSURE: BackpressureSignal = { underPressure: false };

/**
 * Adapt the core TUI's read-only backpressure surface into a
 * {@link BackpressureSignal}. Reads live on every access so the host always
 * sees the current pressure state.
 */
export function backpressureFromTui(tui: Pick<TUI, "renderUnderPressure">): BackpressureSignal {
	return {
		get underPressure(): boolean {
			return tui.renderUnderPressure;
		},
	};
}
