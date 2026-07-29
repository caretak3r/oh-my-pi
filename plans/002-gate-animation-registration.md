# Plan 002: Gate the 16 animation extensions behind the interactive-UI signal

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e7466a84f..HEAD -- packages/coding-agent/src/sdk.ts packages/coding-agent/src/animation-extensions.ts packages/coding-agent/test/animation-extension-gating.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

`sdk.ts` pushes all 16 animation extensions unconditionally on **every**
session: headless `omp exec`, subagents, CI, piped stdout all execute 16
dynamic imports and register hot-path event handlers that can never draw
anything (the `MotionPolicy` resolves `off` for `hasUI: false` / non-TTY).
Today this is fail-safe but not free: every non-interactive run pays the
import + handler cost, and the surface is one unguarded module-scope line away
from re-introducing the "Settings not initialized" crash that commit
`73b9c8a51` had to guard in all 16 controllers. Gating registration on the
session's existing interactive-UI signal removes the entire animation surface
from non-interactive paths — making "cosmetic-only" structurally true instead
of behaviorally true.

## Current state

- `packages/coding-agent/src/sdk.ts` — `createAgentSession`. The inline
  extension block (lines 1842–1862) as it exists today:

  ```ts
  // sdk.ts:1842-1862
  const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
  inlineExtensions.push((await import("./autoresearch")).createAutoresearchExtension);
  inlineExtensions.push((await import("./retry-radar")).createRetryRadarExtension);
  inlineExtensions.push((await import("./tool-constellation")).createToolConstellationExtension);
  inlineExtensions.push((await import("./token-tide")).createTokenTideExtension);
  inlineExtensions.push((await import("./session-bonsai")).createSessionBonsaiExtension);
  inlineExtensions.push((await import("./todo-meteors")).createTodoMeteorsExtension);
  inlineExtensions.push((await import("./breathing-border")).createBreathingBorderExtension);
  inlineExtensions.push((await import("./agent-fleet")).createAgentFleetExtension);
  inlineExtensions.push((await import("./cost-candle")).createCostCandleExtension);
  inlineExtensions.push((await import("./reflection-ripple")).createReflectionRippleExtension);
  inlineExtensions.push((await import("./memory-crystals")).createMemoryCrystalsExtension);
  inlineExtensions.push((await import("./context-constellation")).createContextConstellationExtension);
  inlineExtensions.push((await import("./diff-bloom")).createDiffBloomExtension);
  inlineExtensions.push((await import("./cadence-equalizer")).createCadenceEqualizerExtension);
  inlineExtensions.push((await import("./goal-horizon")).createGoalHorizonExtension);
  inlineExtensions.push((await import("./model-weather-vane")).createModelWeatherVaneExtension);
  inlineExtensions.push((await import("./prompt-charge")).createPromptChargeExtension);
  if (customTools.length > 0) {
  	inlineExtensions.push(createCustomToolsExtension(customTools));
  }
  ```

  Line 1843 (`autoresearch`) is **functional, not cosmetic — it stays
  unconditional**. The 16 animation pushes are lines 1844–1859. Inline
  factories are later materialized at lines 1907–1920 via
  `loadExtensionFromFactory(factory, cwd, eventBus, extensionsResult.runtime,
  `` `<inline-${i}>` ``)` regardless of which discovery path ran, so this block
  is the single choke point for all session kinds.

- **The real interactive signal (verified, do not invent another)**:
  - `packages/coding-agent/src/main.ts:1251`:
    `sessionOptions.hasUI = isInteractive || mode === "rpc-ui";`
    — the CLI sets it for top-level sessions; print/exec and plain rpc get
    `false` (`main.ts:383` explicitly passes `hasUI: false` for the
    non-interactive path).
  - `packages/coding-agent/src/sdk.ts:548-549` documents the option:
    `/** Whether UI is available (enables interactive tools like ask). Default: false */ hasUI?: boolean;`
    and sdk.ts:1532 shows the default applied: `hasUI: options.hasUI ?? false`.
  - Subagent session creation (`packages/coding-agent/src/task/executor.ts`)
    does not set `hasUI` at all → defaults `false`, so subagents are excluded
    by the same gate with no extra subagent detection needed.
  - `options.hasUI` is in scope at line 1842 (`options` is the
    `createAgentSession` parameter, referenced at e.g. 1673 and 2983 as
    `options.hasUI`).
  - This is also the signal the animation kit itself gates on:
    `packages/animation/src/motion-policy.ts:40-43`
    (`resolveMotionTier`: `if (!env.hasUI) return "off";`). Gating
    registration on the same predicate cannot disable anything that could
    ever have animated.

- **Deliberate design decision — do NOT also gate on `display.animations`**:
  the extensions re-read the setting per event, not at registration. Example,
  `packages/coding-agent/src/diff-bloom/index.ts:11-15`:

  ```ts
  function readMotionSetting(): MotionSetting {
  	if (!isSettingsInitialized()) return "full";
  	const value = settings.get("display.animations");
  	return value === "off" || value === "subtle" || value === "full" ? value : "full";
  }
  ```

  called from `toDiffBloomContext` on every `tool_result`. A user who starts
  with `display.animations: "off"` and flips it to `"full"` mid-session gets
  motion back live today; a registration-time setting gate would silently
  break that until restart. `hasUI`, by contrast, is fixed for the lifetime of
  a session. So the gate is `options.hasUI === true`, nothing else.

