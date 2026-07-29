# Plan 004: Make the animation family share one clock and one policy per session

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e7466a84f..HEAD -- packages/animation/src packages/animation/test packages/coding-agent/src/modes packages/coding-agent/src/extensibility/extensions/types.ts packages/context-weather/src "packages/coding-agent/src/*/controller.ts" "packages/coding-agent/src/*/index.ts"`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L (this is an EPIC-sized refactor: ~40 files over many small phases)
- **Risk**: HIGH
- **Depends on**: plans/001-animation-error-boundary.md
- **Category**: tech-debt
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

The `@oh-my-pi/pi-animation` README promises the plugin family shares **one**
timer, **one** cadence policy, and **one** cleanup path. Reality: each of the 16
animated built-in features, plus the context-weather plugin, plus the core
compaction path, constructs its OWN `MotionPolicy` + `AnimationHost` +
deferred-backpressure adapter — up to ~18 independent 30fps `setInterval` clocks
per interactive session. Per-tick feature work runs before TUI render
coalescing, so aggregate event-loop cost scales with the number of enabled
animations, and independent timers can align into bursts. The copy-paste has
already compounded once: commit `e7466a84f` changed 22 files (+594/−138) to
backport ONE backpressure fix into all 16 controllers. After this plan, all
animated widgets in an interactive session subscribe to one session-owned
host/policy, and a future kit fix lands in one file.

## Current state

### The promise vs. the reality

`packages/animation/README.md:5-10`:

```
This package owns the primitives that every animated plugin reuses, so the whole
family shares **one** timer, **one** cadence policy, and **one** cleanup path:

- **`AnimationHost`** — a single coalesced frame clock. Any number of subscribers
  share one underlying timer ...
```

Each `AnimationHost` instance owns one interval
(`packages/animation/src/animation-host.ts:17-23`):

```ts
export const DEFAULT_FRAME_SCHEDULER: FrameScheduler = {
	now: () => performance.now(),
	start(intervalMs, tick) {
		const id = setInterval(tick, intervalMs);
		return () => clearInterval(id);
	},
};
```

The host already supports N subscribers on one timer (`subscribe()` at
`animation-host.ts:79-87`, timer reconcile in `#sync()` at `:100-118`). The
problem is purely that 18 call sites each construct their own host.

### The 16 duplicated constructions

Every feature controller constructs its own policy + host inside
`#mountWidget`. Representative excerpt,
`packages/coding-agent/src/tool-constellation/controller.ts:102-121`:

```ts
	#mountWidget(ctx: ToolConstellationContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderConstellationTally(this.#state.categoryCounts(), ctx.theme)], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new ToolConstellationWidget({ tui, host, policy, state, theme, clock });
			},
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}
```

The same shape exists in all 16 controllers (verified constructions):
`agent-fleet/controller.ts:128,135`, `breathing-border/controller.ts:116,123`,
`cadence-equalizer/controller.ts:161,168`,
`context-constellation/controller.ts:134,141`, `cost-candle/controller.ts:114,121`,
`diff-bloom/controller.ts:123,130`, `goal-horizon/controller.ts:102,109`,
`memory-crystals/controller.ts:118,125`, `model-weather-vane/controller.ts:119,126`,
`prompt-charge/controller.ts:118,125`, `reflection-ripple/controller.ts:104,111`,
`retry-radar/controller.ts:114,122`, `session-bonsai/controller.ts:131,138`,
`todo-meteors/controller.ts:145,152`, `token-tide/controller.ts:160,167`,
`tool-constellation/controller.ts:103,110`.

Each controller file also carries a byte-identical `deferredBackpressure()`
helper (16/16, e.g. `tool-constellation/controller.ts:37-49`,
`prompt-charge/controller.ts:40-52`):

```ts
function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: Pick<TUI, "renderUnderPressure">): void } {
	let live: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return live?.underPressure ?? false;
			},
		},
		attach(tui) {
			live = backpressureFromTui(tui);
		},
	};
}
```

This adapter exists ONLY because the host is constructed before the widget
factory supplies the real `tui`. A session-owned service constructed with the
real TUI does not need it at all.

### The context adapter (per-feature `index.ts`)

Each feature's `index.ts` adapts `ExtensionContext` for its controller, e.g.
`packages/coding-agent/src/tool-constellation/index.ts:12-27`:

```ts
function readMotionSetting(): MotionSetting {
	if (!isSettingsInitialized()) return "full";
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toConstellationContext(ctx: ExtensionContext): ToolConstellationContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}
```

