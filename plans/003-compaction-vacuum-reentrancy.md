# Plan 003: Make the compaction condense animation re-entrant and fall back safely

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e7466a84f..HEAD -- packages/coding-agent/src/modes/controllers/event-controller.ts packages/coding-agent/test/event-controller-compaction-vacuum.test.ts`
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

The compaction condense animation is wired directly into the core
`EventController` — it bypasses the extension runner's isolation entirely. Two
gaps follow. (1) **Leak on re-entry**: each `auto_compaction_start` assigns a
new `CompactionVacuumWidget` without disposing the previous one, and
`statusContainer.clear()` drops children WITHOUT disposing them
(`Container.clear()` ≠ `Container.dispose()` — verified below). Two starts
before an end (duplicate, overlapping, or reordered events) leave the
detached first widget subscribed to the shared animation host forever: frame
work + repaint requests every ~33 ms, unreachable, per-session. The same
overwrite drops a still-ticking plain `Loader` on the fallback path (its
`setInterval` starts in its constructor and only `stop()` clears it). (2)
**Unguarded construction on a core path**: `#ensureAnimation()` +
`new CompactionVacuumWidget(...)` run bare inside the compaction event
handler; a throw escapes into core event dispatch. Fixing both makes the
animation provably cosmetic: worst case is the plain loader, never a leak or
an escaped exception.

## Current state

- `packages/coding-agent/src/modes/controllers/event-controller.ts` — all
  changes land here.
  - Field (line 128): `#compactionVacuum: CompactionVacuumWidget | undefined;`
  - Handler wiring (lines 168–169): `auto_compaction_start` →
    `#handleAutoCompactionStart`, `auto_compaction_end` →
    `#handleAutoCompactionEnd`.
  - The start handler (lines 1209–1261). The relevant portion as it exists
    today:

    ```ts
    // event-controller.ts:1209-1261 (elided)
    async #handleAutoCompactionStart(
    	event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
    ): Promise<void> {
    	this.#cancelIdleCompaction();
    	this.#cancelIdleRecap();
    	this.#setTerminalProgress(true);
    	this.#stopWorkingLoader();
    	this.ctx.statusContainer.clear();
    	const reasonText = /* ...reason → label... */;
    	const actionLabel = /* ...action → label... */;
    	// Snapshot the before-token count now, ...
    	this.#compactionBeforeTokens = this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
    	// Motion on → the condense animation replaces the plain loader; motion off
    	// (setting off / non-TTY / CI / NO_COLOR / backpressure) falls back to it.
    	const { host, policy } = this.#ensureAnimation();
    	if (policy.tier !== "off") {
    		this.#compactionVacuum = new CompactionVacuumWidget({        // line 1239: overwrite, NO dispose of prior
    			tui: this.ctx.ui,
    			host,
    			policy,
    			action: event.action,
    			beforeTokens: this.#compactionBeforeTokens,
    			reasonText,
    			escHint: this.#maintenanceEscHint(),
    		});
    		this.ctx.statusContainer.addChild(this.#compactionVacuum);   // line 1248
    		this.ctx.ui.requestRender();
    		return;
    	}
    	this.ctx.autoCompactionLoader = new Loader(                      // fallback path: same overwrite issue
    		this.ctx.ui, /* ... */
    	);
    	this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
    	this.ctx.ui.requestRender();
    }
    ```

  - The end handler (lines 1263–1280) disposes only the CURRENT
    `#compactionVacuum` (captures it, sets the field `undefined`, calls
    `vacuum.dispose()` and `statusContainer.clear()`); it cannot reach a
    widget already overwritten by a second start.
  - Cleanup paths that DO dispose correctly (confirmed — no change needed):
    controller `dispose()` (lines 208–222: `#compactionVacuum?.dispose()` at
    214–215, then host/policy teardown) and `resetTranscriptAnchors()`
    (session switch; `#compactionVacuum?.dispose()` at 341–342). The gaps are
    ONLY the start-side overwrite and the missing try/catch.
  - `#ensureAnimation()` (lines 232–247): lazily builds/caches the shared
    `AnimationHost` + `MotionPolicy`; on reuse calls
    `this.ctx.settings.get("display.animations")` and `policy.refresh()`.
    Uses `backpressureFromTui(this.ctx.ui)` (reads `ui.renderUnderPressure`)
    and `process.stdout.isTTY`; `MotionPolicy` reads `Bun.env`
    (`NO_COLOR`/`CI`/`TERM`) because no `env` is passed — this matters for the
    test in Step 3.
  - `logger` is already imported (line 6:
    `import { logger, prompt } from "@oh-my-pi/pi-utils";`).