- Conventions: `logger` not `console` (no logging needed here anyway); ES
  `#private`; behavioral tests only; Conventional Commits.

## Commands you will need

| Purpose                | Command                                                                | Expected on success |
|------------------------|------------------------------------------------------------------------|---------------------|
| Typecheck + lint pkg   | `bun --cwd=packages/coding-agent run check`                            | exit 0              |
| New test               | `bun test packages/coding-agent/test/animation-extension-gating.test.ts` | all pass          |
| Typecheck all packages | `bun run --workspaces --if-present check`                              | every pkg exit 0    |

Note: repo-wide `bun run check:tools` (biome) currently fails ONLY on an
untracked scratch file `packages/coding-agent/scripts/wave2-live-demo.ts`.
That file is not yours; ignore that specific failure.

## Scope

**In scope** (the only files you should modify/create):
- `packages/coding-agent/src/animation-extensions.ts` (create)
- `packages/coding-agent/src/sdk.ts` (lines 1844–1859 region + one import)
- `packages/coding-agent/test/animation-extension-gating.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `sdk.ts:1843` — `autoresearch` is functional; it must remain registered on
  every session.
- The 16 extension modules themselves (`./retry-radar` … `./prompt-charge`)
  and their per-controller guards from `73b9c8a51` — the guards stay as
  defense in depth.
- `options.extensions` (caller-supplied inline factories) and
  `createCustomToolsExtension` — unrelated to this gate.
- Any change keyed on `display.animations` at registration time (see the
  design decision above).
- `packages/coding-agent/src/main.ts` — the `hasUI` assignment is already
  correct.

## Git workflow

- Branch: `refactor/gate-animation-registration` (repo uses `feat/…`/`fix/…`/`refactor/…`).
- Conventional Commits; recent example from `git log`:
  `fix(animations): backport backpressure-recovery fix to all 16 controllers`.
  Suggested: `refactor(sdk): gate the 16 animation extensions on hasUI`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the gated loader module

Create `packages/coding-agent/src/animation-extensions.ts` (sibling of
`sdk.ts`, so the 16 relative imports keep their exact current specifiers).
Content shape:

```ts
import type { ExtensionFactory } from "./extensibility/extensions";

/**
 * The cosmetic animation extension family. Registered only for interactive
 * sessions (`hasUI`): headless exec, subagents, plain rpc, and CI never load
 * these modules or their event handlers. `hasUI=false` sessions could never
 * animate anyway — `resolveMotionTier` forces the `off` tier without a UI
 * (packages/animation/src/motion-policy.ts) — so gating registration removes
 * dead import + handler cost without changing observable behavior.
 *
 * NOT gated on `display.animations`: the setting is re-read per event by the
 * extensions themselves, so a live off->full flip re-enables motion without a
 * session restart. Keep it that way.
 */
export async function loadAnimationExtensions(hasUI: boolean): Promise<ExtensionFactory[]> {
	if (!hasUI) return [];
	return [
		(await import("./retry-radar")).createRetryRadarExtension,
		(await import("./tool-constellation")).createToolConstellationExtension,
		(await import("./token-tide")).createTokenTideExtension,
		(await import("./session-bonsai")).createSessionBonsaiExtension,
		(await import("./todo-meteors")).createTodoMeteorsExtension,
		(await import("./breathing-border")).createBreathingBorderExtension,
		(await import("./agent-fleet")).createAgentFleetExtension,
		(await import("./cost-candle")).createCostCandleExtension,
		(await import("./reflection-ripple")).createReflectionRippleExtension,
		(await import("./memory-crystals")).createMemoryCrystalsExtension,
		(await import("./context-constellation")).createContextConstellationExtension,
		(await import("./diff-bloom")).createDiffBloomExtension,
		(await import("./cadence-equalizer")).createCadenceEqualizerExtension,
		(await import("./goal-horizon")).createGoalHorizonExtension,
		(await import("./model-weather-vane")).createModelWeatherVaneExtension,
		(await import("./prompt-charge")).createPromptChargeExtension,
	];
}
```

Keep the 16 in the exact order they appear in `sdk.ts` today (registration
order is observable in extension iteration; don't reorder). The dynamic
imports live inside the `hasUI` branch on purpose — a headless session must
not evaluate any of the 16 modules.

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0.

### Step 2: Switch `sdk.ts` to the gated loader

In `packages/coding-agent/src/sdk.ts`:

1. Add `import { loadAnimationExtensions } from "./animation-extensions";`
   alongside the other local imports.
2. Replace lines 1844–1859 (the 16 animation pushes ONLY — keep line 1843
   `autoresearch` and the `customTools` block below) with:

   ```ts
   inlineExtensions.push(...(await loadAnimationExtensions(options.hasUI === true)));
   ```

The result reads:

```ts
const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
inlineExtensions.push((await import("./autoresearch")).createAutoresearchExtension);
inlineExtensions.push(...(await loadAnimationExtensions(options.hasUI === true)));
if (customTools.length > 0) {
	inlineExtensions.push(createCustomToolsExtension(customTools));
}
```

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0, and
`grep -c "inlineExtensions.push((await import" packages/coding-agent/src/sdk.ts`
→ `1` (only autoresearch remains a direct dynamic-import push).

### Step 3: Behavioral test for the gate

Create `packages/coding-agent/test/animation-extension-gating.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { loadAnimationExtensions } from "@oh-my-pi/pi-coding-agent/animation-extensions";