(`readMotionSetting` is duplicated 16/16 — plan 006 owns its consolidation, but
this plan makes the copies dead; see the cross-plan note in Maintenance.)

### The two core constructions

Core compaction path, `packages/coding-agent/src/modes/controllers/event-controller.ts:232-245`
(the ONLY site that already does lazy-shared-caching plus live setting re-sync
— this is the pattern the new service generalizes):

```ts
	#ensureAnimation(): { host: AnimationHost; policy: MotionPolicy } {
		if (!this.#animationHost || !this.#motionPolicy) {
			const backpressure = backpressureFromTui(this.ctx.ui);
			this.#motionPolicy = new MotionPolicy(
				{ hasUI: true, isTTY: process.stdout.isTTY === true, backpressure },
				this.ctx.settings.get("display.animations"),
			);
			this.#animationHost = new AnimationHost({ policy: this.#motionPolicy, backpressure });
		} else {
			this.#motionPolicy.setSetting(this.ctx.settings.get("display.animations"));
			this.#motionPolicy.refresh();
		}
		return { host: this.#animationHost, policy: this.#motionPolicy };
	}
```

Context-weather plugin, `packages/context-weather/src/extension.ts:110-126`
(constructs its own policy/host inside the widget factory; governed by a
package-local `animations` setting, default `"off"` —
`packages/context-weather/src/settings.ts:21`):

```ts
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: TUI, theme: Theme) => {
				const backpressure = backpressureFromTui(tui);
				const policy = new MotionPolicy(motionEnvironment(tui), settings.animations);
				const host = new AnimationHost({ policy, backpressure, scheduler: options.scheduler });
				const widget = new ContextWeatherWidget({ ... });
```

### Where a shared service can live

- Both `EventController` and `ExtensionUIController` hold the same
  `InteractiveModeContext` (`packages/coding-agent/src/modes/types.ts:94-134`;
  field `ui: TUI` at `:96`). One `TUI` exists per interactive session, so a
  module-level `WeakMap<TUI, SessionAnimation>` gives exactly one service per
  session without changing how `InteractiveModeContext` is constructed.
- Extensions reach the UI through `ExtensionUIContext`
  (`packages/coding-agent/src/extensibility/extensions/types.ts:175-211`,
  `setWidget` at `:202`). The interactive implementation is the object literal
  in `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:63-102`
  (`setWidget: (key, content, options) => this.setHookWidget(...)` at `:71`).
  Non-interactive modes use `noOpUIContext`
  (`extensibility/extensions/runner.ts:259,303`).
- Widget factory type: `ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent`
  (`types.ts:163`).

### Conventions that apply

- Runtime is Bun; logging via `logger` from `@oh-my-pi/pi-utils`, never
  `console`. ES `#private` fields. Star-barrel `index.ts` re-exports
  (`packages/animation/src/index.ts`). Behavioral tests only; render/state stay
  pure of wall-clock — inject `elapsedMs`/`FrameScheduler`. The deterministic
  test scheduler pattern to copy is `FakeScheduler` in
  `packages/animation/test/animation-kit.test.ts:19-45` (exposes `startCount`,
  `activeTimers`, `advance`).
- The gallery test (`packages/coding-agent/test/wave2-gallery.test.ts`) mounts
  15 controllers with `motionSetting: "off"` so every widget renders static
  `string[]` — it never constructs hosts, so it stays green through migration.
  (retry-radar is not in the gallery; it has its own
  `packages/coding-agent/test/retry-radar.test.ts`.)

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck+lint one pkg | `bun --cwd=packages/animation run check` | exit 0 |
| Typecheck+lint coding-agent | `bun --cwd=packages/coding-agent run check` | exit 0 |
| Typecheck+lint context-weather | `bun --cwd=packages/context-weather run check` | exit 0 |
| All workspaces | `bun run --workspaces --if-present check` | exit 0 |
| One test file | `bun test packages/animation/test/animation-kit.test.ts` | all pass |
| Feature test | `bun test packages/coding-agent/test/<feature>.test.ts` | all pass |
| Gallery test | `bun test packages/coding-agent/test/wave2-gallery.test.ts` | all pass |
| Repo lint | `bun run check:tools` | exit 0 (the untracked scratch file `packages/coding-agent/scripts/wave2-live-demo.ts` is not yours; ignore findings there) |

## Suggested executor toolkit

