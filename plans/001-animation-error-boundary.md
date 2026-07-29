# Plan 001: Add a fail-open error boundary to the animation frame path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e7466a84f..HEAD -- packages/animation/src/animation-host.ts packages/animation/src/animated-widget.ts packages/animation/test/animation-kit.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

The extension runner isolates extension *handler invocation* (try/catch +
timeout in `runner.ts` `#runHandlerWithTimeout`, lines 576–609), but that
isolation ends the moment a handler mounts an animated widget. From then on,
every frame runs from a raw `setInterval` callback
(`DEFAULT_FRAME_SCHEDULER.start` → `AnimationHost.#tick`) with **no try/catch
anywhere in the path**: a throw in any of the 16 animation renderers — or any
future one — escapes to a process-level uncaught exception and can kill the
whole TUI. This is why the same `*Glyph(NaN)` class of bug had to be
independently fixed ~10 times across renderers: without a boundary, every
renderer is part of the process-stability surface. Putting a fail-open
boundary in the shared kit (`packages/animation`) makes a throwing renderer a
logged, quarantined cosmetic glitch instead of a crash, for all current and
future animations at once.

## Current state

- `packages/animation/src/animation-host.ts` — the shared frame clock. One
  timer, N subscribers. `#tick()` (lines 127–138) calls every listener bare:

  ```ts
  // animation-host.ts:127-138
  #tick(): void {
  	// Time-based frame-skip: drop this frame's emission under backpressure, but
  	// keep the clock running so the next emitted frame lands at real elapsed
  	// time and visuals stay smooth after the skip.
  	if (this.#backpressure.underPressure) return;
  	this.#frame++;
  	const elapsedMs = this.#scheduler.now() - (this.#startedAt ?? this.#scheduler.now());
  	// Snapshot so a listener unsubscribing mid-emit cannot skip a sibling.
  	for (const listener of [...this.#listeners]) {
  		listener(this.#frame, elapsedMs);
  	}
  }
  ```

  A throw from `listener(...)` aborts the loop (skipping siblings) and escapes
  the scheduler interval. Relevant internals: `#listeners = new Set<FrameListener>()`
  (line 49), `#sync()` (lines 100–118) reconciles the timer with
  `this.#listeners.size` and stops it when empty, `subscribe()` (lines 79–87)
  returns an unsubscribe closure that does `this.#listeners.delete(listener)`
  then `this.#sync()`.

- `packages/animation/src/animated-widget.ts` — base `Component` for all
  animated widgets. `#handleFrame` (lines 150–164) calls the subclass hooks
  bare:

  ```ts
  // animated-widget.ts:150-164
  #handleFrame(elapsedMs: number): void {
  	if (this.#disposed) return;
  	this.#elapsedMs = elapsedMs;
  	this.onFrame(elapsedMs);
  	const width = this.#lastWidth;
  	if (width === undefined) {
  		// Not laid out yet: request an initial paint; render() will produce rows.
  		this.#tui.requestComponentRender(this);
  		return;
  	}
  	const next = this.renderFrame(width);
  	if (rowsEqual(next, this.#lastRows)) return;
  	this.#lastRows = next;
  	this.#tui.requestComponentRender(this);
  }
  ```

  `dispose()` (lines 116–123) is idempotent and unsubscribes from BOTH the
  frame clock (`#unsubscribe`) and the policy (`#unsubscribePolicy`). Note the
  policy subscription (`#syncToTier`, lines 136–148) will **re-subscribe the
  widget to the host on an off→on tier crossing** — which is why host-level
  quarantine alone is not enough for widgets (see Step 2 rationale).

- `packages/coding-agent/src/extensibility/extensions/runner.ts:576-609` —
  `#runHandlerWithTimeout` has the try/catch + timeout for handler invocation.
  Do NOT modify it; it is cited here only to show where existing isolation
  ends.

- Conventions that apply:
  - Use `logger` from `@oh-my-pi/pi-utils`, never `console`.
    `@oh-my-pi/pi-utils` is already a dependency of `packages/animation`
    (see `packages/animation/package.json` "dependencies") — no package.json
    change needed. Match the call shape used elsewhere, e.g.
    `logger.error("MCP tool load failed", { path, error })` in
    `packages/coding-agent/src/sdk.ts`.
  - ES `#private` fields (already the style of both files).
  - **Behavioral tests only** — assert observable behavior (subscriber counts,
    frames delivered, `animating`, no-throw), not internals.
  - Render/state code stays pure of wall-clock — tests drive frames through
    the existing `FakeScheduler` seam in
    `packages/animation/test/animation-kit.test.ts` (lines 19–65).

## Commands you will need

| Purpose                 | Command                                                   | Expected on success |
|-------------------------|-----------------------------------------------------------|---------------------|
| Typecheck + lint pkg    | `bun --cwd=packages/animation run check`                  | exit 0              |
| Test the kit            | `bun test packages/animation/test/animation-kit.test.ts`  | all pass            |
| Typecheck all packages  | `bun run --workspaces --if-present check`                 | every pkg exit 0    |