describe("animation extension gating", () => {
	it("registers no animation extensions without an interactive UI", async () => {
		expect(await loadAnimationExtensions(false)).toEqual([]);
	});

	it("registers the full 16-extension animation family for interactive sessions", async () => {
		const factories = await loadAnimationExtensions(true);
		expect(factories).toHaveLength(16);
		for (const factory of factories) expect(typeof factory).toBe("function");
		expect(new Set(factories).size).toBe(16); // all distinct
	});
});
```

(Import specifier: the test suite imports package-internal modules as
`@oh-my-pi/pi-coding-agent/<path>` — see
`packages/coding-agent/test/event-controller-todo-reminder.test.ts:2` for the
pattern. If that alias does not resolve for the new module, use the relative
`../src/animation-extensions` form used by
`packages/coding-agent/test/compaction-vacuum.test.ts`.)

**Verify**: `bun test packages/coding-agent/test/animation-extension-gating.test.ts`
→ 2 pass.

### Step 4: Regression sweep on session-construction tests

The gate changes what non-UI sessions register, so run the test files that
exercise `createAgentSession` headlessly:

**Verify**: `bun test packages/coding-agent/test/acp-lazy-startup.test.ts packages/coding-agent/test/acp-mcp-isolation.test.ts packages/coding-agent/test/agent-fleet.test.ts` → all pass.
(`agent-fleet.test.ts` tests the extension module directly, not via a session
— it must be unaffected; if it fails, see STOP conditions.)

### Step 5: Workspace gate

**Verify**: `bun run --workspaces --if-present check` → every package exit 0.

## Test plan

- New file `packages/coding-agent/test/animation-extension-gating.test.ts`
  (Step 3): headless → empty; interactive → exactly 16 distinct factory
  functions. This is the behavioral contract "a non-interactive session does
  not register the animation family" expressed at the seam where it is
  decidable without booting a full model-backed session.
- Regression: Step 4's existing headless-session tests + the full
  `bun --cwd=packages/coding-agent run check` typegate.
- The sdk.ts wiring itself is covered by the Step 2 grep (exactly one direct
  dynamic-import push left) plus typecheck; a full `createAgentSession`
  integration test is intentionally not added (requires model registry/auth
  scaffolding disproportionate to a registration gate).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun --cwd=packages/coding-agent run check` exits 0
- [ ] `bun test packages/coding-agent/test/animation-extension-gating.test.ts` exits 0, 2 tests
- [ ] `grep -c "inlineExtensions.push((await import" packages/coding-agent/src/sdk.ts` prints `1`
- [ ] `grep -n "autoresearch" packages/coding-agent/src/sdk.ts` still shows the unconditional push
- [ ] `grep -c "await import" packages/coding-agent/src/animation-extensions.ts` prints `16`
- [ ] Step 4 test files all pass
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if the index exists and you own the update)

## STOP conditions

Stop and report back (do not improvise) if:

- The `sdk.ts` excerpt (lines 1842–1862) doesn't match the live code (drift
  since `e7466a84f`).
- `options.hasUI` is NOT in scope at line 1842, or you find evidence that a
  session kind with `hasUI === false` is expected to run one of the 16
  (e.g. a test in Step 4 fails because a headless harness asserts an
  animation extension is registered). Report which signal/session kind
  conflicts instead of inventing a different predicate.
- Any of the 16 modules turns out to register non-cosmetic functionality
  (a tool, command, or provider) that headless flows depend on — report the
  module and the functionality; do not split it yourself.
- A fix attempt fails verification twice.

## Maintenance notes

- Future animation extensions must be added to
  `animation-extensions.ts`, not pushed directly in `sdk.ts` — reviewers
  should reject any new `inlineExtensions.push((await import("./<anim>")))`
  line in `sdk.ts`.
- If a future requirement wants registration gated on `display.animations`,
  the live-toggle semantics must move too (a settings subscription that
  registers/unregisters extensions at runtime) — a plain registration-time
  read is a regression; see the design decision in "Current state".
- `rpc-ui` mode keeps `hasUI: true` (main.ts:1251) and therefore keeps
  animations — intended, it drives a real UI.
- Interaction with Plan 001 (animation error boundary) and Plan 003
  (compaction vacuum): independent — those harden the frame path itself; this
  plan removes the surface where it can never draw. No ordering constraint.