- If the `ast-grep` skill is available, use it for the mechanical 16-controller
  sweep (matching the `deferredBackpressure` function and the
  `new MotionPolicy(...)` construction shape) instead of hand-editing; verify
  each rewrite with the per-feature test.

## Scope

**In scope** (the only files you should modify):
- `packages/animation/src/animation-host.ts`, `packages/animation/src/animated-widget.ts`
- `packages/animation/test/animation-kit.test.ts`
- `packages/coding-agent/src/modes/session-animation.ts` (create)
- `packages/coding-agent/test/session-animation.test.ts` (create)
- `packages/coding-agent/src/extensibility/extensions/types.ts` (add one optional member)
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`
- `packages/coding-agent/src/modes/controllers/event-controller.ts`
- The 16 feature pairs `packages/coding-agent/src/<feature>/{controller.ts,index.ts}` for feature in: agent-fleet, breathing-border, cadence-equalizer, context-constellation, cost-candle, diff-bloom, goal-horizon, memory-crystals, model-weather-vane, prompt-charge, reflection-ripple, retry-radar, session-bonsai, todo-meteors, token-tide, tool-constellation
- Their 16 test files `packages/coding-agent/test/<feature>.test.ts` plus `packages/coding-agent/test/wave2-gallery.test.ts` (only as needed in the cleanup phase)
- `packages/context-weather/src/extension.ts` + `packages/context-weather/test/extension.test.ts` (final, decision-gated phase)

**Out of scope** (do NOT touch, even though they look related):
- `packages/animation/src/motion-policy.ts` — plan 006 owns `setSetting`/refresh semantics; do not change its behavior here.
- The 16 `readMotionSetting()` copies' replacement with a single function — plan 006. (You may DELETE a copy in the cleanup phase once nothing references it; do not build the shared replacement.)
- `session_switch`/`session_shutdown` registration — plan 005.
- Any per-frame feature-work optimization (editor length, spinner caps, bonsai pruning) — plan 007.
- `packages/tui/src/**` — the render loop and backpressure surface stay as-is.

## Git workflow

- Branch: `advisor/004-shared-family-clock`
- Conventional Commits, one commit per phase (repo example from `git log`:
  `fix(animations): backport backpressure-recovery fix to all 16 controllers`).
  Use `refactor(animations): ...` for these.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Kit — per-subscriber cadence on `AnimationHost`

In `packages/animation/src/animation-host.ts`, extend `subscribe` with an
optional per-subscriber cadence so ONE timer can serve listeners whose policies
resolve to different tiers (needed later for context-weather, harmless for
everyone else):

- Signature: `subscribe(listener: FrameListener, options?: { cadenceMs?: () => number }): () => void`.
- Store the option with the listener (switch `#listeners` from
  `Set<FrameListener>` to `Map<FrameListener, { cadenceMs?: () => number; lastEmitAt?: number }>`).
- In `#tick()` (currently `:127-138`), after the backpressure gate, deliver to a
  listener only when it has no `cadenceMs`, or when
  `elapsedMs - (entry.lastEmitAt ?? -Infinity) >= entry.cadenceMs()` (then stamp
  `lastEmitAt = elapsedMs`). A cadence of `0` means "never deliver" (mirrors
  `TIER_CADENCE_MS.off`).
- The shared timer keeps running at the HOST policy's cadence exactly as today
  (`#sync()` unchanged). Default behavior with no options is byte-identical.

In `packages/animation/src/animated-widget.ts`, pass the widget's own policy
cadence: in `#subscribeToHost()` (currently `:125-127`) change to
`this.#host.subscribe((_frame, elapsedMs) => this.#handleFrame(elapsedMs), { cadenceMs: () => this.#policy.cadenceMs })`.
For widgets whose policy IS the host policy this filter is a no-op (elapsed
between host ticks always ≥ the same cadence).

Add behavioral tests in `packages/animation/test/animation-kit.test.ts` using
the existing `FakeScheduler`:
1. Two subscribers, one host: `startCount === 1`, `activeTimers === 1`, both
   receive frames (this may already exist — extend, do not duplicate).
2. Host at full cadence (33.3ms), one subscriber with `cadenceMs: () => 1000/12`:
   advancing 1000ms delivers ~30 frames to the unfiltered listener and ~12 to
   the filtered one.
3. Filtered subscriber with cadence `0` receives nothing while the other still
   receives frames.

**Verify**: `bun --cwd=packages/animation run check && bun test packages/animation/test/animation-kit.test.ts` → exit 0, all pass (including 2+ new tests)

### Step 2: Add the session-owned service

Create `packages/coding-agent/src/modes/session-animation.ts`:

```ts
import { AnimationHost, backpressureFromTui, type FrameScheduler, MotionPolicy, type MotionSetting } from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import { isSettingsInitialized, settings } from "../config/settings";

/** The one host/policy pair every animated widget in a session shares. */
export interface SessionAnimationHandle {
	readonly host: AnimationHost;
	readonly policy: MotionPolicy;
}
```

- `function readDisplayAnimations(): MotionSetting` — same body as the 16
  `readMotionSetting` copies (guard `isSettingsInitialized()`, default
  `"full"`, validate the enum). This is a private function here; plan 006
  decides its public home.
- `export function sessionAnimation(tui: TUI, scheduler?: FrameScheduler): SessionAnimationHandle`
  — module-level `WeakMap<TUI, SessionAnimationHandle & { dispose(): void }>`.
  On miss: build `backpressureFromTui(tui)`, then
  `new MotionPolicy({ hasUI: true, isTTY: process.stdout.isTTY === true, backpressure }, readDisplayAnimations())`,
  then `new AnimationHost({ policy, backpressure, scheduler })`, cache, return.
  On hit: re-sync exactly like `#ensureAnimation` does
  (`policy.setSetting(readDisplayAnimations()); policy.refresh();`) and return
  the cached handle. This copies the proven pattern at
  `event-controller.ts:232-245`.
