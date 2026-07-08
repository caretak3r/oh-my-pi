# Changelog

All notable changes to `@oh-my-pi/context-weather` are documented here.

## [Unreleased]

### Added

- Initial Context Weather plugin: an ambient animated barometer of context-window pressure,
  built on the `@oh-my-pi/pi-animation` kit.
  - Pure `contextWeatherModel` mapping `ContextUsage` (+ optional tokens-until-compaction
    forecast) to a `VisualState`, reusing core's `getContextUsageLevel` thresholds.
  - Deterministic `renderBarometer` (`tide` / `bar` / `barometer` styles) with truecolor and
    synchronized-output capability degradation.
  - `ContextWeatherWidget extends AnimatedWidget`, refreshed on `ContextEvent` (not per-frame).
  - Truthful storm / imminent-compaction state with a one-shot notification, coordinated with
    the core auto-compaction loader via `auto_compaction_start` / `auto_compaction_end`.
  - Flat settings: `animations`, `contextWeatherStyle`, `contextWeatherPlacement`,
    `contextWeatherStormAtPercent`, `contextWeatherNotifyOnImminent`, resolved from the
    runtime plugin settings store (set via `omp plugin`, the settings UI, or project
    `plugin-overrides.json`) with env-var fallbacks. Precedence is stored > env > default;
    settings are re-read at mount and on every `context` refresh. `animations` re-resolves
    the motion tier live without a remount, while `contextWeatherStyle`,
    `contextWeatherPlacement`, and `contextWeatherStormAtPercent` remount on the next
    context event.
  - Unit suite plus a deterministic frame-snapshot harness and a mount/dispose leak check.
