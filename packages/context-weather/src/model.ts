import type { ContextUsage, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import {
	type ContextUsageLevel,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/context-thresholds";

/** Pressure level, reused verbatim from the core status-line thresholds. */
export type WeatherLevel = ContextUsageLevel;

/**
 * A truthful pre-compaction forecast, sourced from `ContextUsage`. `tokensUntilCompaction`
 * is `compactionThresholdTokens - tokens` and may be negative once the threshold is passed.
 */
export interface WeatherForecast {
	tokensUntilCompaction: number;
	compactionThresholdTokens?: number;
}

/**
 * Pure visual state the renderer consumes. Derived only from `ContextUsage` +
 * an optional forecast, so it is trivially unit-testable without a TUI.
 */
export interface VisualState {
	/** Pressure tier (normal | warning | purple | error). */
	level: WeatherLevel;
	/** Context fill in `[0, 1]`. */
	fillRatio: number;
	/** Animation speed multiplier; `0` means static (neutral / unknown window). */
	phaseSpeed: number;
	/** Themed foreground color, matching the footer's context indicator. */
	hue: ThemeColor;
	/** True when auto-compaction is near — drives the storm renderer variant. */
	imminent: boolean;
}

export interface ContextWeatherModelOptions {
	/** Fallback storm threshold (context %) when no forecast is available. Default 85. */
	stormAtPercent?: number;
}

/** Default fallback storm threshold — mirrors core's ~15% auto-compaction reserve. */
export const DEFAULT_STORM_AT_PERCENT = 85;

/**
 * Fraction of the context window within which a forecasted `tokensUntilCompaction`
 * is treated as a storm. At a 200k window this is 10k tokens of headroom.
 */
export const IMMINENT_WINDOW_FRACTION = 0.05;

const PHASE_SPEED_BY_LEVEL: Readonly<Record<WeatherLevel, number>> = {
	normal: 0.5,
	warning: 1.0,
	purple: 1.6,
	error: 2.4,
};

/** Extra speed applied to a storm so it reads as urgent even at the same fill. */
const IMMINENT_PHASE_MULTIPLIER = 1.5;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

/** Neutral, static state used when there is no usable usage (no model / zero window). */
function neutralState(): VisualState {
	return {
		level: "normal",
		fillRatio: 0,
		phaseSpeed: 0,
		hue: getContextUsageThemeColor("normal"),
		imminent: false,
	};
}

function resolveImminent(usage: ContextUsage, forecast: WeatherForecast | undefined, stormAtPercent: number): boolean {
	if (forecast && Number.isFinite(forecast.tokensUntilCompaction)) {
		// Truthful path: storm once the real headroom nears the compactor's own threshold.
		const margin = usage.contextWindow * IMMINENT_WINDOW_FRACTION;
		return forecast.tokensUntilCompaction <= margin;
	}
	// Fallback path: percent-based storm threshold.
	return Number.isFinite(usage.percent) && usage.percent >= stormAtPercent;
}

/**
 * Map raw context usage (+ optional truthful forecast) to a pure {@link VisualState}.
 *
 * - `undefined` usage → neutral static state (no NaN).
 * - `contextWindow <= 0` → neutral static state (mirrors `formatContextUsage`'s
 *   unknown-window guard; `0%/0` would misread as a real empty context).
 * - `level` reuses `getContextUsageLevel` (50/70/90% + 150k/270k/500k scale) — not re-derived.
 * - `imminent` uses the forecast when present, else falls back to `stormAtPercent`.
 */
export function contextWeatherModel(
	usage: ContextUsage | undefined,
	forecast?: WeatherForecast,
	options?: ContextWeatherModelOptions,
): VisualState {
	if (!usage) return neutralState();
	if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return neutralState();

	const stormAtPercent = options?.stormAtPercent ?? DEFAULT_STORM_AT_PERCENT;
	const fillRatio = clamp01(usage.percent / 100);
	const level = getContextUsageLevel(usage.percent, usage.contextWindow);
	const imminent = resolveImminent(usage, forecast, stormAtPercent);

	// Calmer/slower when low, quicker as it fills; a storm quickens further.
	const basePhase = PHASE_SPEED_BY_LEVEL[level] * (0.6 + 0.4 * fillRatio);
	const phaseSpeed = imminent ? basePhase * IMMINENT_PHASE_MULTIPLIER : basePhase;

	return {
		level,
		fillRatio,
		phaseSpeed,
		hue: getContextUsageThemeColor(level),
		imminent,
	};
}

/** Structural equality for {@link VisualState}, used to skip no-op repaints. */
export function visualStateEqual(a: VisualState, b: VisualState): boolean {
	return (
		a.level === b.level &&
		a.fillRatio === b.fillRatio &&
		a.phaseSpeed === b.phaseSpeed &&
		a.hue === b.hue &&
		a.imminent === b.imminent
	);
}
