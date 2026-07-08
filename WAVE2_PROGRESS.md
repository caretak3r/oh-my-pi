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

**Status:** not started.

## 3. 🌳 Session Bonsai (oh-my-pi-y91)

**Status:** not started.

## 4. ☄️ Todo Meteors (oh-my-pi-060)

**Status:** not started.

## 5. 🫧 Breathing Border (oh-my-pi-t7f)

**Status:** not started.

## Next 10 ideas

Not started — begin after all five Wave 2 features are green.
