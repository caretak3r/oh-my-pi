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

**Status:** done.

**Module:** `packages/coding-agent/src/session-bonsai/` (`tree.ts`,
`growth.ts`, `state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createSessionBonsaiExtension` pushed as an inline extension in
`sdk.ts` (`createAgentSession`), subscribed to `session_branch` /
`session_tree`. Neither event payload carries the tree itself (just a signal
that it, or the active leaf, changed), so the controller re-derives it each
time from `ctx.sessionManager.getTree()` / `getLeafId()`. Reuses the existing
shared `animations` setting; no new settings-schema entries.

**Test command:** `bun test packages/coding-agent/test/session-bonsai.test.ts`
— 32 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- `getTree()` returns the full entry-level tree (one `SessionTreeNode` per
  message, not per branch), so `tree.ts`'s `buildBonsaiTree` collapses every
  linear single-child run down to an edge — surviving nodes are exactly the
  session's real branch points and leaves. This is what makes "graceful past
  ~5 branches" a leaf-count problem rather than a message-count one.
- `tree.ts` operates on a minimal `RawTreeNode { id, children }` shape,
  decoupled from the real `SessionTreeNode`/`SessionEntry` union (mirroring
  Tool Constellation's `sky.ts` decoupling from tool-name types) so the
  collapsing/pruning/rank math is independently testable with plain literal
  objects; the controller adapts the real tree at the call site.
- Spawn timestamps (driving the ~1s unfurl) and the widget's render clock
  both read the same injected `FrameScheduler`, not the `AnimationHost`'s
  internal relative elapsed-ms — same rationale as Tool Constellation/Token
  Tide: the host only drives repaint cadence, so growth math stays correct
  regardless of when the UI layer invokes the widget factory.
- The very first `BonsaiState.update()` call seeds every observed node as an
  already-grown baseline (spawn stamped `UNFURL_DURATION_MS` in the past)
  rather than animating an unfurl — resuming a session that already has
  branches shouldn't replay their growth on mount. Only branches that appear
  in a *later* update genuinely unfurl.
- Pruning past `MAX_DISPLAYED_LEAVES` (5) always keeps the active leaf, then
  fills the remaining budget with the most-recently-spawned other leaves
  (ties broken by original left-to-right order for determinism), preserving
  every kept leaf's ancestors so the remaining tree shape stays legible. A
  trailing `⋯ +N more` line reports what's hidden — never a silent drop.
- Tip "shimmer" (active leaf) and bud-growth glyphs use a small local glyph
  ramp (`.`/`o`/`0` while unfurling, `✦` resting, `❋` mid-shimmer-blip)
  rather than reusing Tool Constellation's star glyphs — different visual
  vocabulary for a different metaphor, deliberately not shared.
- Like `retry-radar`/Tool Constellation/Token Tide, `backpressureFromTui(tui)`
  is not wired into the `AnimationHost` construction (same structural mount-
  sequence property, not a regression here).

## 4. ☄️ Todo Meteors (oh-my-pi-060)

**Status:** done.

**Module:** `packages/coding-agent/src/todo-meteors/` (`ember.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createTodoMeteorsExtension` pushed as an inline extension in
`sdk.ts` (`createAgentSession`), subscribed to `tool_result` (filtered to
the `todo` tool) and `todo_reminder`. Widget placed `aboveEditor` per the
bead. Reuses the existing shared `animations` setting; no new
settings-schema entries.

**Test command:** `bun test packages/coding-agent/test/todo-meteors.test.ts`
— 31 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations (grounding-signal deviation from
the bead — documented per the "verify each grounding signal is real" rule):**
- The bead names `todo_reminder`'s `todos` array as the diff source for
  completions. Verified against `agent-session.ts` (`#checkTodoCompletion`,
  ~line 11245): that array is `incomplete` — the engine pre-filters it to
  `pending`/`in_progress` tasks only, and the event fires only when the agent
  *stops with incomplete work* (a nag, capped by `todo.reminders.max`). A
  session where the agent completes every todo without ever pausing on an
  incomplete one would never fire a single `todo_reminder`, so relying on it
  alone would leave the ember row permanently empty and no meteor would ever
  launch in the common "everything went fine" case — the opposite of
  "celebratory."
- The actual primary signal is the `todo` tool's own `tool_result` event:
  `details.phases` (full status list, all four statuses) plus
  `details.completedTasks` — a `{phase, content}[]` diff the engine itself
  computes via `getCompletionTransitions` in `tools/todo.ts` and already uses
  to drive the strike-through animation in the todo list UI. This is a
  strictly stronger, more-frequently-firing, already-battle-tested signal, so
  the controller reuses it verbatim instead of re-deriving completions from a
  second, possibly-diverging phase-to-phase diff of its own. `todo_reminder`
  is still wired, but only for what it uniquely provides: `attempt`/
  `maxAttempts` reminder pressure, which drives the urgency pulse.
- `TodoItem` carries only `{content, status}` in this codebase — no `id`, no
  `priority` field, despite the bead's "keyed by todo id" / "brightness by
  priority" language. Identity uses the same `phase\0content` composite key
  `tools/todo.ts`'s own `getCompletionTransitions` uses internally (no `id`
  field exists to key on). "Priority" is reinterpreted as status ranking
  (`in_progress` brighter than `pending`), matching the todo tool's own
  existing `accent`/`dim` status-coloring convention — the closest real
  analog available, not an invented field.
- Tasks that leave the incomplete set without a matching `completedTasks`
  entry (abandoned, or removed by an `rm`/`init` op) are dropped from the
  ember row silently — no meteor. Meteors are reserved for genuine
  completions per the bead's "celebratory" framing.
- `goal_updated` (the bead's "optionally... for overall progress framing")
  was not wired — `todo_reminder` + `tool_result` already fully cover the
  bead's render/motion/test requirements, and adding a second progress
  signal with no corresponding acceptance criterion would be scope creep.
- Ember rows cap at 12 shown (`MAX_EMBERS_SHOWN`) with a `+N` trailer past
  that, mirroring Session Bonsai's `MAX_DISPLAYED_LEAVES` pruning pattern —
  keeps the thin `aboveEditor` strip legible for large todo lists.
- Meteor launch timestamps and the widget's render clock both read the same
  injected `FrameScheduler`, not the `AnimationHost`'s internal relative
  elapsed-ms — same rationale as every prior Wave 2 feature.
- Like every prior Wave 2 feature, `backpressureFromTui(tui)` is not wired
  into the `AnimationHost` construction (same structural mount-sequence
  property: `tui` is only available inside the widget factory callback,
  after the host already exists — not a regression here).

## 5. 🫧 Breathing Border (oh-my-pi-t7f)

**Status:** done.

**Module:** `packages/coding-agent/src/breathing-border/` (`breath.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createBreathingBorderExtension` pushed as an inline extension in
`sdk.ts` (`createAgentSession`), subscribed to `agent_start` / `agent_end` /
`turn_start` / `turn_end`. Reuses the existing shared `animations` setting;
no new settings-schema entries.

**Test command:** `bun test packages/coding-agent/test/breathing-border.test.ts`
— 34 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- There is no real "editor frame border" hook in the extension surface — only
  `aboveEditor`/`belowEditor` widget placement exists (`WidgetPlacement` in
  `extensibility/extensions/types.ts`). The feature is approximated as a
  single-row `aboveEditor` widget drawing a full-width border-style line,
  matching the placement pattern every other Wave 2 widget already uses.
  Flagged as a scoped interpretation, not a literal terminal-chrome border.
- The bead's "a faint luminance pulse travels the border" is interpreted as:
  a resting dim border line (`─`, `borderMuted`) with a single brighter glyph
  that travels one lap per breath cycle, reusing the *same* envelope function
  for both the glyph's brightness and its lap position (`breathEnvelope`
  peaks mid-cycle, and the lap position is driven by the identical phase
  fraction) — so the pulse fades in from one end, peaks brightest mid-lap,
  and fades out by the far end, rather than a constant-brightness dot. This
  keeps one pure function driving both axes instead of inventing a second,
  independent position curve.
- `subtle` tier: only the two corner glyphs (row's first/last cell) carry the
  breathing brightness token; the middle span is always the flat `borderMuted`
  resting character. This holds during both the continuous `active` breathing
  and the `exhaling` wind-down — `subtle` never renders a traveling pulse.
- The wind-down exhale (`exhaleEnvelope`) is a fixed 1->0 cosine decay over a
  constant `EXHALE_DURATION_MS`, independent of the breath phase at the exact
  moment `agent_end` fires (no continuity splice with the in-progress
  inhale/exhale). "One slow exhale" reads as a predictable, always-the-same
  wind-down rather than a phase-continuous fade — simpler and fully
  deterministic, at the cost of a potential small visual "snap" to the decay
  curve's start. Flagged as a known simplification.
- `turn_start`/`turn_end` modulate the breath period from the just-finished
  turn's wall-clock duration (`breathPeriodMsForTurnDuration`, clamped between
  `MIN_BREATH_PERIOD_MS` and `MAX_BREATH_PERIOD_MS`) — both events are
  measured against the injected clock (`FrameScheduler.now()`), not the raw
  event payload's own `timestamp` field (`turn_start.timestamp` is
  epoch/wall-clock-based while the shared clock used everywhere else in this
  kit is relative-monotonic; mixing the two would reintroduce the same
  dual-clock skew documented for Token Tide). `turn_end` carries no timestamp
  field at all, so this is the only viable measurement anyway.
- **Backpressure is wired for real this time**, unlike every prior Wave 2
  feature (all of which left `backpressureFromTui` unwired as a documented
  limitation): this bead's headline acceptance criterion is "must freeze
  instantly on backpressure," so `MotionPolicy.setEnvironment(...,
  backpressure: backpressureFromTui(tui))` is called once the widget factory
  receives the real `tui`, and the widget's own `onFrame` calls
  `policy.refresh()` every tick to re-resolve the tier from the live signal.
  A sustained-pressure frame flips the tier to `off`, which the shared
  `AnimatedWidget` base already turns into an immediate host-unsubscribe +
  forced repaint (no lingering animation) — this reuses existing kit
  plumbing (`MotionPolicy`'s backpressure hard-gate) rather than the
  alternate lower-level `AnimationHost`-owned `backpressure` frame-skip
  option, which would have required deferring host construction into the
  widget factory (the host is otherwise created synchronously in
  `#mountWidget`, before `tui` is available).
- Unlike the other four features (whose animated mount is permanent for the
  extension's lifetime once first created), Breathing Border tears itself
  back down to a fully static widget once the post-`agent_end` exhale
  settles into `idle` — disposing the `AnimationHost` outright rather than
  just leaving it idling — so a fully idle session really does carry zero
  frame-clock subscriptions (per the bead's own acceptance test), not just an
  animated widget whose rows stopped changing. A later `agent_start` builds a
  fresh `MotionPolicy`/`AnimationHost`/widget from scratch.

## Next 10 ideas

### 6. 🪰 Agent Fleet (oh-my-pi-4e8)

**Status:** done.

**Module:** `packages/coding-agent/src/agent-fleet/` (`firefly.ts`, `state.ts`,
`widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createAgentFleetExtension` pushed as a sixth inline extension in
`sdk.ts` (`createAgentSession`), alongside the five ranked Wave 2 features.
Subscribes on `session_start` and unsubscribes on `session_shutdown`. Reuses
the existing shared `animations` setting; no new settings-schema entries.
New `./agent-fleet` and `./agent-fleet/*` package.json export paths.

**Test command:** `bun test packages/coding-agent/test/agent-fleet.test.ts`
— 37 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- **Re-grounded the signal.** The idea doc's original grounding ("`Agent`-tool
  `tool_call`s + agent lifecycle") doesn't hold up: the `Agent`/`task` tool's
  own events only bookend a subagent's lifetime and carry no notion of
  `idle` vs `parked` vs `aborted`. The actual authoritative, already-live
  signal is `registry/agent-registry.ts`'s `AgentRegistry` — every subagent
  spawn/finish/abort already flows through `AgentRegistry.register()` /
  `.setStatus()` (see `task/executor.ts`), and `AgentRegistry.onChange(...)`
  gives a real event stream (`registered`/`status_changed`/`removed`) with
  exactly the states the bead's "bright/fade/red-blink" metaphor needs.
- **Not an `ExtensionContext` event.** Unlike every other Wave 2 feature,
  this signal isn't part of the extension event union — `AgentRegistry` is a
  direct process-global singleton, the same seam `collab/host.ts` and
  `modes/controllers/tan-command-controller.ts` already read from. The
  controller takes the registry as an injected `AgentFleetRegistrySource`
  (structurally just `onChange`), defaulting to `AgentRegistry.global()`
  only at the `index.ts` wiring site — tests never touch the real
  process-global singleton, using an in-memory fake instead.
- **One captured context, not one per event.** Every other Wave 2 controller
  rebuilds its mapped `XContext` fresh on every `ctx.on(...)` callback (since
  `ExtensionContext` is reconstructed per dispatch — see
  `extensions/runner.ts#createContext`). Registry events fire independently
  of the extension dispatch loop, so there's no fresh `ctx` available when
  one arrives. The controller instead captures one mapped context from
  `session_start` (fired once, early) and reuses it for the life of the
  subscription — safe because `ctx.ui` is the same stable object underneath
  every `createContext()` call, so a `setWidget` closure captured once still
  routes to the live UI much later. Confirmed by reading `runner.ts`:
  `ui: this.#uiContext` is a stable per-runner field, not rebuilt per call.
- **Scoped to all live subagents, not just this session's direct children.**
  `AgentRegistry` is process-wide, so in principle a session could filter to
  only its own `parentId` subtree. `ExtensionContext` doesn't expose "my own
  agent id" to make that filter possible cheaply, and — more importantly —
  the codebase already has a precedent for the simpler, unscoped choice:
  `modes/running-subagent-badge.ts`'s existing subagent-count badge filters
  only on `kind === "sub"`, with no parent scoping either. Agent Fleet
  mirrors that same convention rather than inventing a stricter one.
- **"Drifting" is a bounded per-firefly wobble, not a 2D roaming field.**
  Tool Constellation already claimed the "spatial grid" visual; to stay
  legible in a thin strip and keep frames byte-stable/testable, each firefly
  gets a fixed-width 3-column cell and wobbles left/center/right within it
  (a sine wave phase-offset by an FNV-1a hash of the agent id, so fireflies
  don't move in lockstep) — plus a breathing/fading/blinking brightness
  curve per status. This reads as "alive and drifting" without a full
  pixel-position canvas.
- `idle` and `parked` (`AgentStatus`) both map to the same `done` firefly
  visual — the revivable-vs-not distinction has no useful visual analog here.
  `status_changed`/`registered` for an unseen id upserts implicitly (treated
  as a first sighting) so a controller that started watching mid-flight (or
  missed an earlier event) still converges instead of staying silently wrong.
  `removed` deletes immediately, bypassing any fade — it's a hard teardown
  signal, not a status the fade/blink curves apply to.
- Reuses the existing `statusLineSubagents` theme color (already the color
  of the status-line's live subagent-count badge) for `working` fireflies,
  rather than inventing a new color — same concept, same color.

### 7. 🕯️ Cost Candle (oh-my-pi-acf)

**Status:** done.

**Module:** `packages/coding-agent/src/cost-candle/` (`candle.ts`, `state.ts`,
`widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createCostCandleExtension` pushed as a seventh inline extension
in `sdk.ts` (`createAgentSession`), subscribed to `message_end`. Reuses the
existing shared `animations` setting; no new settings-schema entries. New
`./cost-candle` and `./cost-candle/*` package.json export paths.

**Test command:** `bun test packages/coding-agent/test/cost-candle.test.ts`
— 24 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- **Grounding held up as specified**, unlike Agent Fleet's re-grounding.
  `message.usage.cost.total` (`packages/catalog/src/types.ts`'s `Usage.cost`)
  is already a computed USD dollar amount — populated by `calculateCost`
  inline in every provider stream implementation (`packages/catalog/src/models.ts`)
  before a message is finalized — and is live on the extension event bus via
  `message_end` (`event.message.usage.cost.total` when `message.role ===
  "assistant"`). This matches the existing status-line `cost` segment
  (`modes/components/status-line/segments.ts`) and `footer.ts`'s cumulative
  cost display, both of which already sum `usage.cost.total` the same way.
- **"Burns down" = wax bar shrinking against a reference ceiling**, mirroring
  Token Tide's `MAX_REFERENCE_RATE` normalization: `waxRemaining` clamps
  cumulative session cost against a fixed `$2.00` reference (a "you've spent
  enough to notice" point, not a real budget) rather than modeling any actual
  spend limit. A session that keeps accumulating cost past the ceiling just
  shows a fully-melted (empty) bar rather than going negative or wrapping.
- **"Gutter" is a widening flicker swing, not a one-shot brightness jump.**
  A calm baseline flicker (`BASELINE_SWING`) runs at all times so an idle or
  cheap-message candle "barely flickers" per the bead; each message's cost
  (via `gutterIntensity`, clamped against a `$0.05` reference) stamps a
  `gutterEnvelope` that linearly decays back to that baseline over 1.5s,
  widening the flicker's amplitude (not shifting its resting brightness) —
  reading as a wilder, more agitated flame right after an expensive turn
  rather than a flash that just gets brighter then dimmer.
- **Every assistant `message_end` counts as one "turn"'s cost**, not
  `turn_end`'s coarser per-turn boundary — matching Token Tide's existing
  precedent of treating each streamed assistant message as its own
  throughput/cost unit, since a single logical "turn" can already span
  multiple assistant messages around tool calls and the codebase's own
  cost-summing call sites (`footer.ts`, `session-manager.ts`) already do the
  same per-message accumulation.
- Same dual-clock-seam pattern as every other Wave 2 feature: the controller
  stamps `recordMessageCost` against the shared `FrameScheduler`'s relative
  clock (not `Date.now()`), and the widget reads that same injected clock
  (not the host's own mount-relative `elapsedMs`) so a widget mounting after
  the state has already recorded messages doesn't skew the gutter-decay math.
- Off-tier fallback deliberately doesn't need the flame/wax visuals at all:
  `"$0.42 total · $0.03/msg avg"`, matching the bead's acceptance text and
  the "$N/M done"-style static fallback convention every other Wave 2
  feature already uses for its `off` tier.

### 8. 🌊 Reflection Ripple (oh-my-pi-a1u)

**Status:** done.

**Grounding:** verified `ttsr_triggered` (`extensibility/shared-events.ts`) is
real and fires from `agent-session.ts`'s `#handleTtsrMatches` every time TTSR
either injects a per-tool rule or aborts/retries the stream to inject one —
carrying the matched `Rule[]` (each with a `.name`), exactly as the idea doc
claimed. Unlike Agent Fleet, no re-grounding was needed.

**Module:** `packages/coding-agent/src/reflection-ripple/` (`ripple.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createReflectionRippleExtension` pushed as an eighth inline
extension in `sdk.ts` (`createAgentSession`), subscribed to `ttsr_triggered`.
Reuses the existing shared `animations` setting; no new settings-schema
entries. New `./reflection-ripple` and `./reflection-ripple/*` package.json
export paths.

**Test command:** `bun test packages/coding-agent/test/reflection-ripple.test.ts`
— 31 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- **A single ripple, not a queue.** A fresh `ttsr_triggered` event while a
  prior ripple is still expanding restarts the wave from `now` (updating the
  displayed rule name) instead of layering multiple concurrent ripples —
  mirroring Breathing Border's `applyAgentStart` restart-even-if-active
  semantic, since TTSR retriggers in quick succession should read as "still
  reflecting," not a backlog of waves.
- **Fully unmounts on settle, unlike Breathing Border's static landing
  widget.** Breathing Border's border is meant to be persistently visible
  ambient background even at rest, so it tears down to a static (but still
  drawn) row. Reflection Ripple's ripple is explicitly transient/event-only
  per the bead ("taking a breath *before* it reflects"), so once the wave and
  the breath-dim both finish (`ReflectionRippleState.settleIfDone`, at
  `max(RIPPLE_DURATION_MS, DIM_DURATION_MS)`), the controller disposes the
  host **and** calls `ctx.setWidget(key, undefined, ...)` — zero lingering
  visual, not just zero subscriptions. A later trigger remounts a brand-new
  host from scratch, same overall dance as Breathing Border's settle
  callback, just with "back to nothing" instead of "back to static."
- **Two independent envelopes compose into one brightness value:**
  `rippleBrightness` (born bright, linearly dissipating as the wave expands
  — a `sqrt`-eased, decelerating radius so it spreads fast then slows, like a
  real ripple) is multiplied by `dimMultiplier(reflectDimAmount(...))` (an
  exhale-shaped dip that lands instantly at trigger and eases back to full
  brightness) rather than modeling the "breath" as a separate visual layer.
  This keeps both the wave's own fade and the ambient dim snapshot-testable
  independently via their own pure functions, matching the reusable-envelope
  lesson from Breathing Border/Cost Candle.
- **Off-tier fallback keeps informational value instead of going blank:**
  `"↺ reflecting: <rule-name(s)>"`, refreshed on every trigger (like Cost
  Candle/Todo Meteors' off-tier text updates) — deliberately NOT torn down
  after a timeout the way the animated tiers are, since the `off` tier has no
  frame clock to drive an expiry; the static line just reflects the most
  recent trigger until the next one arrives.
- Same dual-clock-seam pattern as every other Wave 2 feature: the controller
  stamps `applyTrigger` against the shared `FrameScheduler`'s relative clock
  (not `Date.now()`), and the widget reads that same injected clock for
  `rippleElapsedMs` (not the host's own mount-relative `elapsedMs`).

## Ideas not yet started

Ideas 9–15 from `IDEA_WIZARD_IDEAS_WAVE2.md`'s "next 10" (Memory Crystals,
Context Constellation, Diff Bloom, Cadence Equalizer, Goal Horizon, Model
Weather Vane, Prompt Charge) remain unstarted.
