# Changelog

## [Unreleased]

### Added

- Initial `@oh-my-pi/pi-animation` package: the shared animation foundation for ambient TUI plugins.
  - `AnimationHost` — a single coalesced frame clock. N subscribers share one underlying timer (via an injectable clock/scheduler seam); the timer stops when the last subscriber leaves and restarts on re-subscribe. Each tick reports a monotonic frame index and time-based elapsed-ms so effects derive phase from time and stay smooth across skipped frames.
  - `MotionPolicy` — resolves the effective tier (`off | subtle | full`) from the `animations` setting, with hard gates that force `off` (no UI, non-TTY stdout, `NO_COLOR`, `CI`, `TERM=dumb`, or render backpressure). Notifies subscribers when the resolved tier changes.
  - `AnimatedWidget` — a `Component` base that subscribes to an `AnimationHost` on mount, repaints scoped via `tui.requestComponentRender(this)` only when rendered text changes, and tracks live `MotionPolicy` tier changes. It starts/stops the frame-clock subscription with a forced repaint when the tier crosses off<->on at runtime, no remount needed; `dispose()` detaches from both the host and the policy. Tier `off` renders one static frame.
  - `BackpressureSignal` — a read-only render-under-pressure reader the kit consults to shed frames; the core TUI exposes `renderUnderPressure` / `lastFrameCostMs` for the widget factory's `tui` to feed it.
