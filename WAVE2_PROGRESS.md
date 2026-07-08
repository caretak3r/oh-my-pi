# Wave 2 Animated Plugins — Progress

Tracks implementation status for the five ranked Wave 2 features (see
`IDEA_WIZARD_IDEAS_WAVE2.md` and the `oh-my-pi-c3c` epic). Each feature is a
self-contained atomic commit with passing behavioral tests and a green
`bun check`.

## 1. 🌌 Tool Constellation (oh-my-pi-7tr)

**Status:** done.

**Module:** `packages/coding-agent/src/tool-constellation/` (`categories.ts`,
`sky.ts`, `state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createToolConstellationExtension` pushed as an inline extension
in `sdk.ts` (`createAgentSession`), subscribed to `tool_call`. New shared
`animations` setting added to `settings-schema.ts` (off/subtle/full), same
key the parked `feat/retry-radar` branch introduces — the two branches will
need to reconcile this one schema entry when merged, nothing else overlaps.

**Test command:** `bun test packages/coding-agent/test/tool-constellation.test.ts`
— 23 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- Stars spawn lazily on a tool's first fire rather than pre-seeding every
  `BUILTIN_TOOL_NAMES` entry — a session that only touches a few tools shows
  a mostly-empty sky rather than 31 dim placeholder stars, which reads better
  as "the shape of the work draws itself."
- Category → color uses existing `ThemeColor` tokens (`syntaxVariable`,
  `syntaxFunction`, `toolDiffAdded`, `syntaxKeyword`, `accent`, `syntaxType`)
  rather than inventing new raw-hex theme colors, per the bead's "map from
  theme, don't hardcode raw ANSI" instruction. Hues approximate the bead's
  cyan/amber/green/violet/magenta/teal palette but aren't exact matches.
- Grid-cell hashing is a hand-rolled 32-bit FNV-1a (not `Bun.hash`) so the
  behavioral byte-stable-frame tests don't depend on hash-implementation
  stability across Bun versions.
- Ley-lines only render when the previous and newest fired stars share a
  grid row — arbitrary line-drawing between any two cells in a character
  grid was out of scope for this pass; cross-row transitions simply show no
  connector. Noted as a known simplification, not a bug.
- Fire timestamps (`ConstellationState.recordFire`) and the widget's render
  clock both read the same injected `FrameScheduler.now()`, not the
  `AnimationHost`'s internal relative elapsed-ms. The host only drives
  repaint cadence here; using its relative clock for decay math would skew
  star ages by however long it takes the UI layer to actually invoke the
  widget factory after `setWidget()`.
- The bead's backpressure line ("sheds twinkle → lines → flares in that
  order") describes a 3-step graduated degradation the shared kit's
  `BackpressureSignal` doesn't currently support — it's a single boolean
  (`underPressure`) that forces the whole `MotionPolicy` tier to `off`
  (matching `retry-radar`'s handling exactly). This ships the same binary
  gate; the `subtle` tier (dots only, no twinkle/lines) is the closest
  approximation available without extending the shared kit's backpressure
  primitive to carry a severity level. Flagged here rather than silently
  reinterpreted as "done."

## 2. 〰️ Token Tide (oh-my-pi-i7o)

**Status:** done.

**Module:** `packages/coding-agent/src/token-tide/` (`scale.ts`, `state.ts`,
`widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createTokenTideExtension` pushed as an inline extension in
`sdk.ts` (`createAgentSession`), subscribed to `message_start` /
`message_update` / `message_end` (the streaming-delta events — `turn_end`
alone only fires once a turn is fully settled, too coarse for a live
oscilloscope). Reuses the existing shared `animations` setting; no new
settings-schema entries.

**Test command:** `bun test packages/coding-agent/test/token-tide.test.ts`
— 28 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- The bead's grounded signal, `calculateTokensPerSecond` in
  `status-line/token-rate.ts`, is reused verbatim (not recomputed) by feeding
  it a single-element array holding just the in-flight assistant message —
  the function only ever looks at the last assistant message anyway, so the
  controller doesn't need the full session message history, which
  `ExtensionContext` doesn't expose to inline extensions in the first place.
- Two distinct clocks are threaded through this feature, unlike
  Tool Constellation's single shared clock: the `AnimationHost`'s relative
  `FrameScheduler` (repaint cadence + the idle resting-pulse phase) and a
  separate wall-clock (`WallClock`, defaulting to `Date.now`) used only to
  evaluate `calculateTokensPerSecond` against message `timestamp`s, which are
  Unix-epoch-based. Conflating the two would either break the pulse's
  test-determinism or silently miscompute throughput.
- `message_end` clears the tracked in-flight message rather than leaving its
  now-fixed duration/usage in place. Once a message finalizes, its computed
  average rate would otherwise read as a stable non-zero throughput forever
  (until the next message starts) instead of settling toward the bead's
  "between turns -> near-flat line" idle state.
- Amplitude normalizes against a fixed `MAX_REFERENCE_RATE` (160 tok/s)
  reference ceiling rather than an adaptive/rolling max — simpler and
  deterministic, at the cost of not auto-scaling to a given model's typical
  throughput ceiling. Flagged as a known simplification.
- Rate buckets (idle/low/medium/high/burst) drive both the waveform glyph
  color and the VU bar color, mapped onto existing `ThemeColor` tokens
  (`syntaxType` -> `syntaxVariable` -> `syntaxFunction` -> `warning`) per the
  bead's cool-teal-to-hot-amber palette, same "reuse the theme, don't invent
  raw ANSI" rule Tool Constellation established.
- Like `retry-radar` and Tool Constellation, `backpressureFromTui(tui)` is
  not wired into the `AnimationHost` construction: the shared `tui` handle is
  only available inside the widget factory callback, after the host already
  exists. This is a structural property of the shared kit's mount sequence,
  not a regression specific to this feature.

## 3. 🌳 Session Bonsai (oh-my-pi-y91)

**Status:** not started.

## 4. ☄️ Todo Meteors (oh-my-pi-060)

**Status:** not started.

## 5. 🫧 Breathing Border (oh-my-pi-t7f)

**Status:** not started.

## Next 10 ideas

Not started — begin after all five Wave 2 features are green.
