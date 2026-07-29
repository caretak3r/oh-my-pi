import type { MotionSetting } from "@oh-my-pi/pi-animation";
import type { WidgetPlacement } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_STORM_AT_PERCENT } from "./model";
import type { ContextWeatherStyle } from "./renderer";

/** Fully-resolved, validated Context Weather configuration. */
export interface ContextWeatherSettings {
	/**
	 * Motion override consumed by the kit's `MotionPolicy`. When absent from the
	 * plugin store and environment, Context Weather inherits the core tier. The
	 * local policy can force less motion, but the shared host cannot exceed core.
	 */
	animations: MotionSetting;
	/** Barometer glyph style. */
	style: ContextWeatherStyle;
	/** Mapped `WidgetPlacement` for `ctx.ui.setWidget`. */
	placement: WidgetPlacement;
	/** Fallback storm threshold (context %) when no forecast is available. */
	stormAtPercent: number;
	/** Whether to fire the one-shot imminent notification. */
	notifyOnImminent: boolean;
}

export const CONTEXT_WEATHER_DEFAULTS: ContextWeatherSettings = {
	animations: "full",
	style: "tide",
	placement: "aboveEditor",
	stormAtPercent: DEFAULT_STORM_AT_PERCENT,
	notifyOnImminent: true,
};

/** Flat manifest setting keys (keys do not nest — `PluginManifest.settings` is flat). */
export const SETTING_KEYS = {
	animations: "animations",
	style: "contextWeatherStyle",
	placement: "contextWeatherPlacement",
	stormAtPercent: "contextWeatherStormAtPercent",
	notifyOnImminent: "contextWeatherNotifyOnImminent",
} as const;

/** Env-var fallbacks mirroring each setting's manifest `env` field. */
export const SETTING_ENV = {
	animations: "OMP_CONTEXT_WEATHER_ANIMATIONS",
	style: "OMP_CONTEXT_WEATHER_STYLE",
	placement: "OMP_CONTEXT_WEATHER_PLACEMENT",
	stormAtPercent: "OMP_CONTEXT_WEATHER_STORM_AT_PERCENT",
	notifyOnImminent: "OMP_CONTEXT_WEATHER_NOTIFY_ON_IMMINENT",
} as const;

const MOTION_VALUES: readonly MotionSetting[] = ["off", "subtle", "full"];
const STYLE_VALUES: readonly ContextWeatherStyle[] = ["tide", "bar", "barometer"];
const PLACEMENT_VALUES: readonly WidgetPlacement[] = ["aboveEditor", "belowEditor"];

function resolveEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
	return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function resolveNumber(raw: unknown, fallback: number, min: number, max: number): number {
	const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function resolveBoolean(raw: unknown, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return fallback;
}

/**
 * Resolve a flat raw settings record (manifest values or env fallbacks) into a
 * fully-validated {@link ContextWeatherSettings}. Unknown/malformed values fall
 * back to defaults; `contextWeatherPlacement` maps 1:1 to `WidgetPlacement`.
 */
export function resolveContextWeatherSettings(
	raw: Record<string, unknown>,
	motionFallback: MotionSetting = CONTEXT_WEATHER_DEFAULTS.animations,
): ContextWeatherSettings {
	return {
		animations: resolveEnum(raw[SETTING_KEYS.animations], MOTION_VALUES, motionFallback),
		style: resolveEnum(raw[SETTING_KEYS.style], STYLE_VALUES, CONTEXT_WEATHER_DEFAULTS.style),
		placement: resolveEnum(raw[SETTING_KEYS.placement], PLACEMENT_VALUES, CONTEXT_WEATHER_DEFAULTS.placement),
		stormAtPercent: resolveNumber(raw[SETTING_KEYS.stormAtPercent], CONTEXT_WEATHER_DEFAULTS.stormAtPercent, 0, 100),
		notifyOnImminent: resolveBoolean(raw[SETTING_KEYS.notifyOnImminent], CONTEXT_WEATHER_DEFAULTS.notifyOnImminent),
	};
}

/**
 * Build a raw (unresolved) settings record from environment variables, each
 * manifest setting declares a matching `env` fallback. Absent vars are omitted
 * so {@link resolveContextWeatherSettings} applies defaults.
 */
export function readContextWeatherEnvRaw(env: Record<string, string | undefined> = Bun.env): Record<string, unknown> {
	const raw: Record<string, unknown> = {};
	const animations = env[SETTING_ENV.animations];
	if (animations !== undefined) raw[SETTING_KEYS.animations] = animations;
	const style = env[SETTING_ENV.style];
	if (style !== undefined) raw[SETTING_KEYS.style] = style;
	const placement = env[SETTING_ENV.placement];
	if (placement !== undefined) raw[SETTING_KEYS.placement] = placement;
	const storm = env[SETTING_ENV.stormAtPercent];
	if (storm !== undefined) raw[SETTING_KEYS.stormAtPercent] = storm;
	const notify = env[SETTING_ENV.notifyOnImminent];
	if (notify !== undefined) raw[SETTING_KEYS.notifyOnImminent] = notify;
	return raw;
}

/** Resolve settings from environment variables alone (the documented env seam). */
export function readContextWeatherSettingsFromEnv(
	env: Record<string, string | undefined> = Bun.env,
	motionFallback: MotionSetting = CONTEXT_WEATHER_DEFAULTS.animations,
): ContextWeatherSettings {
	return resolveContextWeatherSettings(readContextWeatherEnvRaw(env), motionFallback);
}

/**
 * Resolve settings from both sources with the manifest-documented precedence:
 * stored plugin setting > env-var fallback > core motion fallback/default.
 * Nullish stored values are skipped so a cleared setting falls through to the
 * env var, then the supplied core tier. A local tier is an override; production
 * uses the shared core host, so it cannot raise motion above the core tier.
 */
export function resolveContextWeatherSettingsFromSources(
	pluginSettings: Record<string, unknown>,
	env: Record<string, string | undefined> = Bun.env,
	motionFallback: MotionSetting = CONTEXT_WEATHER_DEFAULTS.animations,
): ContextWeatherSettings {
	const raw = readContextWeatherEnvRaw(env);
	for (const [key, value] of Object.entries(pluginSettings)) {
		if (value !== undefined && value !== null) raw[key] = value;
	}
	return resolveContextWeatherSettings(raw, motionFallback);
}