- `export function disposeSessionAnimation(tui: TUI): void` — dispose host,
  delete the WeakMap entry. Idempotent.

Add `packages/coding-agent/test/session-animation.test.ts` (behavioral):
1. Same `tui` object twice → same `host` instance (`===`).
2. Two different `tui` objects → different hosts.
3. `disposeSessionAnimation` then `sessionAnimation` → a fresh host; double
   dispose does not throw.
4. With a `FakeScheduler` (copy the pattern from
   `packages/animation/test/animation-kit.test.ts:19-45`): two subscribers on
   the shared host → `startCount === 1`.
   Use a fake `tui` object exposing only `renderUnderPressure: false`; pass an
   env-forcing settings state via `resetSettingsForTest()`/uninitalized settings
   (uninitialized → `"full"` default) and set `env` gates off by constructing in
   a TTY-true fake — if `process.stdout.isTTY` is false under `bun test`, the
   policy resolves `off` and the host never starts; in that case assert tier
   `off` behavior instead, or restructure `sessionAnimation` to accept an
   optional `{ isTTY?: boolean }` test seam. Prefer the test seam; keep it a
   plain optional parameter.

**Verify**: `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/session-animation.test.ts` → exit 0, all pass

### Step 3: Expose the handle to extensions

- `packages/coding-agent/src/extensibility/extensions/types.ts`: add to
  `ExtensionUIContext` (near `setWidget` at `:202`):
  `/** Session-shared animation clock+policy; absent outside interactive mode. */`
  `animation?(): { host: unknown; policy: unknown } | undefined` — DO NOT use
  `unknown`: import the types. If importing `@oh-my-pi/pi-animation` types into
  this file creates no cycle (it should not; `coding-agent` already depends on
  the package), declare
  `animation?(): SessionAnimationHandleLike | undefined` with
  `import type { AnimationHost, MotionPolicy } from "@oh-my-pi/pi-animation"` and an inline
  `{ host: AnimationHost; policy: MotionPolicy }` shape.
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`: in
  the `uiContext` literal (`:63-102`) add
  `animation: () => sessionAnimation(this.ctx.ui),`.
- `noOpUIContext` (runner) needs no change — the member is optional.

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0

### Step 4 (repeat ×8): Migrate the 16 features in pairs — additive, no removals yet

Migration order (2 features per phase, 4 files per phase; commit each phase):
(1) tool-constellation + token-tide, (2) session-bonsai + todo-meteors,
(3) breathing-border + agent-fleet, (4) cost-candle + reflection-ripple,
(5) memory-crystals + context-constellation, (6) diff-bloom + cadence-equalizer,
(7) goal-horizon + model-weather-vane, (8) prompt-charge + retry-radar.

For each feature, apply the identical recipe:

1. `packages/coding-agent/src/<feature>/controller.ts`:
   - Add to the feature's `...Context` interface:
     `/** Session-shared clock+policy; when absent the widget renders static. */`
     `animation?: SessionAnimationHandle;` (import the type from
     `../modes/session-animation`).
   - In `#mountWidget`, branch FIRST on `ctx.animation`:
     ```ts
     const shared = ctx.animation;
     if (shared) {
         if (shared.policy.tier === "off") { /* existing static branch, unchanged */ }
         const { host, policy } = shared;
         // existing setWidget factory, but WITHOUT deferredBackpressure()
         // and WITHOUT backpressure.attach(tui) inside the factory
         ...
         return { mode: "animated", host };
     }
     // legacy path below stays byte-identical for now
     ```
   - IMPORTANT: in the shared branch, `dispose()` must NOT call
     `host.dispose()` — the host is session-owned. Change `Mount` to carry
     `owned: boolean` (legacy: true; shared: false) and only dispose when
     `owned`. Widget-level unsubscribe still happens via the widget's own
     `dispose()` through the UI layer.
