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

## 12. 🎚️ Cadence Equalizer (oh-my-pi-7wc)

**Status:** done.

**Grounding:** the idea doc says "a tiny status-line VU equalizer dancing to
`tokensPerSecond` (a lighter cousin of Token Tide for the status line
only)." `tokensPerSecond` is real and already battle-tested —
`calculateTokensPerSecond` (`modes/components/status-line/token-rate.ts`)
is the exact provider Token Tide (feature #2) already samples every frame,
and there is no separate "status line" widget placement for extensions to
mount into: `WidgetPlacement` is only `"aboveEditor" | "belowEditor"`
(`extensibility/extensions/types.ts:156`) — the idea doc's "status line
only" framing describes the intended *look* (a compact single line), not a
distinct architectural surface.

**Overlap risk, checked before wiring anything:** unlike the
context-weather/compaction-vacuum cousins (which lived on separate,
unmerged branches and were structurally distinct signals/shapes), Token
Tide's `subtle` tier (`token-tide/widget.ts`'s `renderVuBar`) is *already*
"a single pulsing VU bar sized to the current tok/s rate," and its `full`
tier is already a scrolling multi-column waveform of historical samples —
both tiers of the literal "VU equalizer for tok/s" concept are already
shipped. Building Cadence Equalizer as a re-skin of either tier would be
shipping a duplicate feature under a new name, which fails this run's
"verify the signal is real" gate applied honestly (the signal is real, but
a re-skinned feature is not distinct). Cadence Equalizer therefore ships
with a genuinely different rendering *algorithm*, not just a different
glyph set: `BAND_COUNT` (5) independent bands, each an exponential moving
average of the *same* `tokensPerSecond` reading tuned to a different
`BAND_ALPHAS` reaction speed (`0.55` fastest → `0.05` slowest,
`cadence-equalizer/bars.ts`) — a burst hits the fast band first (tall,
jittery) while the slow band lags and smooths, so the bars visibly move
*relative to each other* rather than in lockstep like one filled bar would.
Each band also keeps a peak-hold marker (`stepPeak`: snaps up on a new
high, decays linearly by `PEAK_DECAY_PER_FRAME` otherwise) — a classic
hardware VU-meter cue that has no equivalent anywhere in Token Tide.
Reuses Token Tide's `token-tide/scale.ts` bucket palette
(`normalizeAmplitude`, `rateBucket`, `BUCKET_THEME_COLOR`, `waveGlyph`)
verbatim rather than inventing a parallel one, so the two cousins share one
color language by design.

