import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import { flameBrightness, flameGlyph, formatUsd, gutterEnvelope, waxBar, waxRemaining } from "./candle";
import type { CostCandleSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type CostCandleTheme = Pick<Theme, "fg">;

/** Width, in columns, of the wax bar. */
const WAX_BAR_WIDTH = 16;

/** Gutter amplitude at `elapsedMs` for `snapshot`, decayed since its last recorded message. Pure. */
function currentGutterAmplitude(snapshot: CostCandleSnapshot, elapsedMs: number): number {
	const msSinceTurn = snapshot.lastMessageAt === undefined ? 0 : elapsedMs - snapshot.lastMessageAt;
	return gutterEnvelope(snapshot.lastGutterPeakIntensity, msSinceTurn);
}

/**
 * Pure renderer: one line combining the flame (flickering in `full` tier,
 * static-calm in `subtle`) with the wax bar and a running total. Deterministic
 * given `snapshot` and `elapsedMs` — no wall-clock reads.
 */
export function renderCostCandleRow(
	snapshot: CostCandleSnapshot,
	elapsedMs: number,
	theme: CostCandleTheme,
	tier: "full" | "subtle",
): string {
	const gutterAmplitude = tier === "full" ? currentGutterAmplitude(snapshot, elapsedMs) : 0;
	const brightness = flameBrightness(elapsedMs, gutterAmplitude);
	const glyph = flameGlyph(brightness);
	const flameColor = gutterAmplitude > 0.5 ? "warning" : gutterAmplitude > 0 ? "accent" : "dim";
	const bar = waxBar(waxRemaining(snapshot.totalCostUsd), WAX_BAR_WIDTH);

	return [theme.fg(flameColor, glyph), theme.fg("dim", bar), theme.fg("dim", formatUsd(snapshot.totalCostUsd))].join(
		" ",
	);
}

/** Static one-line fallback for the motion-`off` tier: total spend and per-message average. */
export function renderCostCandleOffText(snapshot: CostCandleSnapshot): string {
	if (snapshot.messageCount === 0) return "no spend yet";
	return `${formatUsd(snapshot.totalCostUsd)} total · ${formatUsd(snapshot.averageMessageCostUsd)}/msg avg`;
}

/** Minimal clock seam the widget needs — shared with the controller so message timestamps and render reads agree. */
export type CostCandleClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface CostCandleWidgetState {
	snapshot(): CostCandleSnapshot;
}

export interface CostCandleWidgetOptions extends AnimatedWidgetOptions {
	state: CostCandleWidgetState;
	theme: CostCandleTheme;
	/** Same clock the controller stamps message costs with — NOT the host's internal relative elapsed-ms. */
	clock: CostCandleClock;
}

/**
 * Ambient widget for the cost candle. Reads {@link CostCandleClock} rather
 * than `this.elapsedMs` for the same reason as every other Wave 2 feature: a
 * widget that mounts later than the controller's first recorded message
 * must not have its gutter-decay math skewed by the host's own
 * mount-relative clock. `renderFrame` stays pure; the {@link AnimatedWidget}
 * base owns the subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class CostCandleWidget extends AnimatedWidget {
	#state: CostCandleWidgetState;
	#theme: CostCandleTheme;
	#policy: MotionPolicy;
	#clock: CostCandleClock;

	constructor(options: CostCandleWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return [renderCostCandleRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier)];
	}
}