- `packages/tui/src/tui.ts` — proof that `clear()` does not dispose:

  ```ts
  // tui.ts:501-504
  clear(): void {
  	this.children = [];
  	this.#memoLines = undefined;
  }
  // tui.ts:513-522 — dispose() is a SEPARATE method: "Propagate teardown to
  // children. Call when the container's children are being permanently
  // discarded (not when they are detached for reuse — use {@link clear} for
  // that)."
  ```

  `children` is a public field (`tui.ts:461: children: Component[] = [];`) —
  the test uses it for observation. Do NOT "fix" this by making `clear()`
  dispose; other call sites rely on detach-for-reuse semantics.

- `packages/tui/src/components/loader.ts:20-40` — `Loader`'s constructor
  calls `this.start()`, which begins a `setInterval`; only `stop()` clears it.
  Hence the fallback-path leak on overwrite.

- `packages/animation/src/animated-widget.ts` — `#handleFrame` (lines
  150–164) only bails when `this.#disposed`; a detached-but-undisposed widget
  keeps rendering + requesting repaints each frame. `dispose()` (116–123) is
  idempotent; public getter `animating` (77–79) is true while subscribed to
  the frame clock — the test's observable.

- Event payload shape (`packages/coding-agent/src/session/agent-session.ts:485-489`):

  ```ts
  { type: "auto_compaction_start";
    reason: "threshold" | "overflow" | "idle" | "incomplete";
    action: "context-full" | "handoff" | "shake" | "snapcompact"; }
  ```

- Existing test patterns to model on:
  - `packages/coding-agent/test/event-controller-todo-reminder.test.ts` —
    constructs `new EventController(ctx)` with a partial mock
    `InteractiveModeContext` (`createContext()`, lines 11–31) and drives it
    via `await controller.handleEvent(event)`.
  - `packages/coding-agent/test/compaction-vacuum.test.ts` — widget-level
    tests; `beforeAll(initTheme)` pattern (the widget renders through the
    global theme singleton).
- Conventions: `logger` not `console`; ES `#private`; behavioral tests only;
  Conventional Commits.

## Commands you will need

| Purpose                | Command                                                                        | Expected on success |
|------------------------|--------------------------------------------------------------------------------|---------------------|
| Typecheck + lint pkg   | `bun --cwd=packages/coding-agent run check`                                    | exit 0              |
| New test               | `bun test packages/coding-agent/test/event-controller-compaction-vacuum.test.ts` | all pass          |
| Widget regression      | `bun test packages/coding-agent/test/compaction-vacuum.test.ts`                | all pass            |
| Typecheck all packages | `bun run --workspaces --if-present check`                                      | every pkg exit 0    |

Note: repo-wide `bun run check:tools` (biome) currently fails ONLY on an
untracked scratch file `packages/coding-agent/scripts/wave2-live-demo.ts`.
That file is not yours; ignore that specific failure.

## Scope

**In scope** (the only files you should modify/create):
- `packages/coding-agent/src/modes/controllers/event-controller.ts`
  (`#handleAutoCompactionStart` only)
- `packages/coding-agent/test/event-controller-compaction-vacuum.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/tui/src/tui.ts` — `Container.clear()` detach semantics are
  intentional; other call sites depend on them.
- `packages/coding-agent/src/modes/components/compaction-vacuum.ts` and
  `packages/animation/*` — the widget and kit are correct; Plan 001 hardens
  the kit separately.
- `#handleAutoCompactionEnd`, `dispose()`, `resetTranscriptAnchors()` — their
  dispose behavior is already correct (verified above).
- `packages/coding-agent/test/compaction-vacuum.test.ts` — regression net
  only; do not edit.

## Git workflow

- Branch: `fix/compaction-vacuum-reentrancy`.
- Conventional Commits; recent example from `git log`:
  `fix(animations): guard readMotionSetting() against uninitialized Settings`.
  Suggested: `fix(tui): dispose prior compaction vacuum on re-entrant start`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Dispose the prior widget/loader before mounting a new one

In `#handleAutoCompactionStart`, immediately after
`this.ctx.statusContainer.clear();` (line ~1216), add an unconditional
teardown of whatever the previous start mounted:

```ts
// Re-entrant start (duplicate/overlapping compaction events): the container
// clear() above only detaches — dispose/stop the previous status child so it
// cannot stay subscribed to the shared frame clock (widget) or keep its
// interval ticking (loader).
this.#compactionVacuum?.dispose();
this.#compactionVacuum = undefined;
this.ctx.autoCompactionLoader?.stop();
this.ctx.autoCompactionLoader = undefined;
```

Unconditional (not inside the `tier !== "off"` branch) on purpose: a first
start can mount the vacuum, the user flips `display.animations` to `off`, and
the second start takes the loader path — the stale vacuum must still die.

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0.

### Step 2: Guard animation construction with a plain-loader fallback

