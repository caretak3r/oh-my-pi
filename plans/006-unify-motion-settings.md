# Plan 006: Unify the three meanings of "animations" behind one live setting

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e7466a84f..HEAD -- packages/animation/src/motion-policy.ts packages/animation/test packages/coding-agent/src/config packages/coding-agent/src/modes/session-animation.ts packages/coding-agent/src/modes/theme/shimmer.ts packages/coding-agent/src/extensibility/extensions/animated-feature.ts "packages/coding-agent/src/*/index.ts" packages/context-weather/src packages/coding-agent/plugins/spinner-packs/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 004/005 are expected to have
> landed first — this plan builds on `session-animation.ts` (from 004) and
> `animated-feature.ts` (from 005); if either file does not exist, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/004-shared-family-clock.md (hard), plans/005-lifecycle-teardown-contract.md (soft — Step 4 uses its helper; a fallback is given)
- **Category**: tech-debt
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

"Animations" means three different things in this codebase. The 16 built-ins
read `display.animations` (tier `full/subtle/off`) through 16 duplicated
`readMotionSetting()` copies and never see a setting change after mount.
Spinner packs read a plugin boolean `animations` that maps to the core
`display.shimmer` enum — so `display.animations: off` does NOT stop the
spinner's 30fps gradient sweep. Context-weather has a package-local
`animations` setting defaulting to `"off"`, refreshed only on an async
`context` event, and `MotionPolicy.setSetting()` early-returns on an unchanged
value — so a policy first resolved under render backpressure can stay `off`
after pressure clears. One reader, one live change signal, one documented
relationship between the three settings fixes all four gaps.

## Current state

### The three settings

`packages/coding-agent/src/config/settings-schema.ts:936-952` — the tier the
16 built-ins obey:

```ts
	"display.animations": {
		type: "enum",
		values: ["full", "subtle", "off"] as const,
		default: "full",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Animations",
			description:
				"Motion tier for ambient animated widgets (e.g. the compaction condense animation, auto-retry countdown ring, tool constellation star map). off: static text; subtle: reduced cadence (~12fps); full: smooth (~30fps). Always forced off outside a TTY or under NO_COLOR/CI/dumb terminals.",
			...
```

`settings-schema.ts:871-886` — the working-message shimmer (an unrelated
mechanism the spinner packs piggyback on):

```ts
	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		...
```

`packages/coding-agent/plugins/spinner-packs/package.json:29-36` — the plugin
boolean that maps onto shimmer, not onto `display.animations`:

```json
      "animations": {
        "type": "boolean",
        "description": "Enable the animated gradient sweep. When off, the pack renders a static gradient. Backed at runtime by the core `display.shimmer` toggle.",
        "mapsTo": "display.shimmer",
        "mapsToTrue": "classic",
        "mapsToFalse": "disabled",
        "default": true
      }
```

Spinner resolution is gated ONLY by shimmer
(`packages/coding-agent/src/modes/interactive-mode.ts:3638-3652`, inside
`ensureLoadingAnimation()`):

```ts
			if (shimmerEnabled()) messageColorFn.animated = true;
			...
			const spinnerPack = this.settings.get("display.spinnerPack");
			if (spinnerPack !== "default" && isSpinnerPackId(spinnerPack)) {
				const capabilities = detectSpinnerCapabilities({ trueColor: TERMINAL.trueColor });
				const resolved = resolveSpinnerPack(spinnerPack, {
					animations: shimmerEnabled(),
					...
```

`shimmerEnabled` (`packages/coding-agent/src/modes/theme/shimmer.ts:155-164`):

```ts
function resolveMode(): ShimmerMode {
	if (!isSettingsInitialized()) return "classic";
	return settings.get("display.shimmer");
}

/** Whether shimmer animations are active (any mode other than `disabled`). */
export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled";
}
```

Context-weather's package-local setting defaults OFF
(`packages/context-weather/src/settings.ts:21`: `animations: "off",`) and its
live refresh path calls only `setSetting`
(`packages/context-weather/src/extension.ts:151-159`):

```ts
	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		const current = mounted;
		if (!current) return;

		const settings = await loadSettings(ctx);
		if (mounted !== current) return;

		// Live re-resolve the motion tier (subtle/full/off) without a remount.
		current.policy.setSetting(settings.animations);
```

