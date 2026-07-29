# Plan 005: Make animated-widget teardown structural on session switch and shutdown

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e7466a84f..HEAD -- "packages/coding-agent/src/*/index.ts" "packages/coding-agent/src/*/controller.ts" packages/coding-agent/src/extensibility/extensions packages/coding-agent/src/modes/controllers/extension-ui-controller.ts packages/context-weather/src/extension.ts packages/coding-agent/test/wave2-gallery.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 004 intentionally rewrites the
> controllers — after 004 lands, expect the `#mountWidget` shape to differ from
> the excerpts here (shared handle instead of private host); the lifecycle gaps
> this plan fixes are unchanged by that.

## Status

- **Priority**: P2
- **Effort**: L (EPIC-sized: 16 feature registrations + a new lifecycle test + an async-race fix)
- **Risk**: HIGH
- **Depends on**: plans/004-shared-family-clock.md
- **Category**: bug
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

Controller lifetime and widget lifetime disagree. On session switch the UI
disposes and drops every extension widget, but no feature controller is told:
only 2/16 features register `session_shutdown`, and 0/16 register
`session_switch`. A controller whose private `#mount` still says "animated"
believes a live widget exists; features that remount only when `#mount` is
absent (e.g. Tool Constellation) go permanently blank for the rest of the
process after one switch. Context-weather shows the async variant: the
extension runner's handler timeout does not cancel the handler, so abandoned
mount work can install a widget AFTER shutdown. The gallery test calls each
disposer by hand, proving disposers work when called — not that anything calls
them. This plan makes teardown structural (one shared registration helper) and
adds a test that drives the REAL event path.

## Current state

### The UI drops widgets without telling controllers

`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:247-258`
(the `switchSession` action clears widgets, then the session emits
`session_switch`):

```ts
			switchSession: async sessionPath => {
				this.clearHookWidgets();
				const result = await this.ctx.session.switchSession(sessionPath);
				...
			},
```

`clearHookWidgets` (`extension-ui-controller.ts:853-863`) disposes the widget
Components and clears the maps — it has no reference to any controller:

```ts
	clearHookWidgets(): void {
		for (const widget of this.#hookWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.#hookWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.#hookWidgetsAbove.clear();
		this.#hookWidgetsBelow.clear();
		this.#rebuildHookWidgets();
	}
```

`session_switch` is a real extension event (`extensibility/extensions/types.ts:1030`),
emitted from `packages/coding-agent/src/session/agent-session.ts:8675,8751,14602`.
`session_shutdown` is emitted through the teardown path
(`packages/coding-agent/src/modes/session-teardown.ts:30`).

### Who actually registers teardown today (verified by grep at `e7466a84f`)

- `session_shutdown` in feature indices: ONLY
  `packages/coding-agent/src/agent-fleet/index.ts:45` and
  `packages/coding-agent/src/prompt-charge/index.ts:48`. The other 14: nothing.
- `session_switch` in feature indices: NONE (0/16). The only `src` listener is
  core `packages/coding-agent/src/autoresearch/index.ts:249`.
- Context-weather (separate package) DOES register both
  (`packages/context-weather/src/extension.ts:208-216`) — its problem is the
  async race below, not missing registration.

Representative controller state machine —
`packages/coding-agent/src/tool-constellation/controller.ts:80-92`: remount
happens only when `#mount` is absent, and animated mode relies on the host tick
to repaint:

```ts
	onToolCall(event: ToolCallEvent, ctx: ToolConstellationContext): void {
		if (!ctx.hasUI) return;
		this.#state.recordFire(event.toolName, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationTally(...)], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}
```

So after a switch: widget disposed by `clearHookWidgets`, `#mount` still
`{ mode: "animated" }`, every later `tool_call` mutates state into a void.
Every controller's `dispose()` is already idempotent and clears `#mount`
(`tool-constellation/controller.ts:95-100`):

```ts
	dispose(ctx: Pick<ToolConstellationContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}
```