2. `packages/coding-agent/src/<feature>/index.ts`: in `to<Feature>Context`,
   add `animation: ctx.ui.animation?.(),`.

The feature's existing test file passes unchanged (its fake contexts have no
`animation`, so the legacy path runs).

**Verify** (after EACH pair): `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/<featureA>.test.ts packages/coding-agent/test/<featureB>.test.ts packages/coding-agent/test/wave2-gallery.test.ts` → exit 0, all pass

### Step 5: Migrate the core compaction path

`packages/coding-agent/src/modes/controllers/event-controller.ts`:
- Replace the body of `#ensureAnimation()` (`:232-245`) with
  `return sessionAnimation(this.ctx.ui);` (keep the method as the seam; the
  service already re-syncs the setting on every call).
- In `dispose()` (`:208-224`), replace the `#animationHost?.dispose()` /
  `#motionPolicy = undefined` block with
  `disposeSessionAnimation(this.ctx.ui);` and delete the two private fields.

**Verify**: `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/wave2-gallery.test.ts` → exit 0, all pass

### Step 6 (repeat ×4 batches): Remove the legacy path

In 4 batches of 4 controllers (≤5 files per batch; run the 4 feature tests per
batch), delete from each controller:
- the `deferredBackpressure()` function,
- the legacy `new MotionPolicy(...)` / `new AnimationHost(...)` branch (make
  `ctx.animation` absent ⇒ static render, i.e. the `off` branch),
- now-unused context fields `isTTY` / `env` / `motionSetting` and their
  assignments in the feature's `index.ts` (delete the local
  `readMotionSetting()` copy once unreferenced),
- the now-unused imports.

Update each feature's test file in the same batch: tests that exercised the
animated path must now pass a real handle
(`{ host: new AnimationHost({ policy, scheduler: fakeScheduler }), policy: new MotionPolicy({ hasUI: true, isTTY: true, env: {} }, "full") }`)
as `ctx.animation`; tests that exercised static/off keep passing no handle.
`wave2-gallery.test.ts` mounts everything with `motionSetting: "off"` today —
switch its `base` context to simply omit `animation` (same static outcome) and
delete the `motionSetting` field.

**Verify** (per batch): `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/<the-4-feature-tests> packages/coding-agent/test/wave2-gallery.test.ts` → exit 0, all pass
**Verify** (after last batch): `grep -rln "function deferredBackpressure" packages/coding-agent/src` → no output; `grep -rn "new AnimationHost" packages/coding-agent/src --include="controller.ts"` → no output

### Step 7 (decision-gated): context-weather on the shared host

Read the STOP conditions first. `packages/context-weather/src/extension.ts`
keeps its OWN `MotionPolicy` (package-local `animations` setting, default
`"off"` — `settings.ts:21`) but shares the session host:

- In the widget factory (`extension.ts:112-126`), replace
  `new AnimationHost(...)` with the shared host: import
  `sessionAnimation` from `@oh-my-pi/pi-coding-agent/modes/session-animation`
  (deep-import precedent: `extension.ts:24` imports
  `@oh-my-pi/pi-coding-agent/extensibility/plugins/loader`) and use
  `sessionAnimation(tui).host`. Keep constructing the local policy; the
  `AnimatedWidget` base passes `cadenceMs: () => policy.cadenceMs` per Step 1,
  so a local `subtle` still renders at ~12fps even on a 30fps shared timer.
- `unmount` (`:142-149`) must NOT dispose the shared host — drop the
  `mounted.host.dispose()` call for the shared host (widget `dispose()` already
  unsubscribes); keep an `ownedHost` flag if the injectable
  `options.scheduler` test seam still constructs a private host for tests.