### The duplicated reader (16/16 at `e7466a84f`)

Every feature `index.ts` carries this copy (e.g.
`packages/coding-agent/src/tool-constellation/index.ts:12-16`):

```ts
function readMotionSetting(): MotionSetting {
	if (!isSettingsInitialized()) return "full";
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}
```

NOTE: plan 004's cleanup phase deletes these copies (their consumer,
per-controller `MotionPolicy` construction, is removed) and leaves ONE private
copy named `readDisplayAnimations()` inside
`packages/coding-agent/src/modes/session-animation.ts`. Verify with:
`grep -rln "function readMotionSetting" packages/coding-agent/src --include="index.ts"`.
If that still prints 16 files, plan 004 has not landed — STOP (dependency).

### The stuck-off gap in the kit

`packages/animation/src/motion-policy.ts:98-114`:

```ts
	/** Update the `animations` setting and re-resolve. */
	setSetting(setting: MotionSetting): void {
		if (setting === this.#setting) return;
		this.#setting = setting;
		this.#reresolve();
	}
	...
	/** Re-read the environment (including live backpressure) and re-resolve. */
	refresh(): void {
		this.#reresolve();
	}
```

`resolveMotionTier` consults `env.backpressure?.underPressure` at resolve time
(`motion-policy.ts:48`). A policy constructed under pressure resolves `off`;
when pressure clears, nothing re-resolves unless a caller invokes `refresh()`.
Context-weather's refresh calls only `setSetting` — same value → early return →
stays `off`. The ONLY call site doing it right is the core pattern
(`packages/coding-agent/src/modes/controllers/event-controller.ts:241-242`,
now inside `session-animation.ts` after plan 004): `setSetting(...)` then
`refresh()`.

### No live change signal exists for `display.animations`

`packages/coding-agent/src/config/settings.ts` has the mechanism to copy:
`SettingSignal` (`settings.ts:1391-1420`), fired from `SETTING_HOOKS`
(`settings.ts:1422-1469`, e.g.
`"provider.appendOnlyContext": value => { ... appendOnlyModeSignal.fire(value); }`),
with exported subscriptions like
(`settings.ts:1480-1487`):

```ts
/** Fires when `statusLine.sessionAccent` changes at runtime. */
const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);
```

There is no `"display.animations"` entry in `SETTING_HOOKS` at `e7466a84f`.

### Conventions

Bun; `logger` not `console`; ES `#private`; behavioral tests only; settings UI
descriptions are user-facing documentation — when this plan changes semantics,
the schema `description` strings must say so.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck+lint animation | `bun --cwd=packages/animation run check` | exit 0 |
| Typecheck+lint coding-agent | `bun --cwd=packages/coding-agent run check` | exit 0 |
| Typecheck+lint context-weather | `bun --cwd=packages/context-weather run check` | exit 0 |
| All workspaces | `bun run --workspaces --if-present check` | exit 0 |
| Kit tests | `bun test packages/animation/test/animation-kit.test.ts` | all pass |
| Context-weather tests | `bun test packages/context-weather/test/settings.test.ts packages/context-weather/test/extension.test.ts` | all pass |
| Repo lint | `bun run check:tools` | exit 0 (ignore untracked `packages/coding-agent/scripts/wave2-live-demo.ts`) |

## Scope