(Note after plan 004: the `host.dispose()` call is gated on an `owned` flag —
shared hosts are never disposed by features. The `#mount = undefined` +
`setWidget(undefined)` contract is what this plan relies on.)

### The registration shape to extend

`packages/coding-agent/src/prompt-charge/index.ts:45-49` (the most complete
example today — mounts on `session_start`, tears down on shutdown, but NOT on
switch):

```ts
export const createPromptChargeExtension: ExtensionFactory = api => {
	const controller = new PromptChargeController();
	api.on("session_start", (_event, ctx) => controller.mount(toPromptChargeContext(ctx)));
	api.on("input", (event, ctx) => controller.onInput(event, toPromptChargeContext(ctx)));
	api.on("session_shutdown", (_event, ctx) => controller.dispose(toPromptChargeContext(ctx)));
};
```

All 16 factories are registered inline in `packages/coding-agent/src/sdk.ts:1842-1859`.

### The context-weather async race

The runner's timeout abandons — but does not cancel — a slow handler
(`packages/coding-agent/src/extensibility/extensions/runner.ts:113-125`):

```ts
async function raceHandlerWithTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
): Promise<T | typeof EXTENSION_HANDLER_TIMEOUT> {
	const { promise: timeoutPromise, resolve: resolveTimeout } =
		Promise.withResolvers<typeof EXTENSION_HANDLER_TIMEOUT>();
	const timer = setTimeout(() => resolveTimeout(EXTENSION_HANDLER_TIMEOUT), timeoutMs);
	try {
		return await Promise.race([work, timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}
```

(used by `#runHandlerWithTimeout`, `runner.ts:576-611`). Context-weather's
`mount` awaits settings I/O and then installs the widget
(`packages/context-weather/src/extension.ts:103-140`, abbreviated):

```ts
	const mount = async (ctx: ExtensionContext, preloaded?: ContextWeatherSettings): Promise<void> => {
		if (!ctx.hasUI || mounted) return;
		const settings = preloaded ?? (await loadSettings(ctx));
		if (mounted) return;
		...
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => { ... mounted = { ... }; return widget; }, ...);
	};
```

If `session_shutdown`'s `unmount` (`:142-149`) runs while `mount` is parked on
the `await`, the `mounted` re-check passes (`mounted` is `undefined`) and
`setWidget` installs a widget into a dead session. The re-check guards
double-mount, not post-teardown mount.

### The test that proves the wrong thing

`packages/coding-agent/test/wave2-gallery.test.ts:488-494`:

```ts
	test("disposing all 15 controllers in sdk.ts's registration order never throws (full session_shutdown cascade)", () => {
		const { disposers } = mountGallery();
		expect(disposers.map(d => d.feature)).toEqual(REGISTRATION_ORDER);
		for (const { dispose } of disposers) {
			expect(() => dispose()).not.toThrow();
		}
	});
```

It calls the disposers directly (and covers 15 features — retry-radar is not in
the gallery). Nothing anywhere dispatches `session_switch`/`session_shutdown`
through the real `api.on` registrations for these features.

### Conventions

Bun; `logger` from `@oh-my-pi/pi-utils`, never `console`; ES `#private`;
behavioral tests only; render/state pure of wall-clock. Fake-context test
patterns: `wave2-gallery.test.ts:270-330` (`mountGallery`'s per-feature ctx
objects).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck+lint coding-agent | `bun --cwd=packages/coding-agent run check` | exit 0 |
| Typecheck+lint context-weather | `bun --cwd=packages/context-weather run check` | exit 0 |
| All workspaces | `bun run --workspaces --if-present check` | exit 0 |
| One test file | `bun test packages/coding-agent/test/wave2-lifecycle.test.ts` | all pass |
| Repo lint | `bun run check:tools` | exit 0 (ignore the untracked scratch `packages/coding-agent/scripts/wave2-live-demo.ts`) |

## Scope