- Update `packages/context-weather/test/extension.test.ts` accordingly (tests
  may keep injecting a private host via the seam; that path stays supported).

Behavior caveat this step introduces (report it in your summary): when the
local setting resolves to a tier the shared `display.animations` policy is
BELOW (local `full`/`subtle` while global is `off`, or local `full` while
global `subtle`), the shared timer runs at the global cadence (or not at all),
so context-weather is capped by the global tier. If that combination must keep
today's behavior, STOP (see conditions) — plan 006 is where the two settings
get reconciled.

**Verify**: `bun --cwd=packages/context-weather run check && bun test packages/context-weather/test/extension.test.ts` → exit 0, all pass

### Step 8: Full sweep

**Verify**: `bun run --workspaces --if-present check` → exit 0; `bun test packages/animation/test packages/coding-agent/test/wave2-gallery.test.ts packages/coding-agent/test/session-animation.test.ts` → all pass

## Test plan

- `packages/animation/test/animation-kit.test.ts` — per-subscriber cadence:
  filtered ~12fps vs unfiltered ~30fps on one timer; cadence-0 starvation;
  N-subscribers-one-timer (extend existing).
- `packages/coding-agent/test/session-animation.test.ts` (new) — identity per
  TUI, fresh-after-dispose, idempotent dispose, single timer with two
  subscribers, setting re-sync on repeated access.
- All 16 `packages/coding-agent/test/<feature>.test.ts` — unchanged through
  Steps 4–5 (legacy path), updated in Step 6 to inject the shared handle for
  animated cases. Model the handle-injection on the existing per-feature
  animated tests' policy/host construction.
- `wave2-gallery.test.ts` — static gallery stays green at every phase.
- Verification command for the whole plan: Step 8's commands.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run --workspaces --if-present check` exits 0
- [ ] `bun test packages/animation/test packages/coding-agent/test/session-animation.test.ts packages/coding-agent/test/wave2-gallery.test.ts` exits 0
- [ ] `grep -rln "function deferredBackpressure" packages/coding-agent/src` → no matches
- [ ] `grep -rn "new AnimationHost" packages/coding-agent/src --include="controller.ts"` → no matches
- [ ] `grep -rn "new AnimationHost" packages/coding-agent/src/modes` → matches only in `session-animation.ts`
- [ ] All 16 feature test files pass: `bun test packages/coding-agent/test/{agent-fleet,breathing-border,cadence-equalizer,context-constellation,cost-candle,diff-bloom,goal-horizon,memory-crystals,model-weather-vane,prompt-charge,reflection-ripple,retry-radar,session-bonsai,todo-meteors,token-tide,tool-constellation}.test.ts`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (drift since `e7466a84f`).
- Sharing the host changes an observable per-animation cadence for the 16
  built-ins (they all read `display.animations`, so it must not — if a feature
  test asserts a cadence that now fails, stop rather than editing the
  assertion).
- Backpressure behavior becomes observably different (the shared host's
  frame-skip must behave as each private host's did; if a backpressure test
  regresses, stop).
- Step 7's cap-by-global-tier caveat is unacceptable for context-weather (a
  reviewer/operator says local `full` must override a global `off`/`subtle`) —
  stop and hand the settings question to plan 006.
- A phase's verification fails twice after a reasonable fix attempt, or the
  tree cannot stay green between two phases.
- You find a 17th feature constructing its own host that this plan does not
  list — stop and report the path.

## Maintenance notes

- Cross-plan: plan 005 (lifecycle) assumes controllers can dispose without
  killing the session clock — the `owned: false` mount introduced here is what
  makes that safe. Plan 006 (settings) replaces the private
  `readDisplayAnimations()` in `session-animation.ts` with the single public
  reader and adds live setting-change subscription; leave that function private
  so 006 owns the move. The 16 dead `readMotionSetting` copies are deleted in
  Step 6; if 006 runs first, its dedup step already removed them — reconcile by
  grep, not by assumption.
- Reviewer focus: (1) every controller's `dispose()` — the session host must
  never be disposed by a feature; (2) the Step 1 cadence filter math around
  skipped frames under backpressure; (3) `session-animation.ts` WeakMap keying —
  it must key the same `TUI` object the widget factories receive.
- Deferred: per-frame feature-work budgets (plan 007); a
  `subscriberCount`-style debug surface listing which features hold
  subscriptions (nice-to-have; file a bead if wanted).
