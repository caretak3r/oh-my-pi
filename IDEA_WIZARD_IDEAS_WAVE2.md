# oh-my-pi · Animated Plugins — Wave 2

*Five new animations. Each is bolted to a real, reliably-firing agent signal (not a
timer for its own sake), each paints a distinct visual metaphor, and none overlaps
the shipped four (spinner-packs, context-weather, compaction-vacuum, retry-radar).
All build on the shipped `@oh-my-pi/pi-animation` kit: single ~30fps coalesced frame
clock, `MotionPolicy` off→subtle→full tiers, `AnimatedWidget` base, backpressure.*

**The palette I wandered (real plugin-subscribable signals):**
`session_start/switch/branch/compact/tree`, `goal_updated`, `agent_start/end`,
`turn_start/end` (token throughput), `auto_compaction_*`, `auto_retry_*`,
`ttsr_triggered`, `todo_reminder`, `tool_call/tool_result` (per tool).
Paint surfaces: `setWidget(key, factory, {placement: aboveEditor|belowEditor})`,
`setStatus`, `notify`, `theme`, the kit frame clock.

---

## The Top 5 (best → worst)

### 1. 🌌 Tool Constellation — *the session as a living star map*
**Signal:** `tool_call` / `tool_result` (extension events; every tool fires them).
**Metaphor:** Each tool *type* is a fixed star in a small night-field. When a tool
fires, its star **flares** and a faint ley-line traces from the previously-used star,
so over a session you literally watch the *shape of the work* draw itself —
Read = cyan, Edit/Write = amber, Bash = green, Grep/Glob = violet, Agent = magenta,
MCP = teal. Idle stars slowly dim; the newest carries a comet head.
**Render:** `belowEditor` widget. Deterministic layout — hash tool name → grid cell,
so the sky is stable within a session. Per-star brightness is a *pure function* of
`now − lastFireAt` (decay), so the whole field is reconstructable from the frame clock.
**Motion tiers:** `full` = flares + ley-lines + idle twinkle · `subtle` = dots that
brighten on fire, no twinkle/lines · `off` = a one-line tool tally (`⛏ 12 · ✎ 5 · ⚡ 3`).
**Why it wins:** informative *and* beautiful — a live activity map that reads as art.
Highest signal density of the five; the event fires constantly so it's never dead.
**Challenge:** stable hashed layout, decay math, backpressure sheds twinkle → lines → flares in order.

### 2. 〰️ Token Tide — *an oscilloscope for the model's mind*
**Signal:** live `tokensPerSecond` (already computed in `status-line/token-rate.ts`).
**Metaphor:** A thin scrolling **waveform ribbon**. Steady streaming → a smooth sine;
bursty generation → jagged peaks; between turns → a near-flat line with a faint resting
pulse (a heartbeat at idle). Hue warms as throughput climbs (cool teal → hot amber).
**Render:** one- or two-row widget fed by a ring-buffer of throughput samples; the
scroll offset is a pure function of frame phase, so it's smooth and cheap.
**Motion tiers:** `full` = scrolling waveform · `subtle` = a single pulsing VU bar ·
`off` = numeric `142 tok/s`. Reuses the exact signal the `reactive` spinner pack consumes.
**Why it wins:** turns an invisible number into a felt rhythm — you *see* the model
think fast or stall. Distinct from every existing widget; grounded in a signal that already exists.
**Challenge:** ring-buffer + downsample under backpressure; keeping a 1-row waveform legible.

### 3. 🌳 Session Bonsai — *the conversation as a growing tree*
**Signal:** `session_tree` / `session_branch` (emitted at `autoresearch/index.ts:250`; `SessionTreeEvent`).
**Metaphor:** The session's branch DAG rendered as a small living **bonsai**. Branching
a session **sprouts a new limb** that unfurls over ~1s; the active path glows and its tip
shimmers; abandoned branches fade to bare twigs. Your whole exploration history becomes
one quiet, legible plant.
**Render:** compact tree layout; the grow animation is an interpolation over the branch's
spawn timestamp (pure of wall-clock — elapsed is the input).
**Motion tiers:** `full` = unfurl + tip shimmer · `subtle` = static tree, active path
bold · `off` = `branch 2 of 3`.
**Why it wins:** the most *unique* and emotionally resonant — nobody expects their branch
history to be a bonsai. Turns an abstract DAG into something you want to tend.
**Challenge:** tree layout in a tiny box; legibility as branches multiply; graceful pruning.