Note: repo-wide `bun run check:tools` (biome) currently fails ONLY on an
untracked scratch file `packages/coding-agent/scripts/wave2-live-demo.ts`.
That file is not yours; ignore that specific failure.

## Scope

**In scope** (the only files you should modify):
- `packages/animation/src/animation-host.ts`
- `packages/animation/src/animated-widget.ts`
- `packages/animation/test/animation-kit.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- The 16 renderer/extension implementations under
  `packages/coding-agent/src/*` (retry-radar, diff-bloom, etc.) — the whole
  point is that the kit-level boundary covers them without touching them.
- `packages/coding-agent/src/extensibility/extensions/runner.ts` — handler
  isolation already exists there.
- `packages/tui/` — no TUI render-path changes in this plan (see Maintenance
  notes for the deferred `render()`-path edge).
- `packages/animation/package.json` — no new dependencies.

## Git workflow

- Branch: `fix/animation-error-boundary` (repo uses `feat/…`/`fix/…`).
- Conventional Commits; recent example from `git log`:
  `fix(animations): guard readMotionSetting() against uninitialized Settings`.
  Suggested: `fix(animations): add fail-open error boundary to frame path`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Confirm no global handler already quarantines these

Run:
`grep -rn "uncaughtException\|unhandledRejection" packages/coding-agent/src packages/tui/src packages/animation/src --include="*.ts"`

Expected: no hit that catches-and-recovers animation frame throws (hits that
merely log-and-exit, or none at all, are fine — proceed). If you find a global
handler that already keeps the process alive AND unsubscribes/quarantines the
throwing animation, this plan is redundant — STOP and report.

**Verify**: the grep above → no recover-and-continue handler for frame throws.

### Step 1: Quarantine throwing listeners in `AnimationHost.#tick`

In `packages/animation/src/animation-host.ts`:

1. Add `import { logger } from "@oh-my-pi/pi-utils";` to the imports.
2. Replace the emit loop in `#tick()` (lines 134–137) with a per-listener
   try/catch that, on throw, removes the listener and logs. Preserve the
   existing snapshot semantics (`[...this.#listeners]`). Target shape:

   ```ts
   // Snapshot so a listener unsubscribing mid-emit cannot skip a sibling.
   let quarantined = false;
   for (const listener of [...this.#listeners]) {
   	try {
   		listener(this.#frame, elapsedMs);
   	} catch (err) {
   		// Fail-open: one bad renderer must neither stop siblings nor escape
   		// the scheduler interval as a process-level uncaught exception.
   		this.#listeners.delete(listener);
   		quarantined = true;
   		logger.error("AnimationHost listener threw; quarantined", {
   			frame: this.#frame,
   			error: err instanceof Error ? err.message : String(err),
   		});
   	}
   }
   if (quarantined) this.#sync();
   ```

   The trailing `#sync()` stops the shared timer if the quarantined listener
   was the last subscriber (same reconcile path `subscribe`'s unsubscribe
   closure uses). Do not change `#sync`, `subscribe`, or `dispose`.

**Verify**: `bun --cwd=packages/animation run check` → exit 0.

### Step 2: Self-dispose a widget whose frame hooks throw

In `packages/animation/src/animated-widget.ts`:

1. Add `import { logger } from "@oh-my-pi/pi-utils";` to the imports.
2. Wrap the body of `#handleFrame` after the `#disposed` guard in try/catch;
   on throw, log and call `this.dispose()`. Target shape:

   ```ts
   #handleFrame(elapsedMs: number): void {
   	if (this.#disposed) return;
   	this.#elapsedMs = elapsedMs;
   	try {
   		this.onFrame(elapsedMs);
   		const width = this.#lastWidth;
   		if (width === undefined) {
   			// Not laid out yet: request an initial paint; render() will produce rows.
   			this.#tui.requestComponentRender(this);
   			return;
   		}
   		const next = this.renderFrame(width);
   		if (rowsEqual(next, this.#lastRows)) return;
   		this.#lastRows = next;
   		this.#tui.requestComponentRender(this);
   	} catch (err) {
   		// Fail-open: a broken renderer freezes on its last painted frame instead
   		// of crashing the session. dispose() also detaches the policy
   		// subscription, so an off->on tier flip cannot resubscribe it.
   		logger.error("AnimatedWidget frame threw; widget disposed", {
   			widget: this.constructor.name,
   			error: err instanceof Error ? err.message : String(err),
   		});
   		this.dispose();
   	}
   }
   ```

   Rationale for having BOTH layers: the host-level catch (Step 1) is the
   backstop for raw `FrameListener`s subscribed directly (controllers do
   this), but for widgets it would only delete the frame-clock listener —
   the widget's `#unsubscribePolicy` subscription would survive, and
   `#syncToTier` (animated-widget.ts:136-148) would re-subscribe the broken
   widget on the next off→on tier crossing. Widget-level `dispose()` severs
   both. With Step 2 in place the widget catch fires first and the host catch
   almost never sees a widget throw; that redundancy is intentional.

**Verify**: `bun --cwd=packages/animation run check` → exit 0, and
`bun test packages/animation/test/animation-kit.test.ts` → all existing tests
still pass (the boundary must not change happy-path behavior).

### Step 3: Add behavioral tests for the boundary

Append a new `describe("fail-open error boundary", ...)` block to
`packages/animation/test/animation-kit.test.ts`, using the file's existing
helpers (`FakeScheduler`, `fullPolicy`, `CountingHost`, `TIER_CADENCE_MS`) —
model the setup on the `"AnimationHost coalescing"` (lines 83–137) and
`"AnimatedWidget lifecycle"` (lines 273–334) blocks. Three tests:

1. **A throwing listener does not stop siblings and does not escape `#tick`.**
   Host with two listeners; the first throws on every call, the second
   counts. `expect(() => scheduler.advance(TIER_CADENCE_MS.full * 2 + 1)).not.toThrow()`;
   sibling received 2 frames; the thrower was called exactly once (quarantined
   after its first throw); `host.subscriberCount` is 1.
2. **Quarantining the last subscriber stops the shared timer.** Host with a
   single always-throwing listener; after one advance,
   `host.subscriberCount === 0`, `scheduler.activeTimers === 0`,
   `host.running === false`.
3. **A widget whose frame hook throws disposes itself and does not throw.**
   Subclass `AnimatedWidget` in the test with `onFrame` overridden to throw
   (and `renderFrame` returning a static row); construct with
   `new CountingHost()`, a `FakeScheduler`-backed host, and `fullPolicy()`.
   Advance one cadence inside `expect(...).not.toThrow()`; then
   `widget.animating === false`, `host.subscriberCount === 0`, and
   `policy.listenerCount === 1` (only the host's own policy subscription
   remains — same assertion style as the "unsubscribes from both host and
   policy on dispose" test at the end of the file). A further advance
   produces no additional `tui.renders`.

Note: `logger.error` will print to the log during these tests; that is
expected. Do not assert on log output — assert only the observable behavior
above.

**Verify**: `bun test packages/animation/test/animation-kit.test.ts` →
all pass, including the 3 new tests.

### Step 4: Full package gate

**Verify**: `bun --cwd=packages/animation run check` → exit 0, then
`bun run --workspaces --if-present check` → every package exit 0 (this change
cannot affect other packages' types, but the workspace gate is cheap proof).

## Test plan

- New tests (Step 3) in `packages/animation/test/animation-kit.test.ts`:
  throwing-listener quarantine + sibling survival; timer stop on
  last-subscriber quarantine; widget self-dispose on frame-hook throw.
- Existing suite in the same file is the regression net for happy-path
  timing/coalescing semantics — it must pass unmodified. Do not edit any
  existing test.
- Verification: `bun test packages/animation/test/animation-kit.test.ts` →
  all pass, 3 new tests included.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun --cwd=packages/animation run check` exits 0
- [ ] `bun test packages/animation/test/animation-kit.test.ts` exits 0 with 3 new boundary tests
- [ ] `grep -n "try {" packages/animation/src/animation-host.ts` shows the catch inside `#tick`
- [ ] `grep -n "try {" packages/animation/src/animated-widget.ts` shows the catch inside `#handleFrame`
- [ ] `grep -rn "console\." packages/animation/src/` returns no matches (logger only)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if the index exists and you own the update)

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift since
  `e7466a84f`).
- Step 0 finds a global recover-and-continue handler that already quarantines
  animation frame throws — the boundary may be redundant; report what you
  found.
- Any EXISTING test in `animation-kit.test.ts` fails after Steps 1–2 — that
  means the boundary changed happy-path timing or subscription semantics,
  which this plan explicitly must not do.
- Implementing the widget catch appears to require changing `dispose()`,
  `#syncToTier`, or `subscribe()` semantics.
- A fix attempt fails verification twice.

## Maintenance notes

- **Deferred edge (known, intentionally out of scope)**: after a widget
  self-disposes, the TUI can still call its public `render(width)`. At the
  same width it returns cached rows (safe — frozen frame), but a width change
  re-invokes `renderFrame`, which may throw into the TUI render path. That
  path has different failure semantics and belongs to `packages/tui`; if it
  ever bites, the fix is a similar guard in `AnimatedWidget.render()`
  returning `#lastRows` on throw. Do not preempt it here.
- Reviewers should scrutinize: the quarantine must delete the listener from
  `#listeners` (not just skip it) and must call `#sync()` afterward, or a
  dead listener keeps the shared timer alive forever with zero visible
  output.
- Future animation authors inherit this boundary automatically — but it is a
  crash barrier, not a license: renderers should still be pure and total.
  A quarantined widget simply freezes; there is no auto-restart.