**Module:** `packages/coding-agent/src/cadence-equalizer/` (`bars.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createCadenceEqualizerExtension` pushed as a twelfth inline
extension in `sdk.ts` (`createAgentSession`), subscribed to
`message_start`/`message_update`/`message_end` — the identical event
triple Token Tide subscribes to, since both sample the same underlying
provider. Widget placed `belowEditor` (evens the aboveEditor/belowEditor
split from 6/5 to 6/6, and keeps this ambient meter physically apart from
Token Tide's `aboveEditor` mount rather than stacking two tok/s widgets on
the same edge). Reuses the existing shared `animations` setting; no new
settings-schema entries. New `./cadence-equalizer` and
`./cadence-equalizer/*` package.json export paths.

**Test command:**
`bun test packages/coding-agent/test/cadence-equalizer.test.ts` — 29 pass,
0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- Controller/widget lifecycle (mount-on-first-`message_start`, in-flight
  tracking across `message_update`, clear-on-`message_end`, `off`-tier
  static repaint, dispose semantics) is copied structurally from
  `token-tide/controller.ts` — the two features share an event surface and
  a signal provider by design, so re-deriving the same wiring would be
  pure duplication risk, not independence. Only the *rendering*
  (`bars.ts`/`state.ts`/`widget.ts`'s render functions) is new.
- `full` tier renders one row: each band is a peak-cap column (`‾` in the
  `burst` bucket's theme color when the band has decayed `>= 0.03` below
  its held peak, else blank) followed by an amplitude glyph column off the
  same `WAVE_GLYPHS` ramp Token Tide uses, separated by blank spacer
  columns between bands.
- `subtle` tier collapses to a compact strip: just the `BAND_COUNT`
  amplitude glyphs concatenated with no spacing or peak caps, sized to fit
  a status-line-width slot — the literal "for the status line only"
  framing, honored in the compact tier's shape even though the mount point
  is the same `belowEditor` widget slot as every other tier.
- EMA/peak stepping is fixed-step (one `stepBands` call per animation
  frame, not time-scaled by `elapsedMs`), matching Token Tide's
  `pushSample`-once-per-frame convention — deliberately not
  reimplementing time-scaled smoothing for a purely cosmetic meter.
- Off-tier fallback: `"eq -- "`/`"eq N tok/s"`, a distinct text function
  (`renderEqualizerText`) from Token Tide's `renderTokenRateText`, per this
  run's per-feature-owns-its-off-tier-renderer convention (established
  since feature #1) even though the two strings are shaped similarly.

## 13. 🌅 Goal Horizon (oh-my-pi-91i)

**Status:** done.

**Grounding:** the idea doc says "`goal_updated` → a sunrise-gradient bar
filling toward the goal; milestones flare. Grounded in `Goal` /
`GoalModeState`." Checked piece by piece:
- `goal_updated` (`GoalUpdatedEvent`, `extensibility/shared-events.ts`) is
  real, part of the subscribable `ExtensionEvent` union, and fires roughly
  once per tool call while a `/goal` is active — `GoalRuntime.#commitState`
  (`goals/runtime.ts`) emits it from nearly every state-mutating method,
  plus every token/wall-clock usage flush (`#flushUsageLocked`). Comparable
  cadence to Diff Bloom's `tool_result` trigger, not a rare one-shot event.
- `Goal`/`GoalModeState` (`goals/state.ts`) are real types with exactly the
  fields listed in the idea's own grounding — `id`, `objective`, `status`,
  `tokenBudget?`, `tokensUsed`, `timeUsedSeconds`, `createdAt`, `updatedAt`.
- **"Milestones flare" has zero grounding.** A full-tree grep for
  "milestone" turns up nothing except an unrelated `gh-cache-invalidation.ts`
  CLI flag — there is no milestone concept, field, or event anywhere in this
  codebase, unlike every prior feature's signal-reinterpretation cases
  (Memory Crystals' `result`, Todo Meteors' `todo_reminder`), which at least
  had a real-but-differently-shaped field to work from. Shipped as a wholly
  invented visual layer instead: four synthetic thresholds
  (`MILESTONE_FRACTIONS = [0.25, 0.5, 0.75, 1]`, `goal-horizon/horizon.ts`)
  computed purely from `tokensUsed / tokenBudget`, with a decaying flare
  glyph overlay when a fresh crossing is detected — documented here as an
  invention, not a re-grounding.
- **`Goal.tokenBudget` is optional** (`goals/state.ts`) — a goal created via
  `/goal` with no budget has no numeric target at all to fill toward
  (`goals/runtime.ts`'s own `remainingTokens()` returns `null` in that
  case). `goalFraction()` returns `undefined` for this case, and the
  renderer falls back to an indeterminate pulsing glyph plus a running
  token count instead of a bar — an explicit scoped branch, not a silent
  0%-forever bar.
- No `ctx.getGoal()` pull accessor exists on `ExtensionContext` (checked —
  unlike Context Constellation's `getContextUsage()`), so this feature is
  fully push-driven off the event payload; there is nothing to reconcile
  against on a later poll.
- Overlap check: none of the twelve already-shipped Wave 2 features
  (`tool-constellation`, `token-tide`, `session-bonsai`, `todo-meteors`,
  `breathing-border`, `agent-fleet`, `cost-candle`, `reflection-ripple`,
  `memory-crystals`, `context-constellation`, `diff-bloom`,
  `cadence-equalizer`) render "progress toward a goal" as a concept — Todo
  Meteors explicitly scoped `goal_updated` out of its own bead (see its
  section above) rather than wiring it, so this is the first feature to
  actually visualize `Goal`/`GoalModeState`.

**Module:** `packages/coding-agent/src/goal-horizon/` (`horizon.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createGoalHorizonExtension` pushed as the thirteenth inline
extension in `sdk.ts` (`createAgentSession`), subscribed to `goal_updated`.
Placed `aboveEditor` (alongside Diff Bloom/Reflection Ripple/Cost
Candle/Tool Constellation/Todo Meteors, now 7/6 aboveEditor/belowEditor —
an ambient progress bar reads more naturally near the input than in the
belowEditor tray cluster). Reuses the existing shared `animations` setting;
no new settings-schema entries. New `./goal-horizon` and `./goal-horizon/*`
package.json export paths, inserted alphabetically between
`./extensibility/plugins/marketplace/*` and `./internal-urls`.

**Test command:** `bun test packages/coding-agent/test/goal-horizon.test.ts`
— 30 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- Unlike every prior lazily-mounted-then-transient feature (Diff Bloom,
  Reflection Ripple), Goal Horizon mounts once on the first `goal_updated`
  event and stays mounted for the extension's lifetime, mirroring Cost
  Candle's persistent-ambient-meter precedent — a goal's progress is a
  standing status, not a momentary flash. If the goal is later dropped
  (`goal: null`), the widget stays mounted and renders "no active goal"
  rather than unmounting, the same "no early-teardown wiring" structural
  limitation documented throughout this file
  (`backpressureFromTui(tui)`/dynamic unmount is not wired into
  `AnimationHost` construction for any Wave 2 feature).
- The sunrise gradient is a **per-cell** color ramp, not a single bar color:
  each filled column's own position (not the overall fraction) is
  classified into a `HorizonBucket` (`predawn`→`dim`, `dawn`→`syntaxType`,
  `morning`→`syntaxVariable`, `noon`→`syntaxFunction`, `zenith`→`warning`,
  the same "existing `ThemeColor` tokens, not raw ANSI" convention as
  Token Tide's `BUCKET_THEME_COLOR`), so the filled portion of the bar
  visibly warms from cool/dim at the left toward hot amber at the fill
  edge — the literal "sunrise-gradient bar" rather than a single flat tint.
- Milestone crossings are detected per-goal-`id`: a fresh goal (a new `id`
  replacing the previous one via `/goal` create) silently initializes its
  crossed-milestone count from whatever fraction it starts at, without
  retroactively flaring — only a crossing detected on an *update to the
  same goal* triggers the flare overlay. Prevents a goal created already
  past 75% (e.g. resumed from a prior session) from opening with a
  spurious flash.
- Flare rendering follows the established decaying-overlay convention
  (`flareIntensity`, linear decay to 0 by `FLARE_DECAY_MS` = 900ms, same
  shape as Cost Candle's `gutterEnvelope`): the flare glyph
  (`FLARE_GLYPHS` ramp, dim→`✦`/`✷`→`☀`) replaces whichever bar column the
  most recently crossed milestone lands on, fading back to that column's
  normal gradient color as it decays.
- `GoalStatus` values (`complete`/`dropped`/`paused`) override the bar's
  per-cell gradient with a single flat color (`success`/`dim`/`dim`
  respectively) rather than mixing status color with position color — a
  completed or paused goal reads as a single unambiguous state, not a
  gradient that happens to also be green.
- `subtle` tier collapses to one glyph (colored by the overall fraction's
  dominant bucket, not per-cell) plus the percentage — same "collapse to
  one dominant signal" convention as every prior feature's subtle tier.
- Off-tier fallback: `"🌅 objective NN% (used/budget tok)"` for a budgeted
  goal, `"🌅 objective — used tok (no budget)"` for an unbounded one,
  falling back to `"no active goal"` before any goal — matching the
  established per-feature-owns-its-off-tier-renderer, plain-string
  convention (no ANSI) since the off tier never receives a theme.

## 14. 🧭 Model Weather Vane (oh-my-pi-gqb)

**Status:** done.

**Grounding:** the idea doc says "model switches animate a vane/emblem swap,
one color per model." Checked piece by piece:
- **No dedicated model-switch `ExtensionEvent` exists anywhere in this
  codebase.** A full sweep of `extensibility/shared-events.ts` and
  `extensibility/extensions/types.ts`'s `ExtensionEvent` union (all 27+
  members) turns up nothing named `model_change`/`model_switch`. The only
  persisted "a switch happened" record is `ModelChangeEntry`
  (`session-entries.ts`, `{ type: "model_change", model, role? }`), appended
  by `session/agent-session.ts`'s `#setModelWithProviderSessionReset` on
  every real switch path (`/model`, plan-mode auto-switch, ACP
  `session/setModel`, RPC, task executor, auth/credential fallback) — but
  it's a session-log entry consumed only by transcript-rendering UI, never
  re-emitted as an extension event.
- **The real, reliable per-call signal instead:** `AssistantMessage.model:
  string` and `.provider: Provider` (`packages/ai/src/types.ts`) — both
  required, always-populated fields on every assistant message, set from the
  model resolved at the top of `streamAssistantResponse`
  (`packages/agent/src/agent-loop.ts`) before the first streamed chunk. The
  `message_start` event fires exactly once per assistant response (gated by
  an `addedPartial` flag in the `"start"` stream-event case), so subscribing
  to it and diffing `message.model` turn-to-turn against the last-seen value
  is a precise, once-per-response switch detector — the same "pull/read the
  real per-call field, don't wait on a push event that doesn't exist"
  precedent Context Constellation set for `getContextUsage()`, applied here
  by reading the field directly off the event payload rather than a
  standalone pull accessor (none exists for model — `ctx.model` /
  `ctx.models.current()` are session-level snapshots, not per-call).
- `ProviderResponseMetadata` (the `after_provider_response` event's base
  type) was checked and ruled out as an alternative: it carries
  `status`/`headers`/`requestId`/`metadata` only, no model field.
- Overlap check: none of the thirteen already-shipped Wave 2 features read
  or display model identity/switching at all (confirmed via a `WAVE2_PROGRESS.md`
  grep for "model" before this feature) — genuinely unclaimed ground, not a
  re-skin.

**Module:** `packages/coding-agent/src/model-weather-vane/` (`vane.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createModelWeatherVaneExtension` pushed as the fourteenth
inline extension in `sdk.ts` (`createAgentSession`), subscribed to
`message_start`. Placed `belowEditor` (evens the split to 7
aboveEditor / 7 belowEditor). Reuses the existing shared `animations`
setting; no new settings-schema entries. New `./model-weather-vane` and
`./model-weather-vane/*` package.json export paths, inserted next to the
`./memory-crystals/*` cluster.

**Test command:** `bun test packages/coding-agent/test/model-weather-vane.test.ts`
— 27 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- The "vane/emblem" is a compass glyph (`↑ ↗ → ↘ ↓ ↙ ← ↖`, N through NW) whose
  direction *and* color are both derived from the same 32-bit FNV-1a hash
  slot of the model's wire id (`modelDirectionIndex`, `vane.ts`) — "one color
  per model" from the idea doc, extended to "one direction per model" too,
  since a vane with a fixed color but rotating pointer reads as more
  literally a weather vane than a static color swatch. Hand-rolled FNV-1a
  (not `Bun.hash`) for byte-stable hashing across Bun versions, matching
  Tool Constellation / Agent Fleet / Context Constellation's precedent.
- A detected switch triggers a **spin**, not an instant color/glyph swap: the
  displayed direction sweeps through one full extra loop plus the shortest
  forward delta from the previous model's slot to the new one
  (`spinDisplayIndex`), landing exactly on the target at
  `SPIN_DURATION_MS` (700ms) — always a visibly moving animation, even when
  two different model ids happen to hash to the same slot (a same-slot
  "switch" still visibly swings around before settling back). Only the
  emblem spins; the text label updates to the new model id/provider
  immediately, matching how Diff Bloom's bloom color reflects the new state
  immediately while only the *wipe* animates.
- The very first assistant message this session observes initializes the
  emblem **silently** (no spin) — only a change detected on a *later*
  message counts as a genuine switch, the same "no retroactive flare on
  fresh state" precedent Goal Horizon established for milestone crossings.
- `full` tier shows glyph + model id + `(provider)`; `subtle` tier drops the
  provider, matching every prior feature's "collapse to the dominant signal"
  subtle-tier convention. Off-tier fallback: `"🧭 model-id (provider)"`,
  falling back to `"no model yet"` before any assistant message — matching
  the established per-feature-owns-its-off-tier-renderer, plain-string
  convention (no ANSI).
- Non-assistant `message_start` events (steering messages, tool-result
  messages replayed through the same event type) are filtered out via a
  `role !== "assistant"` narrow before any state mutation, the same
  `toAssistant*Sample` guard shape Cost Candle uses for `message_end`.

## 15. ⚡ Prompt Charge (oh-my-pi-tb7)

**Status:** done.

**Grounding:** the idea doc says "the input caret glows/charges as you type a
longer prompt, releasing on submit. Grounded in `getEditorText` length."
Checked piece by piece:
- **`ExtensionContext.ui.getEditorText(): string`** (`extensibility/extensions/types.ts:236`,
  on `ExtensionUIContext`, not the top-level `ExtensionContext`) is real and
  live: the interactive-mode implementation
  (`modes/controllers/extension-ui-controller.ts:82`) is
  `getEditorText: () => this.ctx.editor.getText()`, reading the actual live
  editor object each call — not a snapshot frozen at context-creation time.
- **No per-keystroke `ExtensionEvent` exists anywhere in this codebase.** A
  full sweep of `extensibility/shared-events.ts` and
  `extensibility/extensions/types.ts`'s `ExtensionEvent` union confirms the
  only `input`-shaped event (`InputEvent`, `types.ts:671`) fires exactly
  once, at submit (`extensibility/extensions/runner.ts`'s `emitInput`, called
  from `modes/controllers/input-controller.ts` on the submit path) — never
  while typing. The internal `Editor.onChange` callback
  (`packages/tui/src/components/editor.ts:459`) fires on every keystroke but
  is a single-assignable field already claimed by
  `input-controller.ts:534-543` for bash/python-mode border-color detection,
  not a multi-subscriber event, and isn't exposed to extensions — wiring it
  would be a core change out of scope for a `packages/coding-agent/src/`-only
  feature.
- **The resolution:** since `@oh-my-pi/pi-animation`'s `AnimationHost`
  (`packages/animation/src/animation-host.ts`) already runs a real
  `setInterval`-backed frame clock independent of any `ExtensionEvent` — every
  Wave 2 widget's `AnimatedWidget.onFrame` hook already rides this clock —
  Prompt Charge's widget polls `getEditorText()` itself from inside
  `onFrame`, once per tick, using the live character count as the charge
  signal. This is the first Wave 2 feature to poll a pull-accessor from
  inside `onFrame` rather than only reacting to event-driven state mutation
  (confirmed via a full sweep of every existing `onFrame` override — Agent
  Fleet, Breathing Border, Cadence Equalizer, Todo Meteors, Diff Bloom, Token
  Tide, Reflection Ripple, Model Weather Vane — none of them pull a `ctx`
  accessor from the tick; Context Constellation's `getContextUsage()` pull is
  the closest precedent, but it re-pulls from an *event* handler, not the
  frame loop).
- Overlap check: no shipped Wave 2 feature (14 shipped before this one) reads
  editor/input text or renders anything about the prompt being composed —
  genuinely unclaimed ground.

**Module:** `packages/coding-agent/src/prompt-charge/` (`charge.ts`,
`state.ts`, `widget.ts`, `controller.ts`, `index.ts`).

**Wiring:** `createPromptChargeExtension` pushed as the fifteenth inline
extension in `sdk.ts` (`createAgentSession`), subscribed to `session_start`
(mount), `input` (release), and `session_shutdown` (dispose). Placed
`aboveEditor` (the split becomes 8 aboveEditor / 7 belowEditor). Reuses the
existing shared `animations` setting; no new settings-schema entries. New
`./prompt-charge` and `./prompt-charge/*` package.json export paths, inserted
next to the `./model-weather-vane/*` cluster.

**Test command:** `bun test packages/coding-agent/test/prompt-charge.test.ts`
— 32 pass, 0 fail.

**`bun check`:** green (root `bun check`, all workspaces).

**Design decisions / scoped interpretations:**
- Unlike every other Wave 2 controller, this one mounts **unconditionally on
  `session_start`** rather than lazily on a first data-bearing event (Cost
  Candle/Model Weather Vane's "spawn lazily on first fire" precedent): an
  idle 0%-charge caret is itself the correct resting state to show from the
  very first frame, the same unconditional-mount shape Breathing Border uses
  for `agent_start`. A session where the user never types anything just
  shows a permanently-idle bar, which is the right behavior (not "nothing").
- The charge curve is an asymptotic "capacitor charging" shape
  (`1 - e^-chars/tau`, `charge.ts`'s `chargeFraction`) rather than a linear
  ramp to a hard character cap — it visibly reacts to the very first
  keystroke and flattens out approaching (never reaching) full charge for a
  very long prompt, which reads more like "charging" than a linear meter.
  `tau = 140` chars, tuned so a short question barely glows and a
  paragraph-plus prompt reads as fully charged.
- The release burst is captured from `event.text.length` — the real,
  authoritative submitted-text length off the `input` event payload — rather
  than the last polled frame's character count, which could in principle be
  one tick stale relative to the actual submit. The burst then decays
  quadratically (ease-out) over `RELEASE_DURATION_MS` (500ms) purely as a
  function of elapsed time; the displayed fraction is
  `max(liveTypedCharge, releaseBurstIntensity)` so the flash is visible at
  full intensity even though the editor (and thus the live typed-charge
  signal) clears to empty the instant a message submits.
- No explicit "settle" transition/teardown the way Diff Bloom's
  blooming→idle mount teardown works: Prompt Charge is a persistent-ambient
  ambient status (Cost Candle's lifecycle template), so a fully-decayed
  release burst simply evaluates to `0` forever after — cheap, correct, no
  need to prune state.
- `full` tier shows glyph + 10-cell bar + percentage; `subtle` drops the
  percentage, matching every prior feature's "collapse to the dominant
  signal" convention. Off-tier fallback has no frame clock to decay a release
  over time (off tier's widget never subscribes to the host, so `onFrame`
  never runs) — it shows a plain `"⚡ idle"` / `"⚡ N% charged"` /
  `"⚡ released (N%)"` line, redrawn only on the `input` event since that's
  the only signal path available in that tier.
- Charge-bucket → color reuses the `ThemeColor`-token-not-raw-ANSI precedent
  (`CHARGE_BUCKET_COLOR`, mirroring Token Tide's `BUCKET_THEME_COLOR` and
  Model Weather Vane's `VANE_COLORS`): dim at rest, warming through
  `syntaxVariable`/`syntaxFunction` to a hot `warning` at full charge.

## Ideas not yet started

None. All fifteen ideas from `IDEA_WIZARD_IDEAS_WAVE2.md` (top 5 + next 10)
are now implemented, each as its own atomic commit with behavioral tests, a
green `bun check`, and a filed+closed bead. Remaining work per the run's
stop condition: an edge-case hardening pass over every earlier feature, and
an integration/gallery demo if feasible.

## Hardening pass

Per-feature edge-case hardening tracker. Each entry gets a dedicated pass:
re-read the module for un-tested boundary conditions (empty/zero state,
saturation, clock skew, malformed/adversarial input, idempotent
mount/dispose) and add behavioral tests — fixing any real bug found along
the way, not just padding coverage. Tracked as its own bead per feature so
the pass is resumable across iterations.

| # | Feature | Status | Bead |
|---|---|---|---|
| 1 | Tool Constellation | ✅ done | oh-my-pi-rxf |
| 2 | Token Tide | ✅ done | oh-my-pi-aqe |
| 3 | Session Bonsai | ✅ done | oh-my-pi-cxn |
| 4 | Todo Meteors | ✅ done | oh-my-pi-jj0 |
| 5 | Breathing Border | ✅ done | oh-my-pi-bw0 |
| 6 | Agent Fleet | ✅ done | oh-my-pi-nv4 |
| 7 | Cost Candle | ✅ done | oh-my-pi-0a2 |
| 8 | Reflection Ripple | ✅ done | oh-my-pi-cdc |
| 9 | Memory Crystals | ✅ done | oh-my-pi-91d |
| 10 | Context Constellation | ✅ done | oh-my-pi-cag |
| 11 | Diff Bloom | ⬜ pending | — |
| 12 | Cadence Equalizer | ⬜ pending | — |
| 13 | Goal Horizon | ⬜ pending | — |
| 14 | Model Weather Vane | ⬜ pending | — |
| 15 | Prompt Charge | ⬜ pending | — |

### 1. Tool Constellation — hardening notes

Added 5 edge-case behavioral tests to
`packages/coding-agent/test/tool-constellation.test.ts` (28 total, up from
23), covering paths the original spec-driven suite didn't reach:

- **Grid saturation**: firing `GRID_CELLS + 1` (31) distinct tool names
  forces at least one cell collision. `assignCell`'s documented fallback
  ("share the hashed cell rather than losing the star") was previously
  asserted only in a doc comment, never exercised — confirmed it doesn't
  throw, keeps exactly 3 rendered rows, and the render layer's
  last-inserted-wins-per-cell behavior (via `starAt.set(star.cell, ...)`
  in `widget.ts`) is the de facto collision resolution, silently dropping
  the older star's glyph from that frame. No bug: documented as expected
  degradation for sessions using more than 30 distinct tool names (highly
  unlikely in practice — MCP bridge tools are the most likely source of a
  long tail).
- **Empty tool name**: `hashCell("")` and `categorizeTool("")` both resolve
  cleanly (`"other"` bucket, in-range hash) rather than throwing — matters
  because `toolName` is an extension-facing string with no non-empty
  invariant enforced at the `ToolCallEvent` boundary.
- **Negative `msSinceFire`**: a render clock reading earlier than a star's
  `lastFireAt` (theoretically possible only if the widget's injected clock
  ever diverged from the controller's) is treated as still within the flare
  hold window (`<=` comparison in `starBrightness` includes negatives) —
  confirmed rather than assumed.
- **Empty/never-fired snapshot**: rendering with zero stars produces a
  fully-dim 3-row field with no comet glyph or ley-line, not a crash or
  malformed output.
- **Idempotent dispose**: calling `ToolConstellationController.dispose`
  twice does not emit a second `setWidget(..., undefined, ...)` clear or
  throw — the existing `if (!this.#mount) return;` guard was correct but
  untested.

No behavior changes were needed — every edge case degrades gracefully by
design. `bun test packages/coding-agent/test/tool-constellation.test.ts`:
28 pass, 0 fail. `bun check`: green.

### 2. Token Tide — hardening notes

Added 12 edge-case behavioral tests to
`packages/coding-agent/test/token-tide.test.ts` (38 total, up from 26),
covering `scale.ts`'s pure functions, `renderWaveformRow`'s width/buffer
boundaries, `TokenTideState`'s ring buffer, and the controller's
lifecycle/clock-skew edges:

- **Infinity/NaN in `rateBucket`/`normalizeAmplitude`**: both functions
  guard on `Number.isFinite` first, so `+Infinity` (e.g. a corrupted
  duration producing a runaway tokens/ms ratio) is treated as `idle`/`0`,
  not misclassified as the loudest `burst` bucket — confirmed rather than
  assumed, since the naive reading of "clamp to max" would have predicted
  `burst`/`1`.
- **`waveGlyph(NaN)` lookup-miss quirk**: `NaN` satisfies neither the
  `<= 0` nor `>= 1` clamp branch in `waveGlyph`, so it flows through as
  `NaN` into `Math.floor(NaN * length)` → `NaN` → `WAVE_GLYPHS[NaN]` is
  `undefined` → the `??` fallback silently resolves to `WAVE_GLYPHS[0]`
  (blank), not the "loudest" end one might expect from a runaway value.
  No crash, but the intuition that out-of-domain always clamps toward the
  nearer conceptual extreme is wrong here specifically for `NaN` — worth
  remembering if any future glyph-ramp helper is copied from this one.
- **Zero/negative/fractional `renderWaveformRow` width**: `Math.max(1,
  Math.floor(width))` already floors and clamps to at least one column;
  confirmed `0`, `-10`, and `2.9` all render without throwing or producing
  a zero-length row.
- **Empty buffer**: `renderWaveformRow([], ...)` renders all-padded blank
  columns with no bucket-colored glyph, matching the "nothing sampled yet"
  case a freshly-mounted widget would show before its first frame tick.
- **Degenerate zero-capacity `TokenTideState`**: constructing with
  `capacity: 0` never grows past an empty buffer — every push immediately
  triggers the `length > capacity` shift, so `latest()` stays `0` forever.
  Graceful degradation, not reachable in production (`DEFAULT_CAPACITY` is
  a fixed `48`), but locks in the same non-throwing contract Tool
  Constellation's grid-saturation test established for its own fixed-size
  structure.
- **Controller dispose idempotency + pre-mount safety**: a second
  `dispose()` call emits no extra `setWidget(..., undefined, ...)`, and
  calling `dispose()`/`onMessageUpdate()`/`onMessageEnd()` before any
  `onMessageStart()` ever mounted a widget is a safe no-op — the existing
  `if (!this.#mount) return;` guards were correct but untested, mirroring
  Tool Constellation's finding.
- **Backward clock skew**: if `wallClock.now()` ever reads earlier than
  the tracked message's `timestamp` (a clock adjustment mid-session), the
  shared `calculateTokensPerSecond` provider's `resolvedDurationMs < 100`
  guard already rejects the resulting negative elapsed time, so
  `sampleRate` returns `null` rather than a nonsensical negative tok/s —
  confirmed at the controller boundary, not just the provider's own tests.

No behavior changes were needed — every edge case degrades gracefully by
design; the `waveGlyph(NaN)` and Infinity-bucket findings were genuine
"the intuitive answer is wrong" surprises worth documenting, not bugs.
`bun test packages/coding-agent/test/token-tide.test.ts`: 38 pass, 0 fail.

### 3. Session Bonsai — hardening notes

Added 15 edge-case behavioral tests to
`packages/coding-agent/test/session-bonsai.test.ts` (45 total, up from 30),
covering `tree.ts`'s pure collapsing/pruning, `growth.ts`'s glyph/unfurl
math, `BonsaiState`'s spawn-timestamp bookkeeping, `renderBonsaiTree`, and
the controller's dispose lifecycle:

- **Real bug found and fixed**: `budGlyph` (unlike Token Tide's
  `waveGlyph`, which already has `?? WAVE_GLYPHS[0]`) had no fallback for
  a `NaN` growth fraction — `BUD_GLYPHS[NaN]` is `undefined`, and template
  interpolation in `nodeGlyph`/`renderBonsaiTree` would have rendered the
  literal string `"undefined"` into a tree line instead of degrading to a
  blank glyph. Confirmed via a standalone repro before touching source.
  Fixed with the same `?? BUD_GLYPHS[0]` pattern `waveGlyph` already uses;
  a new rendering test (`renderBonsaiTree` at a `NaN` elapsed clock
  reading) locks in that no row ever contains the substring `"undefined"`.
  `growth` being `NaN` is not reachable via any real event path today
  (spawn timestamps and the shared scheduler's `now()` are always finite
  numbers) but the fix costs nothing and matches established convention.
- **Empty roots / unknown active leaf**: `buildBonsaiTree([], id)` returns
  `[]` (not a throw), and an `activeLeafId` that matches no raw node in
  the tree at all marks nothing active (same graceful-miss shape as
  `activeLeafRank`'s already-tested `0`-return case, now also covered on
  the `isActive`-marking path).
- **Root that fully collapses**: a root with a single linear child chain
  down to one leaf collapses away entirely — `collapseChain` walks straight
  through the root object itself, so the surviving `BonsaiNode`'s `id` is
  the leaf's id, never the original root's id. Worth remembering for any
  future code that assumes a bonsai tree's top-level node id traces back
  to a real root entry.
- **Backward clock skew, two shapes**: (1) `unfurlGrowth` clamps to `0`
  for any `elapsedMs` at or before `spawnAtMs`, including deeply negative
  deltas, and returns `NaN` (not a thrown error) for non-finite inputs on
  either side; (2) `BonsaiState.update` never rewrites an already-recorded
  `spawnAt` entry even if a later `update` call is fed an earlier clock
  reading — spawn timestamps are stamped once, permanently, the same
  "pull-vs-push consistency" invariant Context Constellation's grounding
  notes established for its own scheduler reads.
- **Stale `spawnAt` retention**: once a raw tree node's compact-tree
  representative id (e.g. a collapsed leaf) is observed, it stays in
  `#spawnAt` forever even after that node is pruned from every subsequent
  raw tree snapshot — `BonsaiState` is append-only with no GC. Not a bug
  (matches the class's own doc comment framing of "record a spawn
  timestamp the first time any node id is observed"), but a real unbounded-
  growth tradeoff worth flagging: a session with heavy branch churn over a
  very long run will accumulate dead ids in this map for the process
  lifetime. Not fixed — no observed session length makes this material,
  and pruning would need a "still reachable" pass on every `update` that
  the controller doesn't currently need for anything else.
- **Controller dispose idempotency**: `dispose()` before any mount is a
  silent no-op (zero `setWidget` calls, matching Tool Constellation's and
  Token Tide's established pre-mount-guard finding); a second `dispose()`
  call after a real teardown emits no extra `setWidget(..., undefined)`
  call; and — a shape not previously tested on any other Wave 2 feature —
  a session event arriving *after* `dispose()` correctly remounts a fresh
  widget rather than staying permanently dormant, since `#mount` is reset
  to `undefined` on teardown and `#handleEvent`'s `if (!this.#mount)`
  branch treats that indistinguishably from "never mounted".

One real bug found and fixed (`budGlyph(NaN)` → literal `"undefined"` in
rendered output); every other edge case degraded gracefully by design.
`bun test packages/coding-agent/test/session-bonsai.test.ts`: 45 pass, 0
fail. Root `bun run check` green across all workspaces after the fix.
`bun check`: green.

### 4. Todo Meteors — hardening notes

Added 15 edge-case behavioral tests to
`packages/coding-agent/test/todo-meteors.test.ts` (43 total, up from 28),
covering `ember.ts`'s pure glyph/pulse/column math, `TodoMeteorState`'s
phase-diffing/pruning, and the controller's dispose/remount lifecycle:

- **Real bug found and fixed**: both `meteorGlyph` and `emberGlyph` had
  the exact same missing-fallback shape Session Bonsai's `budGlyph` bug
  established — `METEOR_GLYPHS[NaN]` / `EMBER_GLYPHS[NaN]` are `undefined`
  for a `NaN` progress/brightness input, which would render the literal
  string `"undefined"` into the ember horizon or meteor lane instead of
  degrading to the dimmest glyph. Confirmed via a standalone repro before
  touching source. Fixed both with the same `?? GLYPHS[0]` pattern
  `waveGlyph`/`budGlyph` already use. `NaN` is reachable here in a way it
  wasn't for Session Bonsai's growth fraction: `urgencyPulse` propagates a
  `NaN` `elapsedMs` straight through `combineBrightness` into
  `emberGlyph`, and a `NaN`-launched meteor's `meteorProgress` flows into
  `meteorGlyph` — both now locked in by tests asserting the NaN case
  matches `meteorGlyph(0)`/`emberGlyph(0)` rather than being `undefined`.
- **`meteorColumn` is a distinct, deliberately-NOT-fixed case**: unlike the
  two glyph lookups above, a `NaN` progress makes `meteorColumn` return
  `NaN` too — but since it's used only as an array index
  (`lane[meteorColumn(...)] = ...`), assigning at a `NaN` key lands on a
  non-index property invisible to `Array.prototype.join`, silently
  dropping that meteor from the rendered lane rather than corrupting it
  with visible garbage text. No text-corruption risk, so left as
  graceful degradation-by-design (same category as Tool Constellation's
  grid-collision finding), not fixed. `meteorColumn` for a non-positive or
  fractional lane width already clamped correctly to `0` pre-hardening.
- **`urgencyPulse` bounds**: negative `attempt` or negative `maxAttempts`
  both already returned `0` (the `attempt <= 0 || maxAttempts <= 0` guard
  catches both), and `attempt` far exceeding `maxAttempts` already clamped
  pressure to `1` via `Math.min(1, ...)` — both pre-existing guards, now
  covered by tests rather than only a doc comment.
- **`TodoMeteorState` edge cases**: an `applyPhases` call with an empty
  phase list correctly clears every ember and resets `doneCount`/
  `totalCount` to `0` (report `changed: true` on the transition); a
  `completedTasks` entry naming a phase/content pair with no matching open
  ember still spawns a meteor rather than silently dropping it (the
  `#embers.delete(key)` miss is a no-op, not a guard that skips the
  `#meteors.push`) — this is the correct shape since the engine's own
  `getCompletionTransitions` diff is the ground truth, not a derived
  ember-presence check; `pruneMeteors` on an already-empty list is a
  no-op via its own `before === 0` early return, confirmed by a dedicated
  test rather than only being implied by other tests' happy paths.
- **Rendering an all-meteor, zero-ember, zero-total snapshot**: the
  ember horizon correctly falls back to `"(no open todos)"` and the
  off-tier text reports `"no todos"` (the `totalCount === 0` branch, not
  `"0/0 done"`) even while a meteor is still mid-arc in the lane below —
  the two rows are independently derived and don't need embers present
  to render a meteor.
- **Controller dispose/remount**: `dispose()` before any mount is a
  silent no-op (matches every prior feature's pre-mount-guard finding); a
  second `dispose()` after a real teardown emits no extra `setWidget`
  call; and — the same shape Session Bonsai's hardening pass first
  exercised — a `tool_result` arriving after `dispose()` correctly
  remounts a fresh widget rather than staying dormant, since `#mount`
  resets to `undefined` on teardown.

### 5. Breathing Border — hardening notes

Added 15 edge-case behavioral tests to
`packages/coding-agent/test/breathing-border.test.ts` (53 total, up from
38), covering `breath.ts`'s pure envelope/glyph/token math under
adversarial (`NaN`/`Infinity`/backward-clock) inputs, `BreathingBorderState`
edge cases, and the controller's mount-order/dispose/remount lifecycle:

- **Real bug found and fixed**: `brightnessGlyph` had the exact same
  missing-fallback shape as Session Bonsai's `budGlyph` and Todo Meteors'
  `meteorGlyph`/`emberGlyph` bugs — `GLYPH_RAMP[Math.floor(NaN * 4)]` is
  `GLYPH_RAMP[NaN]`, which is `undefined` with no bounds-safe fallback,
  which would render the literal string `"undefined"` into the border row
  instead of degrading to the dimmest glyph. Confirmed via a standalone
  repro before touching source (`brightnessGlyph(NaN) === undefined`).
  Fixed with the same `?? GLYPH_RAMP[0]` pattern the three prior fixes
  established. `NaN` is genuinely reachable here: `breathEnvelope`/
  `exhaleEnvelope` both propagate `NaN` straight through when the caller's
  injected clock produces a `NaN` `now()` (e.g. `breathElapsedMs` computes
  `Math.max(0, now - breathStartedAt)`, which is `NaN` if `now` is `NaN`) —
  a fourth occurrence of this exact bug class is enough to call it a
  systemic gap worth grep-checking on any future glyph-ramp helper by
  default rather than waiting to be surprised again.
- **`brightnessToken(NaN)` is a documented quirk, not fixed**: unlike the
  glyph ramp's array lookup, `brightnessToken` is a plain `<` comparison
  chain (`NaN < 0.15`, `NaN < 0.6`, both false), so it falls through to the
  brightest bucket (`"borderAccent"`) rather than corrupting text — same
  category as Todo Meteors' `meteorColumn(NaN)` finding: a numeric/logic
  quirk with no visible-corruption risk, so left alone.
- **`pulsePosition`'s guard doesn't catch `NaN` width or period**: the
  `width <= 0 || periodMs <= 0` guard is false for `NaN` (all comparisons
  with `NaN` are false), so a `NaN` width or a `NaN` elapsed/period
  propagates `NaN` through to the caller rather than clamping to `0`. Traced
  all the way through `renderBreathingBorderRow`'s `travelPos` handling: a
  `NaN` `pos` makes both `BORDER_CHAR.repeat(pos)` calls receive `NaN`,
  which `String.prototype.repeat` treats as `0` (not a `RangeError`, unlike
  a genuine negative count) — so this never crashes, and after the
  `brightnessGlyph` fix above it never prints `"undefined"` either. Locked
  in with a dedicated "never contains the literal text 'undefined'" test
  across both tiers rather than fixing the guard, since the failure mode is
  fully contained.
- **`renderBreathingBorderRow` with a `NaN` width** also skips the
  `width <= 0` early-return empty-row path for the same `NaN <= 0 is false`
  reason, but resolves harmlessly to an empty string via the same
  `repeat(NaN) === ""` behavior — documented as a surprising-but-harmless
  quirk rather than a second guard needing a fix.
- **`BreathingBorderState` edge cases**: `settleIfDone` is idempotent once
  idle (repeated calls after the first `true` stay `false`, no re-trigger);
  calling `applyAgentEnd` twice in a row (e.g. a duplicate event) correctly
  restarts the exhale timer from the second call rather than keeping the
  first's start time; `applyTurnEnd` with no matching `turn_start` ever
  observed is a no-op (guarded by `turnStartedAt === undefined`); a
  backward-skewed turn (`turn_end`'s `now` earlier than `turn_start`'s)
  produces a negative raw duration that `breathPeriodMsForTurnDuration`'s
  own `<= 0` guard already clamps to the base period; and
  `breathElapsedMs`/`exhaleElapsedMs` both clamp backward clock skew to `0`
  via their existing `Math.max(0, ...)` calls.
- **Controller mount-order and dispose/remount**: `agent_end` firing before
  any `agent_start` (the doc comment's "unlikely case it fires first")
  correctly mounts a fresh widget straight into the (no-op, since state was
  never `active`) exhale path rather than crashing on an unmounted state;
  `dispose()` before any mount and a second `dispose()` after a real
  teardown are both silent no-ops (matches every prior feature's
  pre-mount-guard finding); `turn_start`/`turn_end` before any
  `agent_start` update `BreathingBorderState` without mounting a widget;
  and — the same shape Session Bonsai/Todo Meteors' hardening passes first
  exercised — a fresh `agent_start` after `dispose()` correctly remounts
  rather than staying dormant.

Two real bugs found and fixed (`meteorGlyph(NaN)` and `emberGlyph(NaN)` →
literal `"undefined"` in rendered output, the same class as Session
Bonsai's `budGlyph`); every other edge case degraded gracefully by design.
`bun test packages/coding-agent/test/todo-meteors.test.ts`: 43 pass, 0
fail. Root `bun run check` green across all workspaces after the fix.

### 6. Agent Fleet — hardening notes

Added 14 edge-case behavioral tests to
`packages/coding-agent/test/agent-fleet.test.ts` (52 total, up from 27),
covering `firefly.ts`'s pure brightness/glyph/wobble math under adversarial
(`NaN`/`Infinity`) inputs, `AgentFleetState` edge cases, and the
controller/widget's dispose/remount idempotency:

- **Real bug found and fixed**: `fireflyGlyph` had the exact same
  missing-fallback shape as every prior glyph-ramp bug this run has found
  (Session Bonsai's `budGlyph`, Todo Meteors' `meteorGlyph`/`emberGlyph`,
  Breathing Border's `brightnessGlyph`) — this is the **fifth** occurrence.
  `clamp01(NaN)` satisfies neither the `<= 0` nor `>= 1` branch and returns
  `NaN` unclamped, so `FIREFLY_GLYPHS[Math.floor(NaN * 4)]` is
  `FIREFLY_GLYPHS[NaN]`, i.e. `undefined`, with no bounds-safe fallback —
  confirmed via a standalone repro (`fireflyGlyph(NaN) === undefined`)
  before touching source. Fixed with the same `?? FIREFLY_GLYPHS[0]`
  pattern as all four prior fixes. `NaN` is genuinely reachable here:
  `workingBrightness(NaN)` (a bad/`NaN` clock reading passed as
  `elapsedSinceSpawnMs`) propagates straight through `Math.sin(NaN)` into a
  `NaN` brightness, which then hit the unguarded glyph lookup. Given this
  is now a five-for-five recurrence across every glyph-ramp helper checked
  so far, any future Wave 2 feature's glyph-ramp helper should be
  grep-checked for this exact `RAMP[index]` (no `??` fallback) shape
  proactively rather than waiting to rediscover it again.
- **`isPrunable(status, NaN)` never prunes**: `NaN >= FAILED_LINGER_MS` and
  `NaN >= FADE_DURATION_MS` are both `false`, so a firefly whose elapsed
  time reads `NaN` (e.g. a corrupted clock) lingers on screen forever
  rather than being silently dropped or crashing — the same
  "graceful-degradation, not a crash" shape as `brightnessToken(NaN)` in
  Breathing Border and `meteorColumn(NaN)` in Todo Meteors. Documented and
  locked in with a test rather than "fixed", since forcing a stuck firefly
  to prune on bad clock data isn't obviously the right call either.
- **`wobblePhase` with `NaN` seed or elapsed time** resolves to the center
  (`0`) rest state rather than throwing — `Math.sin(NaN)` is `NaN`, and
  `NaN > 0.33`/`NaN < -0.33` are both `false`, so the ternary falls through
  to its final `0` branch. No fix needed.
- **`driftSeed("")`** (an empty agent id, theoretically possible if a
  future registry ever assigns a blank id) hashes cleanly via the same
  FNV-1a path every other id takes, producing a stable, in-range seed —
  confirmed rather than assumed.
- **`AgentFleetState` edge cases**: a `status_changed` event carrying only
  a `displayName` change (no status transition) updates the name in place
  without touching `status` or `statusChangedAt` — the two are independent
  fields in the same branch and this path was previously untested; a
  second `removed` event for an id already removed is correctly a no-op
  (`Map.delete` returns `false`); and `pruneFireflies` given a `NaN`
  `elapsedMs` (propagating the same bad-clock scenario above) doesn't
  crash and reports no pruning, consistent with `isPrunable(status, NaN)`.
- **Display-cap boundary**: exactly `MAX_FIREFLIES_SHOWN` (12) fireflies
  renders with no `"+N"` trailer; the 13th firefly is the first to trigger
  `"+1"` — the off-by-one boundary itself was untested (only the
  well-past-cap 14-firefly case was covered previously).
- **Controller/widget dispose idempotency and remount**: `dispose()` called
  twice in a row is silent on the second call (no double `setWidget`
  clear); `watch()` called again after a prior `dispose()` correctly
  resubscribes to the registry and can mount a fresh widget on the next
  event (the same stop/restart recovery shape Session Bonsai and Todo
  Meteors' hardening passes established for their own controllers); and
  `AgentFleetWidget.dispose()` itself is idempotent (double dispose doesn't
  throw or double-unsubscribe from the `AnimationHost`).

One real bug found and fixed (`fireflyGlyph(NaN)` → literal `"undefined"`
in rendered output, the fifth occurrence of this exact bug class this
run); every other edge case degraded gracefully by design.
`bun test packages/coding-agent/test/agent-fleet.test.ts`: 52 pass, 0
fail. Root `bun run check` green across all workspaces after the fix.

### 7. Cost Candle — hardening notes

Added 15 edge-case behavioral tests to
`packages/coding-agent/test/cost-candle.test.ts` (40 total, up from 25),
covering `candle.ts`'s pure flame/wax/gutter math under adversarial
(`NaN`/`Infinity`) inputs, `CostCandleState` edge cases, and the
controller's dispose/remount idempotency:

- **Real bug found and fixed**: `flameGlyph` had the exact same
  missing-fallback shape as every prior glyph-ramp bug this run has found
  (Session Bonsai's `budGlyph`, Todo Meteors' `meteorGlyph`/`emberGlyph`,
  Breathing Border's `brightnessGlyph`, Agent Fleet's `fireflyGlyph`) —
  this is the **sixth** occurrence. `flameGlyph`'s own clamp (`brightness
  <= 0 ? 0 : brightness >= 1 ? 1 : brightness`) leaves `NaN` unclamped
  (neither branch is true for `NaN`), so `Math.min(3, Math.floor(NaN *
  4))` is `NaN` and `FLAME_GLYPHS[NaN]` is `undefined` — confirmed via a
  standalone repro before touching source. Fixed with the same `??
  FLAME_GLYPHS[0]` pattern as all five prior fixes. `NaN` is genuinely
  reachable here through a new path not seen in prior features:
  `CostCandleState.recordMessageCost` validates `costUsd` but never
  validates the `elapsedMs` clock reading it's stamped with, so a single
  bad (`NaN`) scheduler tick at record time permanently poisons
  `lastMessageAt`; every later render then computes `msSinceTurn =
  elapsedMs - NaN = NaN`, which `gutterEnvelope` and `flameBrightness`
  both propagate straight through to the glyph lookup. Given this is now
  a six-for-six recurrence across every glyph-ramp helper checked so far,
  the remaining unhardened features (Reflection Ripple, Memory Crystals,
  Context Constellation, Diff Bloom, Cadence Equalizer, Goal Horizon,
  Model Weather Vane, Prompt Charge) should each be grep-checked for this
  exact `RAMP[index]` (no `??` fallback) shape as the *first* step of
  their hardening pass.
- **`waxRemaining`/`gutterIntensity` mishandle `Infinity`** the same way
  as `NaN`: both guard with `!Number.isFinite(x) || x <= 0`, which is
  correct for `NaN`/negative/zero but means a literal `Infinity` cost
  reads as `waxRemaining(Infinity) === 1` (a *fresh* candle) and
  `gutterIntensity(Infinity) === 0` (*no* gutter) — backwards from the
  "maximally expensive" reading you'd expect. Confirmed unreachable via
  the real pipeline: `recordMessageCost` already rejects any non-finite
  `costUsd` (including `Infinity`) before it can accumulate into
  `totalCostUsd`, so this quirk can only be hit by calling the pure
  functions directly with an adversarial value. Documented and locked in
  with a test rather than "fixed", matching the established
  graceful-degradation-by-design category (`isPrunable(status, NaN)` in
  Agent Fleet, `brightnessToken(NaN)` in Breathing Border).
- **`waxBar` degrades safely for `NaN` remaining/width**: both produce
  `""` (not a crash, not corrupted glyphs) because `Math.round(NaN)` is
  `NaN` and `String.prototype.repeat(NaN)` coerces to `repeat(0)` per
  spec — same "NaN survives `.repeat()` harmlessly" shape Breathing
  Border's hardening pass first documented for `pulsePosition`. A
  non-integer width (e.g. `10.7`) also doesn't throw (`.repeat()` floors
  the fractional remainder). One quirk *does* throw — `waxBar(x,
  Infinity)` hits `.repeat(Infinity)`, which is a `RangeError` — but this
  is unreachable in practice since the widget always calls it with the
  hardcoded `WAX_BAR_WIDTH = 16` constant, never a value derived from
  external input; left undocumented-in-code (no test asserts the throw)
  since it can't happen through any real call site.
- **`gutterEnvelope(NaN, ...)`** propagates `NaN` without crashing (same
  category as the `Infinity` quirks above), and `gutterEnvelope(1,
  Infinity)` correctly decays to `0` (an infinitely-idle candle reads as
  fully calm) since the `elapsed >= GUTTER_DECAY_MS` branch is `true` for
  `Infinity`.
- **`formatUsd`** renders finite negative amounts verbatim (e.g. `-5` →
  `"$-5.00"`, not clamped to `$0.00` — only *non-finite* amounts get the
  `$0.00` fallback) and both `Infinity`/`-Infinity` correctly hit that
  fallback.
- **`CostCandleState.recordMessageCost`** ignores an infinite cost
  (guarded, same as `NaN`/negative) but correctly accepts a `0` cost as a
  real, free message — increments `messageCount` and leaves
  `lastGutterPeakIntensity` at `0`, distinguishing "no message yet" from
  "a message that cost nothing" was previously untested.
- **Controller dispose/remount idempotency**: `dispose()` before any
  message has ever mounted a widget is a safe no-op (no stray
  `setWidget` call); `dispose()` called twice in a row after a mount is
  idempotent (no double clear); and a `message_end` arriving after
  `dispose()` correctly remounts a fresh widget (`#mount` resets to
  `undefined` on teardown) — the same remount shape established by every
  prior controller's hardening pass.
- **A `NaN`-cost `message_end`** still mounts the widget on first sight
  (the mount check runs unconditionally, independent of whether
  `recordMessageCost` actually changed state) while leaving
  `messageCount` at `0` — existing intended behavior, now covered rather
  than assumed.

One real bug found and fixed (`flameGlyph(NaN)` → literal `"undefined"`
in rendered output, the sixth occurrence of this exact bug class this
run, reached via a newly-discovered "unvalidated clock reading poisons
state permanently" path); every other edge case degraded gracefully by
design or is provably unreachable via the real pipeline.
`bun test packages/coding-agent/test/cost-candle.test.ts`: 40 pass, 0
fail. Root `bun run check` green across all workspaces after the fix.

### 8. Reflection Ripple — hardening notes

Added 22 edge-case behavioral tests to
`packages/coding-agent/test/reflection-ripple.test.ts` (47 total, up from
25), covering `ripple.ts`'s pure progress/radius/brightness/glyph/dim
math under adversarial (`NaN`/`Infinity`/negative) inputs,
`ReflectionRippleState`'s clock-skew edge cases, and widget/controller
dispose idempotency:

- **Real bug found and fixed**: `ringGlyph` had the exact same
  missing-fallback shape as every prior glyph-ramp bug this run has
  found (Session Bonsai's `budGlyph`, Todo Meteors'
  `meteorGlyph`/`emberGlyph`, Breathing Border's `brightnessGlyph`,
  Agent Fleet's `fireflyGlyph`, Cost Candle's `flameGlyph`) — this is the
  **seventh** occurrence. `ringGlyph`'s own clamp (`brightness <= 0 ? 0 :
  brightness >= 1 ? 1 : brightness`) leaves `NaN` unclamped (neither
  branch is true for `NaN`), so `Math.floor(NaN * RING_GLYPHS.length)`
  is `NaN` and `RING_GLYPHS[NaN]` is `undefined`. `NaN` is genuinely
  reachable through the real pipeline: `reflectDimAmount(NaN, ...)` and
  `rippleBrightness(rippleProgress(NaN, ...))` both propagate `NaN`
  straight through to `ringGlyph` when the controller's injected clock
  (`this.#scheduler.now()`) or `applyTrigger`'s `now` argument is
  itself `NaN` at trigger time. Fixed with the same `?? RING_GLYPHS[0]`
  pattern as all six prior fixes.
- **A genuinely new, surprising `NaN`-clock consequence** (distinct from
  every prior feature's "permanently poisons state" finding): triggering
  with a `NaN` timestamp does **not** cause `settleIfDone` to hang
  forever. `settleIfDone`'s early-return guard is `if
  (this.rippleElapsedMs(now) < SETTLE_MS) return false` — and since
  `NaN < SETTLE_MS` is `false` for any `SETTLE_MS`, the guard never
  triggers, so the very next `settleIfDone` call falls straight through
  to the success path and settles the ripple to `idle` immediately.
  A `NaN`-poisoned "wait until enough time has passed" guard written as
  `if (elapsed < threshold) return early` is backwards for `NaN` — it
  reads as "already past the threshold," not "wait forever" as the
  cadence-equalizer/cost-candle "clock poisons state" precedent might
  suggest. Worth checking this exact guard shape (`<`-comparison used as
  a *stay-pending* gate) on any remaining feature, since it's the
  opposite failure mode from a `<=`/`>=`-comparison clamp (which lets
  `NaN` through unclamped).
- **`rippleRadius`/`rippleBrightness`/`dimMultiplier`/`reflectDimAmount`
  all propagate `NaN` without crashing** (comparison-chain/clamp logic,
  not array lookups) — same graceful-degradation category as every
  prior feature's non-glyph-lookup quirks (`isPrunable(status, NaN)` in
  Agent Fleet, `brightnessToken(NaN)` in Breathing Border,
  `gutterEnvelope(NaN, ...)` in Cost Candle).
- **`rippleRadius` correctly clamps a negative or zero `maxRadius` to
  `0`** rather than a negative distance, and `Infinity` inputs to
  `rippleProgress`/`rippleBrightness`/`ringGlyph` all clamp to their
  "fully expanded/faded" extreme rather than producing a different
  quirk.
- **`ReflectionRippleState.rippleElapsedMs` clamps backward clock skew**
  (`now` before `triggeredAt`) to `0` via its existing `Math.max(0, ...)`
  guard — already correct, now covered rather than assumed.
- **Controller dispose idempotency**: `dispose()` before any trigger has
  ever mounted a widget is a safe no-op; `dispose()` called twice in a
  row after a mount is idempotent (no double clear); an empty
  `rules: []` array on `ttsr_triggered` still mounts and ripples with an
  empty rule-names snapshot rather than throwing.

No other real bugs found — every remaining edge case (negative width,
an empty rule-names array, widget-level double dispose) degraded
gracefully by design.
`bun test packages/coding-agent/test/reflection-ripple.test.ts`: 47
pass, 0 fail. Root `bun run check` green across all workspaces after the
fix.

### 9. Memory Crystals — hardening notes

Added 15 edge-case behavioral tests to
`packages/coding-agent/test/memory-crystals.test.ts` (36 total, up from
21), covering `crystal.ts`'s pure magnitude/glyph/sparkle/format math
under adversarial (`NaN`/`Infinity`) inputs, `MemoryCrystalsState`'s
clock-skew and NaN-poisoned-spawn edge cases, byte-stable rendering of
an adversarial wide tray, and controller dispose/remount idempotency:

- **Real bug found and fixed**: `gemGlyph` had the exact same
  missing-fallback shape as every prior glyph-ramp bug this run has
  found (Session Bonsai's `budGlyph`, Todo Meteors'
  `meteorGlyph`/`emberGlyph`, Breathing Border's `brightnessGlyph`,
  Agent Fleet's `fireflyGlyph`, Cost Candle's `flameGlyph`, Reflection
  Ripple's `ringGlyph`) — this is the **eighth** occurrence. `gemGlyph`'s
  own clamp (`magnitude <= 0 ? 0 : magnitude >= 1 ? 1 : magnitude`)
  leaves `NaN` unclamped (neither branch is true for `NaN`), so
  `Math.floor(NaN * GEM_GLYPHS.length)` is `NaN` and `GEM_GLYPHS[NaN]`
  is `undefined`. Unlike most prior occurrences, `NaN` is **not**
  reachable through the real pipeline today — `MemoryCrystalsState`
  always feeds `gemGlyph` a `magnitude` computed via
  `crystalMagnitude(safeTokens)`, whose own `Number.isFinite` guard
  already forecloses `NaN`. Fixed anyway (same `?? GEM_GLYPHS[0]`
  pattern as all seven prior fixes) since `gemGlyph` is an exported pure
  function any future caller could feed directly, and the fix is free —
  documented as "latent, not currently reachable" rather than
  overstating exploitability.
- **A genuinely new NaN-poisoning shape, distinct from Cost Candle's
  "permanently poisons all future decay math"**: `applyCompactionEnd`
  stamps `spawnedAt` straight from its `elapsedMs` clock-reading
  parameter with **no** `Number.isFinite` validation (unlike
  `tokensBefore`, which the method does validate before use). A single
  `NaN` clock reading at record time permanently poisons that one
  crystal's `spawnedAt` — but because `renderMemoryCrystalsRow`'s sparkle
  gate is written as `sinceSpawn >= 0 ? sparkleIntensity(sinceSpawn) : 0`
  (a `>=`-guard, not a `<`-stay-pending guard), `NaN >= 0` is `false` and
  the crystal simply never sparkles again — it silently reads as
  "already settled" rather than corrupting output or hanging, the same
  benign-looking-but-worth-noting outcome as Reflection Ripple's
  `settleIfDone` finding, reached through a different guard shape.
- **`sparkleIntensity(elapsedMs, Infinity)` is a documented-not-fixed
  quirk**: an infinite `durationMs` makes `elapsedMs / durationMs`
  always `0`, so `cos(0)` keeps the crystal at full brightness (`1`)
  forever regardless of `elapsedMs` — backwards from the "decays to 0"
  intent. Provably unreachable via the real pipeline (`durationMs`
  always defaults to the `SPARKLE_DURATION_MS` constant, never an
  event-derived value), so left as a locked-in-by-test quirk rather than
  a fix, matching Cost Candle's `waxRemaining`/`gutterIntensity` and
  Reflection Ripple's `Infinity`-clamping precedent for pure-function
  edge cases with no real call site.
- **`crystalMagnitude(Infinity)` is `0`, not `1`**: `Infinity` fails the
  `Number.isFinite` guard before the ratio is computed, so an infinitely
  large token count reads as "nothing to reclaim" rather than "maximally
  large" — the same `!Number.isFinite(x)` -> safe-default-not-clamped-max
  shape already documented for Cost Candle's `waxRemaining`.
- **Backward clock skew across compactions** (`elapsedMs` decreasing
  between two `applyCompactionEnd` calls) is stored as-is per-crystal
  with no reordering or crash — the tray is append-ordered by call
  order, not by `spawnedAt`, so out-of-order clock readings can't
  scramble tray order the way they might a time-sorted structure.
- **Controller dispose idempotency**: `dispose()` before any compaction
  has ever mounted a widget is a safe no-op; `dispose()` called twice in
  a row after a mount is idempotent (no double clear); a new compaction
  arriving after `dispose()` remounts a fresh animated widget cleanly
  (state survives — only the mount tore down).

No other real bugs found — `formatTokensCompact`, `hiddenCount`'s
`Math.max(0, ...)` floor, and every remaining `NaN`/`Infinity` input
degraded gracefully by design.
`bun test packages/coding-agent/test/memory-crystals.test.ts`: 36 pass,
0 fail. Root `bun run check` green across all workspaces after the fix.

### 10. Context Constellation — hardening notes

Added 17 edge-case behavioral tests to
`packages/coding-agent/test/context-constellation.test.ts` (41 total, up
from 24), covering `sky.ts`'s pure math under adversarial (`NaN`/`Infinity`)
inputs, `ConstellationState` clock-skew/NaN-poisoning edge cases,
out-of-bounds rendering, and controller dispose/remount idempotency:

- **Real bug found and fixed — a new shape, not the recurring glyph-ramp
  one**: unlike every prior hardening pass (features #1-9, all of which
  hit the same "array-lookup glyph helper missing `?? GLYPHS[0]`" bug),
  Context Constellation has no such array — its glyphs are fixed
  constants, not a fraction-indexed ramp. Instead, `sweepProgress`'s own
  clamp (`durationMs <= 0 || elapsedMs >= durationMs`) leaves a non-finite
  `elapsedMs` **or** `durationMs` unclamped (neither branch is true for
  `NaN`), so `easeOutCubic(NaN / durationMs)` returns `NaN`. That `NaN`
  then flows into `lerpCells`, whose own clamp (`progress <= 0 ? 0 :
  progress >= 1 ? 1 : progress`) also leaves `NaN` unclamped, so
  `Math.round(from + (to - from) * NaN)` is `NaN` — and in
  `renderConstellationRow`, a `NaN` `displayed` count makes `rank >=
  displayed` false for **every** rank, so the entire grid renders as
  permanently fully-lit stars regardless of the real fill state, and
  (per the sweep's "never cleared" design) stays corrupted forever, not
  just for one frame. This is worse than the glyph-ramp bugs' single
  `"undefined"` glyph — a full-grid, permanent visual lie. Fixed by
  adding `!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs)` to
  `sweepProgress`'s early-return-1 guard, so a bad clock reading now
  snaps the sweep straight to its real target instead of corrupting
  every future frame. Like most of this run's fixes, unreachable via the
  real pipeline today (`DEFAULT_FRAME_SCHEDULER`'s `now()` is always
  finite, and `durationMs` always defaults to the `SWEEP_DURATION_MS`
  constant) — fixed anyway since both are exported pure functions any
  future caller could feed directly, and the fix is free.
- **`lerpCells(from, to, NaN)` still propagates `NaN`** — left
  undocumented-in-code (no independent guard added) since its only real
  call site (`displayedFilledCells`) can no longer feed it a `NaN`
  progress after the `sweepProgress` fix above; covered by a test that
  locks in the current pass-through behavior as a known, currently-dead
  quirk rather than silently leaving it untested.
- **`clampPercent`/`cellsForPercent` were already correctly guarded**:
  both already had `Number.isFinite` checks before this pass (unlike
  `sweepProgress`), so `NaN`/`±Infinity` percent/cells inputs were
  already degrading to `0` gracefully — confirmed by test, no fix
  needed.
- **`RANK_OF_CELL[cellIndex] ?? 0` fallback** for an out-of-bounds cell
  index (a `rowStart` past the grid) was previously only implicit in the
  code, never exercised by a test — confirmed it renders a valid
  lit/unlit glyph, never the literal string `"undefined"`.
- **`renderConstellationRow` with `rowCells = 0`** renders an empty
  string without throwing (the `for` loop simply never iterates).
- **100% usage renders every cell lit with no dangling comet/flare**
  once fully settled — confirmed the grid saturates cleanly at the top
  end, mirroring similar saturation checks in other features' hardening
  passes.
- **Controller dispose idempotency**: `dispose()` before any mount is a
  safe no-op; a second `dispose()` call after a mount does not re-clear
  the widget; a `"context"` event arriving after `dispose()` remounts a
  fresh animated widget cleanly with state intact.

`bun test packages/coding-agent/test/context-constellation.test.ts`: 41
pass, 0 fail. Root `bun run check` green across all workspaces after the
fix. Bead: oh-my-pi-cag.