**In scope** (the only files you should modify):
- `packages/animation/src/motion-policy.ts` + `packages/animation/test/animation-kit.test.ts`
- `packages/coding-agent/src/config/motion.ts` (create) and `packages/coding-agent/src/config/settings.ts` (one `SETTING_HOOKS` entry + one signal + one export, nothing else)
- `packages/coding-agent/src/modes/session-animation.ts` (from plan 004)
- `packages/coding-agent/src/extensibility/extensions/animated-feature.ts` (from plan 005)
- `packages/coding-agent/src/modes/theme/shimmer.ts` (decision-gated Step 5)
- `packages/coding-agent/src/config/settings-schema.ts` (description strings only)
- `packages/context-weather/src/settings.ts`, `packages/context-weather/src/extension.ts` + their tests
- `packages/coding-agent/plugins/spinner-packs/package.json` (description strings only)
- `packages/coding-agent/test/session-animation.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- Removing or renaming `display.shimmer` or the spinner-pack boolean's
  `mapsTo` machinery — plugin settings mapping is contract
  (`mapsToTrue`/`mapsToFalse` consumers exist); this plan documents and gates,
  it does not migrate stored settings.
- `interactive-mode.ts` — the spinner/loader wiring keeps reading
  `shimmerEnabled()`; the gate lands INSIDE `shimmerEnabled()` (Step 5) so all
  call sites inherit it.
- Per-frame cost of colorizers/renders — plan 007.
- The 16 feature `controller.ts` files — no mount-fork changes here; live
  toggle is delivered via the plan-005 helper (dispose + remount), not by
  editing 16 controllers.

## Git workflow

- Branch: `advisor/006-unify-motion-settings`
- Conventional Commits (`fix(animations): ...` / `refactor(settings): ...`),
  one commit per step.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Kit — remove the `setSetting` early-return

`packages/animation/src/motion-policy.ts:99-103`: delete the
`if (setting === this.#setting) return;` guard so `setSetting` always calls
`#reresolve()`. `#reresolve` (`:124-131`) already no-ops listener notification
when the tier is unchanged, so this is cheap and cannot cause extra
notifications — but it makes every `setSetting` call double as a `refresh()`,
closing the stuck-off-after-backpressure gap for every current and future
caller. Update the `setSetting` doc comment to say it re-resolves
unconditionally (environment included).

Add kit tests (`packages/animation/test/animation-kit.test.ts`):
1. Policy constructed with `backpressure: { underPressure: true }` in env and
   setting `"full"` → tier `"off"`; flip the fake signal to `false`; call
   `setSetting("full")` (same value) → tier becomes `"full"` and subscribed
   listeners fire once.
2. `setSetting` with an unchanged value and unchanged environment fires no
   listener (no-op notification guarantee preserved).

**Verify**: `bun --cwd=packages/animation run check && bun test packages/animation/test/animation-kit.test.ts` → exit 0, all pass (2 new tests)

### Step 2: One reader + one change signal in core

1. Create `packages/coding-agent/src/config/motion.ts`:
   - `export function readMotionSetting(): MotionSetting` — the exact body of
     the (now-private) copy in `session-animation.ts` (guard
     `isSettingsInitialized()`, default `"full"`, validate enum).
2. `packages/coding-agent/src/config/settings.ts`:
   - Next to the existing signals (`:1480-1502` region):
     `const displayAnimationsSignal = new SettingSignal("display.animations");`
     `export const onDisplayAnimationsChanged = (cb: () => void) => displayAnimationsSignal.on(cb);`
   - In `SETTING_HOOKS` (`:1422-1469`): add
     `"display.animations": () => displayAnimationsSignal.fire(),` (match the
     `hindsight.bankId` entries' shape at `:1455-1457`).
3. `packages/coding-agent/src/modes/session-animation.ts`: delete the private
   `readDisplayAnimations()` and import `readMotionSetting` from
   `../config/motion`. Then make the service LIVE: on handle creation,
   subscribe `onDisplayAnimationsChanged(() => { policy.setSetting(readMotionSetting()); })`
   (post-Step-1, `setSetting` alone re-resolves environment too); store the
   unsubscribe and call it in the service's dispose path.

Extend `packages/coding-agent/test/session-animation.test.ts`: with an
initialized test Settings instance (see how existing settings-dependent tests
initialize; `resetSettingsForTest()` is exported at `settings.ts:1526`), change
`display.animations` at runtime and assert the shared policy's tier follows
without any widget remount.

**Verify**: `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/session-animation.test.ts` → exit 0, all pass

### Step 3: Confirm the 16 duplicated readers are gone (or delete them)

`grep -rln "function readMotionSetting" packages/coding-agent/src --include="index.ts"`
must print nothing (plan 004's Step 6 deleted them with their consumers). If
any file still prints AND its `readMotionSetting` is unreferenced, delete the
dead function in batches of ≤5 files. If it is still referenced, plan 004 is
incomplete — STOP.

**Verify**: `grep -rln "function readMotionSetting" packages/coding-agent/src --include="index.ts"` → no output; `bun --cwd=packages/coding-agent run check` → exit 0

### Step 4: Live toggle reaches mounted features

Already-animated widgets follow the tier live (the `AnimatedWidget` base
handles off↔on crossings — `packages/animation/src/animated-widget.ts:129-148`),
but a feature MOUNTED static (tier was `off` at mount) never upgrades: its
controller holds `{ mode: "static" }` and only repaints static text. Deliver
the upgrade through the plan-005 helper instead of editing 16 controllers:

In `packages/coding-agent/src/extensibility/extensions/animated-feature.ts`,
extend `registerAnimatedFeatureLifecycle` to also subscribe
`onDisplayAnimationsChanged`: on fire, call `lifecycle.dispose(...)` (and
`remountOnSwitch` where provided) exactly as the `session_switch` handler does
— the feature's next data event remounts under the new tier. Subscription needs
a current `ExtensionContext`; the helper receives contexts only inside event
handlers, so capture the latest ctx: have the switch/shutdown/event wiring
stash the most recent `ExtensionContext` in a local, and skip the toggle
handler until one exists. Unsubscribe on `session_shutdown`.

Fallback if plan 005 has NOT landed (helper absent): STOP — do not hand-wire 16
indices; the dependency order exists to prevent exactly that sweep.

Add one behavioral case to `packages/coding-agent/test/wave2-lifecycle.test.ts`
(plan 005's file): mount a feature static (no `animation` handle → static), fire
the settings signal, assert the widget was cleared (dispose ran), then drive the
feature's event and assert remount.

**Verify**: `bun test packages/coding-agent/test/wave2-lifecycle.test.ts` → all pass (1 new case)

### Step 5 (DECISION — confirm with the operator before implementing): `display.animations: off` as the master motion switch

Recommendation to present: `display.animations` is the user's one "stop the
motion" control; `display.shimmer` and `display.spinnerPack` choose STYLE.
Concretely: `shimmerEnabled()` (`shimmer.ts:162-164`) becomes

```ts
export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled" && readMotionSetting() !== "off";
}
```

which transitively stills the working-message shimmer AND the spinner-pack
gradient sweep (both gate on `shimmerEnabled()` —
`interactive-mode.ts:3638,3649`) when animations are `off`. `subtle` does not
throttle shimmer (shimmer has no tier concept; document that). This changes
observable behavior for users who set `display.animations: off` while relying
on shimmer — that is the point, but it is a semantics change to an existing
setting: get an explicit go from the operator (per repo collaboration rules,
data-model/contract changes require confirmation). If declined, implement the
documentation-only variant: schema descriptions state explicitly that shimmer
and spinner packs are governed by `display.shimmer`, not `display.animations`.

If approved, also update the description strings (no value/schema changes):
- `settings-schema.ts:936-952` (`display.animations`): mention it also stills
  shimmer/spinner-pack sweeps when `off`.
- `settings-schema.ts:871-886` (`display.shimmer`): mention `display.animations: off` overrides.
- `plugins/spinner-packs/package.json:31` description: same sentence.

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0; `bun test packages/coding-agent/test/modes/theme/spinner-packs.test.ts` → all pass (that suite calls `colorizeAtPhase`/`resolveSpinnerPack` directly with explicit options, so it must not break; if it reads `shimmerEnabled`, adjust the test setup to initialize settings, not the assertion)

### Step 6: Context-weather defaults follow the core tier

`packages/context-weather/src/settings.ts`: change the `animations` default
from the hard `"off"` (`settings.ts:21`) to "inherit `display.animations`":
keep the stored-setting > env-var precedence
(`resolveContextWeatherSettingsFromSources`, used at `extension.ts:100`), and
when neither source sets a value, resolve from the core reader. Context-weather
already deep-imports from `@oh-my-pi/pi-coding-agent`
(`extension.ts:24`), so import `readMotionSetting` from
`@oh-my-pi/pi-coding-agent/config/motion`. Keep the resolver pure: pass the
fallback in as a parameter (`resolveContextWeatherSettingsFromSources(stored, env, fallback)`)
so `settings.test.ts` stays deterministic.

Also close the package's own stuck-off path: in `refresh()`
(`extension.ts:151-159`) Step 1 already made `setSetting` re-resolve the
environment, so no second call is needed — confirm by test: create the policy
under a pressured fake backpressure signal, clear pressure, emit a `context`
event, assert the tier recovers (behavioral test in
`packages/context-weather/test/extension.test.ts`).

Document in `packages/context-weather/src/settings.ts` doc comments: local
setting is an OVERRIDE (can force off/subtle below the core tier); with plan
004's shared host, it cannot raise motion above the core tier.

**Verify**: `bun --cwd=packages/context-weather run check && bun test packages/context-weather/test/settings.test.ts packages/context-weather/test/extension.test.ts` → exit 0, all pass

### Step 7: Full sweep

**Verify**: `bun run --workspaces --if-present check` → exit 0

## Test plan

- Kit (`animation-kit.test.ts`): pressure-clears-then-same-value-setSetting
  recovers; unchanged-value fires no listener.
- `session-animation.test.ts`: runtime `display.animations` change re-resolves
  the shared policy live.
- `wave2-lifecycle.test.ts`: static-mounted feature is disposed+remountable on
  toggle (Step 4).
- Context-weather: default inherits core tier (settings.test.ts);
  pressure-recovery via `context` event; override-below still honored
  (extension.test.ts).
- Spinner packs: existing `packages/coding-agent/test/modes/theme/spinner-packs.test.ts`
  unchanged and green (Step 5 must not alter `resolveSpinnerPack`'s explicit
  `animations` option semantics).
- Verification: the per-step commands plus Step 7.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run --workspaces --if-present check` exits 0
- [ ] `grep -rn "function readMotionSetting" packages/coding-agent/src | grep -v "config/motion.ts"` → no matches
- [ ] `grep -n "display.animations" packages/coding-agent/src/config/settings.ts` → shows the `SETTING_HOOKS` entry
- [ ] `grep -n "if (setting === this.#setting) return" packages/animation/src/motion-policy.ts` → no matches
- [ ] `bun test packages/animation/test/animation-kit.test.ts packages/coding-agent/test/session-animation.test.ts packages/coding-agent/test/wave2-lifecycle.test.ts packages/context-weather/test/settings.test.ts packages/context-weather/test/extension.test.ts packages/coding-agent/test/modes/theme/spinner-packs.test.ts` exits 0
- [ ] Step 5 decision recorded in the final report (approved + implemented, or declined + docs-only)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `packages/coding-agent/src/modes/session-animation.ts` or
  `packages/coding-agent/src/extensibility/extensions/animated-feature.ts`
  does not exist (plans 004/005 not landed — this plan's steps assume both).
- The 16 `readMotionSetting` copies are still REFERENCED (Step 3) — plan 004
  incomplete.
- The operator declines Step 5 AND also wants spinner packs governed by
  `display.animations` some other way — that is a new design, not this plan.
- Folding shimmer under `display.animations: off` breaks shimmer-dependent
  behavior outside the loader (search `shimmerEnabled(` call sites first; at
  `e7466a84f` the loader path in `interactive-mode.ts` is the consumer — if
  you find others, list them in the report before Step 5).
- Live re-resolution produces visible flicker in a behavioral test (a tier
  listener firing repeatedly without a value change) — the Step 1 no-op
  guarantee test exists precisely to catch this; if it fails, the kit change is
  wrong, do not paper over it.
- Context-weather inheriting `full` by default is deemed unacceptable
  (context-weather was deliberately opt-in; flipping the default is a product
  decision — it is flagged in Step 6; if the operator says keep `"off"`,
  implement everything else and leave the default).

## Maintenance notes

- After this plan, the ONE place that reads `display.animations` is
  `config/motion.ts`; the ONE live subscription mechanism is
  `onDisplayAnimationsChanged`. Any new consumer must use both — never
  `settings.get("display.animations")` inline (add a grep to review checklists
  if it recurs).
- Reviewer focus: the Step 4 latest-ctx capture in the helper (a stale context
  after switch must not be used to remount into the previous session — the
  switch handler runs before any toggle can observe the old ctx, but review the
  ordering); the Step 5 semantics change and its description strings.
- Deferred: migrating spinner packs' boolean `mapsTo` onto a tier-aware
  mapping (would need plugin-settings migration for stored booleans); a
  `subtle` tier for shimmer (shimmer has no cadence concept today).