**In scope** (the only files you should modify):
- `packages/coding-agent/src/extensibility/extensions/animated-feature.ts` (create)
- The 16 `packages/coding-agent/src/<feature>/index.ts` for: agent-fleet, breathing-border, cadence-equalizer, context-constellation, cost-candle, diff-bloom, goal-horizon, memory-crystals, model-weather-vane, prompt-charge, reflection-ripple, retry-radar, session-bonsai, todo-meteors, token-tide, tool-constellation
- `packages/context-weather/src/extension.ts` + `packages/context-weather/test/extension.test.ts`
- `packages/coding-agent/test/wave2-lifecycle.test.ts` (create)
- `packages/coding-agent/test/wave2-gallery.test.ts` (only if an assertion needs the helper's wiring; prefer leaving it untouched)

**Out of scope** (do NOT touch, even though they look related):
- `packages/coding-agent/src/extensibility/extensions/runner.ts` — making the
  timeout actually cancel handlers is a deep change to extension semantics;
  the generation token makes context-weather safe without it. If you believe
  the runner must change, STOP and report instead.
- The controllers' `#mountWidget`/host code — plan 004's territory.
- `extension-ui-controller.ts` `clearHookWidgets` — the UI-side disposal is
  correct and stays; this plan adds the controller-side signal, it does not
  move the UI-side one.
- Core `autoresearch` — its `session_switch` rehydrate is separate machinery.

## Git workflow

- Branch: `advisor/005-lifecycle-teardown-contract`
- Conventional Commits, one commit per step batch (e.g.
  `fix(animations): register structural teardown for tool-constellation, token-tide`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the shared registration helper

Create `packages/coding-agent/src/extensibility/extensions/animated-feature.ts`:

```ts
import type { ExtensionContext } from "./index";

/** The controller surface the lifecycle helper drives. */
interface AnimatedFeatureLifecycle<C> {
	/** Adapt the raw extension context to the feature's own context shape. */
	toContext(ctx: ExtensionContext): C;
	/** Tear down the live mount (idempotent; clears the feature's #mount). */
	dispose(ctx: C): void;
	/** Optional: remount immediately after a session switch (features that mount unconditionally, e.g. Prompt Charge). */
	remountOnSwitch?(ctx: C): void;
}

/**
 * Structural teardown for every animated feature: the UI disposes widgets on
 * session switch/shutdown (extension-ui-controller.clearHookWidgets), so the
 * controller must drop its #mount at the same boundaries or it will believe a
 * dead widget is still live and never remount.
 */
export function registerAnimatedFeatureLifecycle<C>(
	api: { on(event: "session_switch" | "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void): void },
	lifecycle: AnimatedFeatureLifecycle<C>,
): void {
	api.on("session_switch", (_event, ctx) => {
		const featureCtx = lifecycle.toContext(ctx);
		lifecycle.dispose(featureCtx);
		lifecycle.remountOnSwitch?.(featureCtx);
	});
	api.on("session_shutdown", (_event, ctx) => {
		lifecycle.dispose(lifecycle.toContext(ctx));
	});
}
```

Match the real `ExtensionAPI`/`ExtensionHandler` typing from
`extensibility/extensions/types.ts:1030` region instead of the loose `api`
shape above if the concrete type is importable without a cycle (it is — the
indices already import `ExtensionFactory` from `../extensibility/extensions`).
The structural type above is the fallback, not the preference.

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0

### Step 2 (repeat ×4 batches of 4): Wire all 16 features through the helper

For each feature `index.ts` (same batching discipline as plan 004 — ≤5 files
per batch, commit per batch):

```ts
export const createToolConstellationExtension: ExtensionFactory = api => {
	const controller = new ToolConstellationController();
	api.on("tool_call", (event, ctx) => {
		controller.onToolCall(event, toConstellationContext(ctx));
	});
	registerAnimatedFeatureLifecycle(api, {
		toContext: toConstellationContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
```

Feature-specific notes:
- `prompt-charge/index.ts`: pass
  `remountOnSwitch: ctx => controller.mount(ctx)` — it mounts unconditionally
  on `session_start` (`prompt-charge/index.ts:47`) and a switched-to session
  gets no fresh `session_start`, so without remount the caret widget would stay
  gone until the next submit. Remove the existing manual
  `api.on("session_shutdown", ...)` line (`:48`) — the helper now owns it.
- `agent-fleet/index.ts`: remove the manual `session_shutdown` line (`:45`);
  keep the `session_start` watch line. `AgentFleetController.dispose` also
  unsubscribes its registry watch — confirm by reading the controller before
  assuming; if `dispose` does not stop the registry subscription, STOP (the
  helper would leak a watcher per switch).
- All other 14: `dispose` only; their mounts are lazy (next data event
  remounts).
- Verify each controller's `dispose(ctx)` signature accepts the full feature
  context (they take `Pick<...Context, "setWidget">`, so passing the full
  context typechecks).

Batches: (1) tool-constellation, token-tide, session-bonsai, todo-meteors;
(2) breathing-border, agent-fleet, cost-candle, reflection-ripple;
(3) memory-crystals, context-constellation, diff-bloom, cadence-equalizer;
(4) goal-horizon, model-weather-vane, prompt-charge, retry-radar.

**Verify** (per batch): `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/<the-4-feature-tests>` → exit 0, all pass

### Step 3: The real-path lifecycle test

Create `packages/coding-agent/test/wave2-lifecycle.test.ts`. Structure:

1. A `FakeExtensionApi` that records handlers:
   `on(event, handler)` → `handlers.get(event).push(handler)`, plus
   `emit(event, ctx)` that invokes them in registration order. Type it against
   the same structural surface the helper uses.
2. A fake `ExtensionContext` good enough for the 16 `to<Feature>Context`
   adapters: `hasUI: true`, `ui: { theme, setWidget: spy, animation: () => handle-or-undefined, getEditorText: () => "" }`,
   `sessionManager: fixedSessionSource(...)` for session-bonsai — copy the
   fake-context construction from `wave2-gallery.test.ts:270-330` but at the
   `ExtensionContext` level (the adapters read `ctx.hasUI`, `ctx.ui.theme`,
   `ctx.ui.setWidget`, and for some features `ctx.ui.getEditorText` /
   `ctx.sessionManager`). Read each adapter you wire before finalizing the
   fake; add only the fields the adapters actually touch.
3. Behavioral cases (one `describe` per case, all features driven through the
   REAL factories `create<Feature>Extension(api)`):
   - **switch tears down**: drive each feature's representative "active" event
     (same events the gallery uses) so it mounts; `emit("session_switch")`;
     assert the LAST `setWidget` call per feature key has `content === undefined`.
   - **switch then remount**: after the switch, drive the representative event
     again; assert a new `setWidget` call with defined content (this is the
     regression the plan exists for — it fails on the pre-plan code).
   - **shutdown tears down**: mount, `emit("session_shutdown")`, same
     undefined-content assertion.
   - **double dispose is safe**: `emit("session_switch")` twice back-to-back →
     no throw.
   - **prompt-charge remounts immediately on switch** (no event needed):
     after `emit("session_switch")`, assert a defined-content `setWidget` for
     key `prompt-charge` without driving `input`.

**Verify**: `bun test packages/coding-agent/test/wave2-lifecycle.test.ts` → all pass; then `git stash` the Step-2 index changes and re-run → the "switch then remount" case FAILS (proves the test drives the real path); `git stash pop`

### Step 4: Fix the context-weather post-teardown mount race

`packages/context-weather/src/extension.ts` — add a mount-generation token:

```ts
		let mounted: MountedWidget | undefined;
		let mountGeneration = 0;
		...
		const mount = async (ctx: ExtensionContext, preloaded?: ContextWeatherSettings): Promise<void> => {
			if (!ctx.hasUI || mounted) return;
			const generation = mountGeneration;
			const settings = preloaded ?? (await loadSettings(ctx));
			if (mounted || generation !== mountGeneration) return;
			...
		};

		const unmount = (ctx: ExtensionContext): void => {
			mountGeneration++;
			...
		};
```

A mount that resumes after its generation was torn down discards itself instead
of installing a widget into a dead session. Also increment the generation in
the `session_switch` handler before the re-mount (`extension.ts:208-212`) —
the `unmount` call there already does it with the shape above.

Add a behavioral test in `packages/context-weather/test/extension.test.ts`:
make the injected `readPluginSettings` seam
(`ContextWeatherExtensionOptions.readPluginSettings`, `extension.ts:48`) return
a promise you resolve manually; emit `session_start`, then `session_shutdown`
while the settings promise is pending, then resolve it; assert no
`setWidget` with defined content lands after the shutdown. Model the harness on
the existing tests in that file.

**Verify**: `bun --cwd=packages/context-weather run check && bun test packages/context-weather/test/extension.test.ts` → exit 0, all pass (including the new race test)

### Step 5: Full sweep

**Verify**: `bun run --workspaces --if-present check` → exit 0; `bun test packages/coding-agent/test/wave2-lifecycle.test.ts packages/coding-agent/test/wave2-gallery.test.ts` → all pass

## Test plan

- New `packages/coding-agent/test/wave2-lifecycle.test.ts` (Step 3): the five
  behavioral cases listed there, driven through the real
  `create<Feature>Extension` factories and a recording fake api — never by
  calling `controller.dispose` directly.
- New context-weather race test (Step 4): shutdown-during-pending-mount
  installs nothing.
- Existing suites as regression gates: all 16 feature tests +
  `wave2-gallery.test.ts` unchanged and passing.
- Structural pattern references: fake contexts from
  `wave2-gallery.test.ts:270-330`; context-weather seams from
  `packages/context-weather/test/extension.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run --workspaces --if-present check` exits 0
- [ ] `bun test packages/coding-agent/test/wave2-lifecycle.test.ts packages/coding-agent/test/wave2-gallery.test.ts packages/context-weather/test/extension.test.ts` exits 0
- [ ] `grep -rln "registerAnimatedFeatureLifecycle" packages/coding-agent/src --include="index.ts" | wc -l` → 16
- [ ] `grep -rn 'api.on("session_shutdown"' packages/coding-agent/src/agent-fleet/index.ts packages/coding-agent/src/prompt-charge/index.ts` → no matches (manual lines replaced by the helper)
- [ ] `grep -n "mountGeneration" packages/context-weather/src/extension.ts` → matches present
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts and
  the mismatch is not plan 004's documented controller rewrite.
- Any controller's `dispose()` turns out NOT to be idempotent, or not to clear
  its `#mount` (structural teardown would then double-dispose or wedge — fix
  belongs in that controller and must be reported, not improvised).
- `AgentFleetController.dispose` does not stop its registry watch (Step 2 note).
- You find a feature whose state must legitimately survive `session_switch`
  (teardown would lose real user-visible data, not just animation state) —
  report which feature and why before wiring it.
- The Step 3 stash-check does NOT fail on pre-plan code (the test would be
  proving nothing — rework the fake before proceeding).
- Fixing the race appears to require changing
  `runner.ts`'s timeout semantics (out of scope by design).

## Maintenance notes

- Any NEW animated feature must call `registerAnimatedFeatureLifecycle` — add
  that sentence to the feature-authoring notes the first time someone writes
  plan-less feature 17. The lifecycle test enumerates the factories explicitly;
  a new feature must be added there too (consider asserting the count against
  `sdk.ts`'s inline registration list).
- Plan 006 extends this helper with a `display.animations`-change subscription
  (dispose + remount on toggle) — keep the helper's surface minimal until then.
- Reviewer focus: handler registration ORDER (the helper registers switch
  before shutdown; the UI clears widgets before the session emits
  `session_switch`, so `dispose` mostly no-ops on the widget and matters for
  `#mount` — confirm no feature's `dispose` assumes the widget is still
  installed); the prompt-charge immediate-remount path.
- Deferred: making `raceHandlerWithTimeout` cancel abandoned handlers
  (AbortSignal plumb-through) — the generation token removes the user-visible
  symptom; the structural fix is a separate, riskier change. File a bead if it
  recurs elsewhere.
