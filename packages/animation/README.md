# @oh-my-pi/pi-animation

Shared animation foundation for ambient oh-my-pi TUI plugins.

This package owns the primitives that every animated plugin reuses, so the whole
family shares **one** timer, **one** cadence policy, and **one** cleanup path:

- **`AnimationHost`** — a single coalesced frame clock. Any number of subscribers
  share one underlying timer (an injectable clock/scheduler seam keeps tests
  deterministic). The timer stops when the last subscriber leaves and restarts on
  re-subscribe. Each tick reports a monotonic frame index and a time-based
  elapsed-ms so effects derive phase from wall time and stay smooth across skipped
  frames.
- **`MotionPolicy`** — resolves the effective tier (`off | subtle | full`) from the
  `animations` setting, with hard gates that force `off` regardless of the setting
  (no UI, non-TTY stdout, `NO_COLOR`, `CI`, `TERM=dumb`, or render backpressure).
  Subscribers are notified when the resolved tier changes.
- **`AnimatedWidget`** — a `Component` base that subscribes to a host on mount,
  repaints component-scoped via `tui.requestComponentRender(this)` only when the
  rendered text changed, and tracks live `MotionPolicy` tier changes: an off<->on
  crossing starts or stops the frame-clock subscription with a forced repaint,
  no remount needed. `dispose()` unsubscribes from both the host and the policy
  and is idempotent. Under tier `off` it renders one static frame.
- **`BackpressureSignal`** — a read-only "render under pressure" reader that the kit
  consults to shed frames. The core TUI exposes the backing signal
  (`renderUnderPressure` / `lastFrameCostMs`) through the `tui` a widget factory
  already receives, so plugins never reach into scheduler internals.

Widgets (Context Weather, Compaction Vacuum, Retry Radar, …) live in separate
packages and consume this foundation.
