# Context Weather

An ambient, animated terminal barometer for **context-window pressure**. It rides the
shared [`@oh-my-pi/pi-animation`](../animation) kit: one coalesced frame clock, motion-policy
gating, and the `AnimatedWidget` base. Context Weather *augments* the existing footer context
indicator — it does not replace it — and warns **before** auto-compaction with a truthful
storm, tied to the compactor's own tokens-until-compaction forecast.

## What you see

- A one-line barometer above (or below) the editor, colored to match the footer's context
  level (`normal → warning → purple → error`), with a percent readout.
- Three glyph styles: `tide` (default), `bar`, `barometer`.
- A **storm** variant (`⚡`, pulsing amber→red) when auto-compaction is near. The storm reads
  the real `tokensUntilCompaction` forecast when the model exposes it, and otherwise falls back
  to a configurable percent threshold.

Motion is **opt-in**: `animations` defaults to `off` (a static bar that still updates on every
context change). The policy hard-gates to `off` on non-TTY / `CI` / `NO_COLOR` / `TERM=dumb`
and while the renderer is under back-pressure, so it never fights the TUI.

## Settings

Flat manifest keys (`PluginManifest.settings`), each also readable from an env var fallback:

| Setting                          | Env var                                 | Values / default                        |
| -------------------------------- | --------------------------------------- | --------------------------------------- |
| `animations`                     | `OMP_CONTEXT_WEATHER_ANIMATIONS`        | `off` \| `subtle` \| `full` — `off`     |
| `contextWeatherStyle`            | `OMP_CONTEXT_WEATHER_STYLE`             | `tide` \| `bar` \| `barometer` — `tide` |
| `contextWeatherPlacement`        | `OMP_CONTEXT_WEATHER_PLACEMENT`         | `aboveEditor` \| `belowEditor` — `aboveEditor` |
| `contextWeatherStormAtPercent`   | `OMP_CONTEXT_WEATHER_STORM_AT_PERCENT`  | number `0..100` — `85`                  |
| `contextWeatherNotifyOnImminent` | `OMP_CONTEXT_WEATHER_NOTIFY_ON_IMMINENT`| boolean — `true`                        |

Settings are read from the runtime plugin settings store (set them via `omp plugin` or the
settings UI; project-local overrides live in `.omp/plugin-overrides.json`), with each env var
as a fallback: **stored setting > env var > default**. `animations` re-resolves the motion tier
live (on the next context event) without remounting; `contextWeatherStyle` /
`contextWeatherPlacement` / `contextWeatherStormAtPercent` remount the widget on the next
context event. Unknown values fall back to defaults.

## Dev-load (run `omp` with this plugin active)

This package lives in the monorepo, so `omp` can load its extension entry directly. From the
repo root:

```bash
# Point omp's extensions config at this plugin's entry module.
omp --extensions packages/context-weather/src/extension.ts

# Or via the env-var seam, enabling motion for the session:
OMP_CONTEXT_WEATHER_ANIMATIONS=full \
  omp --extensions packages/context-weather/src/extension.ts
```

As a standalone plugin package, install/link it and let the manifest's `omp.extensions`
entry resolve (the plugin loader reads `package.json → omp`):

```bash
omp plugin install ./packages/context-weather   # or a published tarball / git URL
```

The widget mounts on `session_start` and disposes on `session_shutdown` / `session_switch`.

## Manual acceptance walkthrough (the visual bits)

Automated snapshots cover determinism, width, degradation, and mount/dispose leak-safety
(`bun test`). The animated feel is confirmed by hand:

1. `OMP_CONTEXT_WEATHER_ANIMATIONS=full omp --extensions packages/context-weather/src/extension.ts`.
2. Grow the conversation and watch the bar climb through each level — the color must track the
   footer's context indicator (`normal → warning → purple → error`).
3. Cross the storm threshold (near auto-compaction, or lower `contextWeatherStormAtPercent`).
   The bar switches to the `⚡` storm variant (pulsing amber→red) and a one-shot notification
   fires once — and **not** while the core auto-compaction loader is already running.
4. Let compaction happen; the storm settles back to a calm frame afterward.
5. Set `animations=off` (default) and confirm the bar is static but still jumps to the correct
   level as context grows.

## Layout

- `src/model.ts` — pure `contextWeatherModel(usage, forecast?, opts?) → VisualState`.
- `src/renderer.ts` — deterministic `renderBarometer(state, phase, theme, width, opts?)`.
- `src/widget.ts` — `ContextWeatherWidget extends AnimatedWidget` (cached state + phase draw).
- `src/settings.ts` — flat settings resolver + env-var seam + `WidgetPlacement` mapping.
- `src/extension.ts` — the omp extension entry: mount/refresh/storm/dispose wiring.
