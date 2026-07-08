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

### 9. 💎 Memory Crystals (oh-my-pi-fbc)

**Status:** done.

**Grounding:** `auto_compaction_end`'s `result` field does **not** hold up as
literally described — tracing every emission site in `agent-session.ts`
shows `result` is `undefined` on every `handoff`/`shake` action and on every
`aborted`/`skipped`/`errorMessage` path; it is only ever populated on a clean
`context-full`/`snapcompact` success, and even then carries no message-count
field and no `tokensAfter` (only `summary`/`shortSummary`/`tokensBefore`).
Re-grounded per the same "verify the signal is real" rule that reshaped
Agent Fleet: the controller gates on `event.result !== undefined` (which
already implies a successful, non-aborted, non-skipped compaction) and sizes
each crystal's magnitude off `tokensBefore` alone, dropping the "number of
messages compacted" dimension the idea doc implied rather than inventing a
field the payload doesn't have. The pre-Wave-2 `compaction-vacuum` feature
this idea says to "extend" lives only on the separate, unmerged
`feat/compaction-vacuum` branch — not present in this branch's working tree
— so Memory Crystals ships standalone rather than literally extending
anything; noted here rather than silently reinterpreted.

**Module:** `packages/coding-agent/src/memory-crystals/` (`crystal.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createMemoryCrystalsExtension` pushed as a ninth inline
extension in `sdk.ts` (`createAgentSession`), subscribed to
`auto_compaction_end`. Widget placed `belowEditor` (the aboveEditor cluster
already has five features; this balances the split, and no other feature
claims a `"memory-crystals"` widget key). Reuses the existing shared
`animations` setting; no new settings-schema entries. New
`./memory-crystals` and `./memory-crystals/*` package.json export paths.

**Test command:** `bun test packages/coding-agent/test/memory-crystals.test.ts`
— 21 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- Each successful compaction crystallizes into one gem appended to a
  persistent tray, capped at `MAX_DISPLAYED_CRYSTALS` (10) with a trailing
  `+N more` count once exceeded — mirroring Session Bonsai's leaf-pruning /
  Todo Meteors' ember-cap convention. The running `totalCrystals`/
  `totalTokensReclaimed` counters keep counting past the cap; only the
  *displayed* tray drops the oldest entries, never silently discarding the
  totals.
- Gem size/color is a magnitude tier (`crystalMagnitude`, clamped against a
  fixed `MAX_REFERENCE_TOKENS` (40,000) ceiling) rather than an adaptive/
  rolling max, mirroring Cost Candle's `WAX_REFERENCE_COST_USD`/Token Tide's
  `MAX_REFERENCE_RATE` normalization pattern.
- A freshly-spawned crystal flashes `accent` for a brief `SPARKLE_DURATION_MS`
  (500ms) landing window — an exhale-shaped decay reused from Reflection
  Ripple's `reflectDimAmount` envelope shape — before settling into its
  plain magnitude-tiered resting color (`dim`/`syntaxType`/`success`). The
  `subtle` tier skips the sparkle entirely and always shows the resting
  color, matching Cost Candle's "subtle ignores the transient disturbance"
  precedent.
- Like Tool Constellation/Cost Candle, the widget mounts lazily on the first
  real signal (the first successful compaction) rather than pre-mounting an
  empty tray — a session with no compactions shows nothing.
- Off-tier fallback: `"◆ N crystal(s) · X tokens reclaimed"`, matching Cost
  Candle's `"$N total · $M/msg avg"` static-line convention.
- Same dual-clock-seam pattern as every other Wave 2 feature: the controller
  stamps `applyCompactionEnd` against the shared `FrameScheduler`'s relative
  clock (not `Date.now()`), and the widget reads that same injected clock for
  sparkle-decay math (not the host's own mount-relative `elapsedMs`).
- Like every prior Wave 2 feature except Breathing Border, this mount is
  permanent for the extension's lifetime once first created —
  `backpressureFromTui(tui)` is not wired into the `AnimationHost`
  construction (same structural mount-sequence limitation documented
  throughout this file).

## 10. ✨ Context Constellation (oh-my-pi-8q7)

**Status:** done.

**Grounding:** the idea doc doesn't name a concrete field, only "context
window as a night sky filling with stars; compaction = a shooting-star
sweep." Verified the only reliable source for fill state is
`ExtensionContext.getContextUsage()` (`extensibility/extensions/types.ts:280-296`
— `{tokens, contextWindow, percent, compactionThresholdTokens?, tokensUntilCompaction?}`);
the `"context"` event itself (`ContextEvent`, fired before every LLM call)
carries only `messages`, no usage figures, so the controller polls
`ctx.getContextUsage()` at that event boundary rather than trusting the
event payload. Sweep geometry is stamped from `auto_compaction_start`
(`reason`/`action` — always populated) as the pre-compaction cell count;
`auto_compaction_end` triggers an *immediate* re-read of
`getContextUsage()` for the sweep's target rather than depending on
`AutoCompactionEndEvent.result`, which — per Memory Crystals' controller
note — is `undefined` on every `handoff`/`shake`/aborted/skipped path. An
aborted/skipped compaction therefore renders no sweep motion at all (target
== start), which is correct: nothing was actually reclaimed. The pre-existing
`context-weather` feature this idea calls "a cousin of" lives only on the
separate, unmerged `feat/context-weather` branch — not present in this
branch's working tree (same situation as Memory Crystals/`compaction-vacuum`)
— confirmed via research to be a 1-row scalar barometer/tide gauge (not a
multi-cell spatial field), so Context Constellation is structurally distinct
even though both ultimately read the same `getContextUsage()` signal.

**Module:** `packages/coding-agent/src/context-constellation/` (`sky.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createContextConstellationExtension` pushed as a tenth inline
extension in `sdk.ts` (`createAgentSession`), subscribed to `context`,
`auto_compaction_start`, and `auto_compaction_end`. Widget placed
`belowEditor` (balances the aboveEditor/belowEditor split to 5/5). Reuses
the existing shared `animations` setting; no new settings-schema entries.
New `./context-constellation` and `./context-constellation/*` package.json
export paths.

**Test command:** `bun test packages/coding-agent/test/context-constellation.test.ts`
— 28 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- A fixed 10x2 (20-cell) grid, 5% of the context window per cell. Cells
  light up in a fixed pseudo-random scatter order (`FILL_ORDER`, a
  deterministic FNV-1a-sorted permutation of `[0, 20)` computed once at
  module load) rather than left-to-right, so growth reads as a filling sky
  rather than a progress bar — same hash-driven-layout rationale as Tool
  Constellation's `hashCell`/`assignCell`.
- Star color is a function of `getContextUsageLevel`/`getContextUsageThemeColor`
  from the existing `modes/components/status-line/context-thresholds.ts` —
  reused verbatim, not reinvented, per the established "reuse the theme /
  reuse the signal, don't invent a parallel one" rule (same precedent as
  Token Tide reusing `calculateTokensPerSecond`). Off-tier text reuses
  `formatContextUsage` from the same module for an identical readout to the
  footer's context-usage line.
- The newest-lit star briefly flares (`growFlareIntensity`, an exhale shape
  mirroring Memory Crystals' `sparkleIntensity`) before settling to its
  plain resting glyph; the `subtle` tier skips this entirely, matching every
  prior feature's "subtle ignores the transient disturbance" convention.
- The sweep is a comet-front wipe: `ConstellationState.beginSweep` stamps
  the pre-compaction cell count as `from`, and the next `applyContextUsage`
  call (from the immediate post-`auto_compaction_end` re-read) sets `to`.
  The widget interpolates between them via `sweepProgress`/`lerpCells` over
  `SWEEP_DURATION_MS` (900ms); once elapsed exceeds that window the sweep
  record is never explicitly cleared (mirroring `lastFired` in Tool
  Constellation) — the renderer simply falls back to the plain ground-truth
  `filledCells` once its own elapsed-since-`startedAt` check expires, so a
  stale sweep record can never re-trigger a comet later.
- Like every prior Wave 2 feature, the controller pulls a fresh reading
  directly from `ctx.getContextUsage()` inside each handler rather than
  trusting any event payload to carry it — the same "pull, don't trust the
  push" pattern Session Bonsai established for `ctx.sessionManager.getTree()`.
- Same dual-clock-seam pattern as every other Wave 2 feature: the controller
  stamps `applyContextUsage`/`beginSweep` against the shared `FrameScheduler`'s
  relative clock, and the widget reads that same injected clock for
  flare/sweep decay math (not the host's own mount-relative `elapsedMs`).
- Like every Wave 2 feature except Breathing Border, this mount is permanent
  for the extension's lifetime once first created —
  `backpressureFromTui(tui)` is not wired into the `AnimationHost`
  construction (same structural mount-sequence limitation documented
  throughout this file).

## 11. 🌸 Diff Bloom (oh-my-pi-dt7)

**Status:** done.

**Grounding:** the idea doc says "Edit/Write results bloom green (added) /
wither red (removed) with a wipe. Grounded in `tool_result` of edit tools."
Verified the `edit` tool is the only builtin whose `tool_result` carries a
real, always-populated diff: `EditToolDetails.diff` (`edit/renderer.ts:79-104`)
is a required `string` field (not optional), present for both single-file
and multi-file edits (multi-file diffs are the per-file diffs concatenated —
confirmed in `edit/index.ts`'s `executeMultiPathEntries`). Added/removed line
counts are parsed with `getDiffStats` (`tools/render-utils.ts:491`), the same
helper the TUI's own tool-result renderer uses
(`edit/renderer.ts`'s `formatDiffStatsSuffix`) — reused verbatim rather than
reinventing a parallel line-counter, per the established "reuse the signal,
don't invent a parallel one" rule. This codebase's internal diff format uses
numbered `+N|`/`-N|`/` N|` line prefixes (`edit/diff.ts`'s
`formatNumberedDiffLine`) with no `---`/`+++` file-header lines, so
`getDiffStats`'s naive "count lines starting with +/-" approach has no
header-contamination risk here (verified by reading `generateDiffString`/
`generateUnifiedDiffString`). A thrown-error edit always carries
`details: undefined` (`extensions/wrapper.ts`'s catch branch sets
`details: undefined as TDetails` before emitting `tool_result`), so gating on
"is `details?.diff` a non-empty string" is sufficient — no separate
`isError` check is needed, and a partial-failure multi-file edit still
blooms for whatever real diff was actually applied before the failure.
**`write` tool results are deliberately NOT wired**: `WriteToolResultEvent.details`
is typed `undefined` on the extension-facing event (`extensibility/extensions/types.ts:773-776`)
— the only content extensions see for a write is a human-readable
"Successfully wrote N bytes to path" string, and regex-parsing that would be
exactly the kind of invented field prior Wave 2 features scoped away from
(Memory Crystals dropped the "messages compacted" dimension for the same
reason). Diff Bloom therefore ships as an edit-only feature, a narrower
scope than the idea doc's "Edit/Write" framing, documented here rather than
silently reinterpreted.

**Module:** `packages/coding-agent/src/diff-bloom/` (`bloom.ts`, `state.ts`,
`widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createDiffBloomExtension` pushed as an eleventh inline
extension in `sdk.ts` (`createAgentSession`), subscribed to `tool_result`
and filtered to `toolName === "edit"` via a new `isToolResultEventType`
type guard (see below). Widget placed `aboveEditor` (balances the
aboveEditor/belowEditor split to 6/5 — the tied 5/5 split left either side
equally valid, and Diff Bloom's ephemeral single-flash shape matches the
aboveEditor cluster's existing ripple/candle-style features more than the
belowEditor cluster's persistent trays/maps). Reuses the existing shared
`animations` setting; no new settings-schema entries. New `./diff-bloom` and
`./diff-bloom/*` package.json export paths.

**Infra addition:** added `isToolResultEventType` to
`extensibility/extensions/types.ts`, a `tool_result` counterpart to the
existing `isToolCallEventType` guard. Direct narrowing via
`event.toolName === "edit"` does not narrow `event.details` away from the
custom-tool `unknown` case, because `CustomToolResultEvent.toolName` is
typed `string` (not a literal), which overlaps with every builtin literal
from TypeScript's perspective — the exact issue `isToolCallEventType`'s own
doc comment already called out for the `tool_call` side. This is
general-purpose extension infrastructure, not diff-bloom-specific, and any
future `tool_result`-grounded feature narrowing to a builtin tool will need
the same guard.

**Test command:** `bun test packages/coding-agent/test/diff-bloom.test.ts`
— 35 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- A single active bloom, mirroring Reflection Ripple: a fresh edit replaces
  any still-blooming one rather than queuing a backlog — a burst of rapid
  edits reads as one continuously-refreshed flower, not overlapping ghosts.
- The row splits into two segments: added cells grow inward from the left
  edge toward center (green, `toolDiffAdded` theme token), removed cells
  grow inward from the right edge toward center (red, `toolDiffRemoved`
  theme token) — both existing, already-themed tokens reused verbatim
  (`modes/theme/theme.ts:1044-1045`), not new colors. Cell count per segment
  is `lines / MAX_REFERENCE_LINES` (a fixed 40-line ceiling, same
  fixed-reference-not-adaptive-max convention as Memory Crystals'
  `MAX_REFERENCE_TOKENS`/Cost Candle's `WAX_REFERENCE_COST_USD`) times the
  segment width times the current bloom intensity.
- `bloomIntensity` is a grow-then-wipe envelope: eases up to full intensity
  by `BLOOM_GROW_MS` (400ms, `sqrt` ease-out like Reflection Ripple's
  wavefront — "the flower opening"), then wipes linearly back to `0` by
  `BLOOM_DURATION_MS` (1400ms total) — the row clearing. This is the one
  Wave 2 envelope shape that grows in before decaying, rather than peaking
  instantly like every prior feature's "exhale" shapes (`reflectDimAmount`,
  Memory Crystals' `sparkleIntensity`, Context Constellation's
  `growFlareIntensity`) — chosen because "bloom" specifically implies
  opening, not an instant flash.
- Cell glyph brightness rides the same `bloomIntensity` ramp
  (`BLOOM_GLYPHS`, a `" "`→`"█"` ramp mirroring Reflection Ripple's
  `RING_GLYPHS`), so all filled cells pulse in brightness together while the
  filled *count* stays fixed for the bloom's lifetime (set once at trigger
  time from the diff stats, not recomputed per frame).
- `subtle` tier collapses to a single centered glyph colored by whichever
  side (added/removed) has more lines — same "collapse to one dominant
  signal" convention as Reflection Ripple's subtle tier.
- Like Tool Constellation/Cost Candle/Memory Crystals, the widget mounts
  lazily on the first real signal (the first edit with a non-empty,
  non-zero diff) rather than pre-mounting an empty row.
- Off-tier fallback: `"🌸 path +A/-R"`, matching Reflection Ripple's
  `"↺ reflecting: rule"` / Memory Crystals' `"◆ N crystal(s) · ..."`
  static-line convention; falls back to `"no edits yet"` before any bloom.
- Same dual-clock-seam pattern as every other Wave 2 feature: the controller
  stamps `applyBloom` against the shared `FrameScheduler`'s relative clock,
  and the widget reads that same injected clock for intensity/glyph math
  (not the host's own mount-relative `elapsedMs`).
- Like every prior Wave 2 feature except Breathing Border, this mount is
  permanent for the extension's lifetime once first created —
  `backpressureFromTui(tui)` is not wired into the `AnimationHost`
  construction (same structural mount-sequence limitation documented
  throughout this file).

## Ideas not yet started

Ideas 12–15 from `IDEA_WIZARD_IDEAS_WAVE2.md`'s "next 10" (Cadence
Equalizer, Goal Horizon, Model Weather Vane, Prompt Charge) remain
unstarted.