### 4. ☄️ Todo Meteors — *burndown you can feel*
**Signal:** `todo_reminder` (`todos`, `attempt`, `maxAttempts`; fired at `event-controller.ts:1352`) + `goal_updated`.
**Metaphor:** Open todos are a **horizon of embers**. Completing one launches it as a
**shooting star** arcing off-screen. Remaining embers glow by priority; as a todo's
reminder `attempt` climbs (the agent keeps forgetting), its ember pulses more urgently.
**Render:** thin `aboveEditor` strip; completion detected by diffing successive
`todo_reminder` payloads; the meteor is a parametric arc over elapsed-since-completion.
**Motion tiers:** `full` = meteor arcs + ember flicker · `subtle` = embers brighten/dim
on change · `off` = `3/7 done`.
**Why it wins:** progress made visceral and rewarding without a nagging checklist; the
urgency-pulse is a genuinely useful nudge grounded in real reminder-attempt data.
**Challenge:** stable diff of todo lists across reminders; arc physics; not being cutesy under pressure.

### 5. 🫧 Breathing Border — *ambient presence, felt not seen*
**Signal:** `agent_start` / `agent_end` (always fire, once per prompt) + `turn_start/end` for cadence.
**Metaphor:** While the agent works, the editor frame **breathes** — a faint luminance
pulse travels the border on a ~4s inhale/exhale. When the agent hands control back, it
gives one slow exhale and goes perfectly still. Idle is *silence*. The room has a pulse
only while someone's thinking in it.
**Render:** border-character weight/brightness as a function of frame phase; freezes
instantly on backpressure or `agent_end`.
**Motion tiers:** this animation's *headline feature* is the ladder itself — `full` =
traveling luminance pulse · `subtle` = only the corner glyphs breathe · `off` = static.
The best demo of the whole `MotionPolicy` design.
**Why it wins:** the tasteful counterweight to the four "eventful" ones — always present,
never loud. The hardest kind of animation: restraint. Ships an ambient sense of *aliveness*.
**Challenge:** restraint. Must never distract, must freeze under load, must feel like breath not a strobe.

---

## The Next 10 (complementary / future)

6. **🪰 Agent Fleet** — spawned subagents as drifting fireflies (bright = working, fade =
   done, red blink = failed). Grounded in `Agent`-tool `tool_call`s + agent lifecycle.
7. **🕯️ Cost Candle** — accumulated spend burns a candle down; expensive turns gutter the
   flame, cheap turns barely flicker. Grounded in per-turn cost.
8. **🌊 Reflection Ripple** — `ttsr_triggered` → a calm concentric ripple + dim, the agent
   visibly "taking a breath" before it reflects.
9. **💎 Memory Crystals** — extend compaction-vacuum: compacted messages crystallize into a
   gem that drops into a memory tray. Grounded in `auto_compaction_end.result`.
10. **✨ Context Constellation** — context window as a night sky filling with stars;
    compaction = a shooting-star sweep clearing them. A context-weather cousin.
11. **🌸 Diff Bloom** — Edit/Write results bloom green (added) / wither red (removed) with a
    wipe. Grounded in `tool_result` of edit tools.
12. **🎚️ Cadence Equalizer** — a tiny status-line VU equalizer dancing to `tokensPerSecond`
    (a lighter cousin of Token Tide for the status line only).
13. **🌅 Goal Horizon** — `goal_updated` → a sunrise-gradient bar filling toward the goal;
    milestones flare. Grounded in `Goal` / `GoalModeState`.
14. **🧭 Model Weather Vane** — model switches animate a vane/emblem swap, one color per model.
15. **⚡ Prompt Charge** — the input caret glows/charges as you type a longer prompt, releasing
    on submit. Grounded in `getEditorText` length.

---

*Grounding verified this pass: `tokensPerSecond` (token-rate.ts), `session_tree`/`session_branch`
(autoresearch/index.ts:250), `todo_reminder` (event-controller.ts:1352), the full event union
(extensibility/shared-events.ts), paint surfaces (loader/utils setWidget/setStatus).*