Restructure the animation mount in the same method so a throw from
`#ensureAnimation()` or `new CompactionVacuumWidget(...)` degrades to the
existing plain-loader path instead of escaping core event dispatch:

```ts
// Motion on → the condense animation replaces the plain loader; motion off
// (setting off / non-TTY / CI / NO_COLOR / backpressure) falls back to it.
// Construction is guarded: this is core event dispatch, not the extension
// runner — a cosmetic failure must degrade to the loader, never escape.
let vacuumMounted = false;
try {
	const { host, policy } = this.#ensureAnimation();
	if (policy.tier !== "off") {
		this.#compactionVacuum = new CompactionVacuumWidget({
			tui: this.ctx.ui,
			host,
			policy,
			action: event.action,
			beforeTokens: this.#compactionBeforeTokens,
			reasonText,
			escHint: this.#maintenanceEscHint(),
		});
		this.ctx.statusContainer.addChild(this.#compactionVacuum);
		this.ctx.ui.requestRender();
		vacuumMounted = true;
	}
} catch (err) {
	logger.error("Compaction condense animation failed; using plain loader", {
		error: err instanceof Error ? err.message : String(err),
	});
	this.#compactionVacuum?.dispose();
	this.#compactionVacuum = undefined;
}
if (vacuumMounted) return;
this.ctx.autoCompactionLoader = new Loader(
	/* ...unchanged existing loader construction... */
```

i.e. replace the current `const { host, policy } = ...; if (policy.tier !==
"off") { ...; return; }` block with the guarded version; the loader
construction below it stays byte-identical and now doubles as the catch
fallback. Keep the original comment line about motion on/off.

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0.

### Step 3: Behavioral tests

Create `packages/coding-agent/test/event-controller-compaction-vacuum.test.ts`.
Model the fixture on `event-controller-todo-reminder.test.ts`'s
`createContext()` and the theme bootstrap on `compaction-vacuum.test.ts`.

**Environment forcing (required)**: under `bun test`,
`process.stdout.isTTY` is falsy and CI sets `CI=1`, so
`#ensureAnimation`'s policy would resolve `off` and the vacuum branch would
never run. Force the gates in `beforeEach` and restore in `afterEach`:

```ts
const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const savedEnv = { CI: Bun.env.CI, NO_COLOR: Bun.env.NO_COLOR, TERM: Bun.env.TERM };
beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete Bun.env.CI;
	delete Bun.env.NO_COLOR;
	Bun.env.TERM = "xterm-256color";
});
afterEach(() => {
	if (savedIsTTY) Object.defineProperty(process.stdout, "isTTY", savedIsTTY);
	else delete (process.stdout as { isTTY?: boolean }).isTTY;
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete Bun.env[k];
		else Bun.env[k] = v;
	}
});
```

Fixture context (extend the todo-reminder shape; cast
`as unknown as InteractiveModeContext`):

```ts
import { Container } from "@oh-my-pi/pi-tui";
// ...
const statusContainer = new Container();
const ctx = {
	isInitialized: true,
	init: vi.fn(async () => {}),
	ui: {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(), // AnimatedWidget repaints through this
		renderUnderPressure: false,      // read by backpressureFromTui
		terminal: { setProgress: vi.fn() },
	},
	settings: { get: vi.fn((key: string) => (key === "display.animations" ? "full" : false)) },
	statusContainer,
	statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
	updateEditorTopBorder: vi.fn(),
	pendingTools: new Map(),
	viewSession: { isStreaming: false, getContextUsage: () => ({ tokens: 142_000 }) },
	focusedAgentId: undefined,
	showStatus: vi.fn(),
} as unknown as InteractiveModeContext;
```

The start event:
`{ type: "auto_compaction_start", reason: "threshold", action: "context-full" } as Extract<AgentSessionEvent, { type: "auto_compaction_start" }>`.

Note: the controller's host uses REAL timers here (no scheduler seam at the
controller level), so always end each test with `controller.dispose()` (and
`ctx.autoCompactionLoader?.stop()` where a loader was created) to avoid
leaked intervals.

Test 1 — **re-entrant start disposes the prior vacuum**:
1. Fire the start event once.
   **Precondition assert**: `statusContainer.children` has length 1 and
   `(statusContainer.children[0] as CompactionVacuumWidget).animating === true`.
   If this precondition fails, the env forcing didn't take — STOP condition,
   do not chase it by weakening assertions.
2. Hold `first = statusContainer.children[0] as CompactionVacuumWidget`.
3. Fire the same start event again.
4. Assert: `first.animating === false` (prior widget detached AND
   unsubscribed — this is the line that fails before the fix),
   `statusContainer.children.length === 1`, and the new
   `statusContainer.children[0] !== first` with `.animating === true`.
5. `controller.dispose()`.

