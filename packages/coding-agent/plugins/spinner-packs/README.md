# Spinner Personality Packs

Themed spinner frames and animated gradient colorizers for the oh-my-pi
working/loading indicator. Rides the existing `Loader` API only — no runtime
patching, no dependency on any shared animation kit.

## Packs

| Pack           | Vibe                                             |
| -------------- | ------------------------------------------------ |
| `fire`         | Flickering ember gradient, red through amber     |
| `ocean`        | Rolling deep-blue to cyan swell                  |
| `matrix`       | Cascading terminal green rain                    |
| `synthwave`    | Neon magenta / violet / cyan sunset              |
| `aurora`       | Northern-lights green into violet                |
| `dots-classic` | Familiar braille dots with a subtle shimmer      |
| `pulse`        | Breathing single-hue heartbeat                   |
| `reactive`     | VU-meter gradient that speeds up with throughput |

## Usage

Select a pack via the appearance settings (`Spinner Pack`) or set it directly:

```
display.spinnerPack: fire
```

`default` keeps the theme spinner with the standard shimmer. The `/spinner`
command also switches packs.

## Behavior & capability degradation

- The gradient sweeps at 30fps while streaming when animations are on.
- Animations follow the `display.shimmer` toggle. With shimmer `disabled` the
  pack shows a **static** gradient (no animated repaint).
- True-color terminals get 24-bit gradients; without true color the same
  gradient is quantized to the xterm-256 palette.
- With no color at all (non-TTY, `NO_COLOR`, or `CI`) the indicator stays plain
  text — no escape sequences are emitted.

## Implementation

The pack registry, capability detection, and the deterministic gradient
colorizer live in `packages/coding-agent/src/modes/theme/spinner-packs.ts`.
Selection is the core `display.spinnerPack` setting, read where the interactive
mode constructs the working `Loader`.