Test 2 — **construction throw falls back to the plain loader, no escape**:
1. Use a settings mock that throws ONLY for the animation key (a blanket
   throw would detonate earlier inside `#setTerminalProgress`, outside the
   new guard):
   `get: (key: string) => { if (key === "display.animations") throw new Error("boom"); return false; }`.
2. `await expect(controller.handleEvent(startEvent)).resolves.toBeUndefined();`
   (the throw must not propagate).
3. Assert: `ctx.autoCompactionLoader` is defined,
   `statusContainer.children.length === 1` (the loader), and the vacuum was
   not mounted (`statusContainer.children[0]` is the same object as
   `ctx.autoCompactionLoader`).
4. Cleanup: `ctx.autoCompactionLoader.stop()`, `controller.dispose()`.

**Verify**: `bun test packages/coding-agent/test/event-controller-compaction-vacuum.test.ts`
→ all pass. Then, to prove Test 1 actually pins the bug, temporarily revert
Step 1's `#compactionVacuum?.dispose()` lines and confirm Test 1 FAILS on the
`first.animating === false` assert; re-apply the fix.

### Step 4: Regression + workspace gate

**Verify**:
`bun test packages/coding-agent/test/compaction-vacuum.test.ts packages/coding-agent/test/event-controller-todo-reminder.test.ts packages/coding-agent/test/event-controller-abort-render.test.ts`
→ all pass; then `bun run --workspaces --if-present check` → every package
exit 0.

## Test plan

- New file `packages/coding-agent/test/event-controller-compaction-vacuum.test.ts`
  (Step 3): (1) double-start disposes the prior vacuum — exactly one live
  frame-clock subscription remains; (2) construction throw → plain-loader
  fallback, nothing escapes `handleEvent`. Both include the revert-check in
  Step 3's Verify to prove they pin the pre-fix behavior.
- Pattern sources: fixture from `event-controller-todo-reminder.test.ts`,
  theme bootstrap (`beforeAll(async () => { await initTheme(); })`) from
  `compaction-vacuum.test.ts`.
- Regression: existing `compaction-vacuum.test.ts` (widget contracts) and the
  two existing event-controller test files must pass unmodified.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun --cwd=packages/coding-agent run check` exits 0
- [ ] `bun test packages/coding-agent/test/event-controller-compaction-vacuum.test.ts` exits 0 (2 tests)
- [ ] `bun test packages/coding-agent/test/compaction-vacuum.test.ts` exits 0, file unmodified (`git status`)
- [ ] `grep -n "compactionVacuum?.dispose()" packages/coding-agent/src/modes/controllers/event-controller.ts` shows a hit inside `#handleAutoCompactionStart` (in addition to the existing hits at ~214 and ~341)
- [ ] `grep -n "catch" packages/coding-agent/src/modes/controllers/event-controller.ts` shows the new guard within `#handleAutoCompactionStart`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if the index exists and you own the update)

## STOP conditions

Stop and report back (do not improvise) if:

- The `#handleAutoCompactionStart` / end-handler code doesn't match the
  "Current state" excerpts (drift since `e7466a84f`).
- Test 1's precondition assert (`children[0].animating === true` after the
  FIRST start) fails even with the env forcing — the motion gate is being
  forced off by something not covered here (report `process.stdout.isTTY`,
  `Bun.env.CI/NO_COLOR/TERM` as observed in the test) rather than a bug in
  the fix.
- You find evidence that overlapping `auto_compaction_start` events are a
  SUPPORTED visual (e.g. a comment or test asserting two concurrent status
  children) — disposing the prior one would then change intended behavior.
- The plain `autoCompactionLoader` fallback path has been removed from the
  start handler — the catch would have nothing to fall back to.
- The fix appears to require changing `Container.clear()` semantics or any
  out-of-scope file.
- A fix attempt fails verification twice.

## Maintenance notes

- If compaction events ever gain a correlation id (start/end pairing), the
  overwrite guard in Step 1 can become an assert-and-log instead — until
  then, last-start-wins with eager dispose is the correct policy.
- Reviewers should scrutinize: the Step 1 teardown must be UNCONDITIONAL
  (before tier resolution), and the Step 2 catch must not swallow throws from
  the loader path (the loader construction stays OUTSIDE the try).
- The end handler's `statusContainer.clear()`-after-`dispose()` ordering is
  already correct; nothing in this plan changes end-side behavior.
- Deferred (deliberately): moving the whole vacuum wiring behind the
  extension runner's isolation would unify it with the other 16 animations,
  but compaction UX is core-path today — revisit only if the vacuum grows
  beyond one widget.
- Related plans: Plan 001 adds a kit-level frame boundary (protects frames
  after mount); this plan protects mount/re-entry in the one core-path
  consumer. Both are needed; no ordering constraint.
