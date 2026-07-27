# Plan 008: Decide the default motion tier for `display.animations` and align the codebase to the decision

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **THIS IS A DECISION PLAN.** Step 1 is a hard gate: a human product decision
> must be recorded before any code changes. If no recorded sign-off exists,
> the only allowed action is filing the decision request (Step 1) and stopping.
>
> **Drift check (run first)**:
> `git diff --stat e7466a84f..HEAD -- packages/coding-agent/src/config/settings-schema.ts docs/settings.md packages/coding-agent/CHANGELOG.md packages/animation/src/motion-policy.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

The `feat/wave2-animations` work adds a family of 16 ambient animated TUI
widgets (compaction condense animation, retry-radar countdown ring, tool
constellation, token tide, etc.), all gated by one setting:
`display.animations`. That setting currently defaults to `"full"` — so every
existing omp user who upgrades gets the entire animation family switched ON at
full ~30fps cadence, in every interactive TTY session, without having opted in.
The stated project goal for this branch is "purely additive, zero surprise to
omp's execution". A `"full"` default maximizes showcase value (users discover
the new widgets immediately) but contradicts the zero-surprise framing; a
conservative default (`"subtle"` or `"off"`) shrinks the upgrade blast radius
at the cost of discoverability. This is a product tradeoff, not a bug — a
human must choose the default before it ships.

**Author's recommendation**: `"subtle"` — reduced ~12fps cadence is visible
enough to showcase the new family but gentle enough not to ambush anyone.
Choose `"off"` instead only if zero-surprise upgrades are weighted above all
else; keep `"full"` only if the release is explicitly positioned as a
showcase release.

Important context that bounds the risk either way: the motion policy already
hard-forces the tier to `off` outside an interactive TTY and under
`NO_COLOR`/`CI`/`TERM=dumb`/render backpressure (see "Current state"). CI
logs, piped output, print/RPC modes, and dumb terminals are never affected by
this decision. The only population the default touches is interactive TTY
users on a capable terminal.

## Current state

- `packages/coding-agent/src/config/settings-schema.ts` — the settings schema;
  `display.animations` is defined at lines 936–953, with the default at
  line 939:

  ```ts
  // packages/coding-agent/src/config/settings-schema.ts:936-953
  "display.animations": {
      type: "enum",
      values: ["full", "subtle", "off"] as const,
      default: "full",                     // <-- line 939: the decision point
      ui: {
          tab: "appearance",
          group: "Display",
          label: "Animations",
          description:
              "Motion tier for ambient animated widgets (e.g. the compaction condense animation, auto-retry countdown ring, tool constellation star map). off: static text; subtle: reduced cadence (~12fps); full: smooth (~30fps). Always forced off outside a TTY or under NO_COLOR/CI/dumb terminals.",
          options: [
              { value: "full", label: "Full", description: "Full-cadence motion (~30fps)" },
              { value: "subtle", label: "Subtle", description: "Reduced-cadence motion (~12fps)" },
              { value: "off", label: "Off", description: "No motion; static fallback rendering" },
          ],
      },
  },
  ```

- `packages/animation/src/motion-policy.ts` — the shared motion policy. The
  hard environment gates live in `resolveMotionTier` (lines 40–50); they force
  `off` regardless of the setting:

  ```ts
  // packages/animation/src/motion-policy.ts:40-50
  export function resolveMotionTier(env: MotionEnvironment, setting: MotionSetting): MotionTier {
      if (setting === "off") return "off";
      if (!env.hasUI) return "off";
      if (!env.isTTY) return "off";
      const vars = env.env ?? Bun.env;
      if (isEnvSet(vars.NO_COLOR)) return "off";
      if (isEnvSet(vars.CI)) return "off";
      if (vars.TERM === "dumb") return "off";
      if (env.backpressure?.underPressure === true) return "off";
      return setting;
  }
  ```

  The `MotionPolicy` constructor also carries a convenience default
  (`motion-policy.ts:77`): `constructor(env: MotionEnvironment, setting: MotionSetting = "full")`.
  All production callers pass the setting explicitly, and this package cannot
  import the coding-agent settings schema (dependency direction), so this
  literal is OUT of scope — see Maintenance notes.

- **Hardcoded `"full"` fallbacks in 16 widget entry points.** Each animated
  widget's `index.ts` contains an identical `readMotionSetting()` helper with
  `"full"` hardcoded twice — the uninitialized-Settings fallback and the
  invalid-value fallback:

  ```ts
  // packages/coding-agent/src/diff-bloom/index.ts:11-15 (same shape in all 16 files)
  function readMotionSetting(): MotionSetting {
      if (!isSettingsInitialized()) return "full";
      const value = settings.get("display.animations");
      return value === "off" || value === "subtle" || value === "full" ? value : "full";
  }
  ```

  The 16 files (all under `packages/coding-agent/src/`):
  `diff-bloom/index.ts`, `goal-horizon/index.ts`, `prompt-charge/index.ts`,
  `token-tide/index.ts`, `cost-candle/index.ts`, `context-constellation/index.ts`,
  `memory-crystals/index.ts`, `breathing-border/index.ts`, `retry-radar/index.ts`,
  `model-weather-vane/index.ts`, `reflection-ripple/index.ts`,
  `cadence-equalizer/index.ts`, `session-bonsai/index.ts`, `todo-meteors/index.ts`,
  `agent-fleet/index.ts`, `tool-constellation/index.ts`.

  If the schema default changes and these literals do not, the
  uninitialized-Settings edge path (see commit `73b9c8a51`) would still run
  `"full"` — drifting from the decided default. Step 3 fixes this permanently
  by reading `getDefault("display.animations")` from the schema
  (`packages/coding-agent/src/config/settings-schema.ts:5045-5047` exports
  `getDefault`; it is re-exported through `../config/settings`, which these
  files already import from).

- `docs/settings.md` — user-facing settings doc. Two lines mention the
  default:
  - line 561 (YAML example): `  animations: full           # full, subtle, off`
  - line 580 (reference table): `| \`display.animations\` | enum | \`full\` | \`full\`, \`subtle\`, \`off\`. Motion for ambient animated widgets (e.g. the compaction condense animation). \`off\` and non-TTY/CI/\`NO_COLOR\`/backpressure always fall back to a static frame regardless of setting. |`

- `packages/coding-agent/CHANGELOG.md` — `## [Unreleased]` starts at line 3;
  it already has a `### Changed` subsection at line 16. The new entry goes
  there.

- No test asserts the `display.animations` default value
  (`grep -rn "display.animations" packages/coding-agent/test/ packages/animation/test/`
  returned no hits at planning time), so changing the default breaks no test.

- Repo conventions: Bun runtime; Conventional Commits (recent examples:
  `fix(animations): backport backpressure-recovery fix to all 16 controllers`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck+lint (coding-agent) | `bun --cwd=packages/coding-agent run check` | exit 0 |
| Animation package check | `bun --cwd=packages/animation run check` | exit 0 |
| Animation tests | `bun test packages/animation/test/animation-kit.test.ts` | all pass |
| Repo lint | `bun run check:tools` | exit 0 (ignore any complaint about untracked scratch file `packages/coding-agent/scripts/wave2-live-demo.ts`) |

## Scope

**In scope** (the only files you may modify, and ONLY after Step 1's gate):
- `packages/coding-agent/src/config/settings-schema.ts` (one line: the default)
- `docs/settings.md` (two lines)
- `packages/coding-agent/CHANGELOG.md` (one entry)
- The 16 widget `index.ts` files listed in "Current state" (Step 3 only —
  replacing the hardcoded `"full"` fallback literals with
  `getDefault("display.animations")`)

**Out of scope** (do NOT touch, even though they look related):
- `packages/animation/src/motion-policy.ts` — different package; cannot import
  the settings schema; its constructor default is always overridden by callers.
- Any controller/widget/state file under the 16 widget directories — behavior
  is unchanged; only the entry-point fallback literals move.
- `packages/coding-agent/src/modes/controllers/event-controller.ts` — reads
  the setting live; no default logic there.
- The `values` list, UI metadata, or description of `display.animations`.

## Git workflow

- Branch: `advisor/008-default-motion-tier` (branched from `integration/all-features`)
- Conventional Commits, e.g. `feat(animations): default display.animations to subtle`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Obtain and record the product decision (HARD GATE)

This default is a product call, not an engineering call. Check for an existing
recorded decision:

1. Run `bd list --status=all 2>/dev/null | grep -i "motion\|animations\|default"` and
   `bd show <id>` on any hit — look for a bead recording a human decision on
   the `display.animations` default with an explicit chosen tier.
2. If NO recorded decision exists: file the decision request and stop —
   `bd create "Decide default motion tier for display.animations (full/subtle/off)" -p 2` ,
   note in the bead body the three options and the author's recommendation
   (`subtle`) from "Why this matters", and mark it as needing a human
   (`bd update <id> --assignee=human` or the `bd human` flow if available in
   this repo's bd version — if neither works, record "NEEDS HUMAN SIGN-OFF" in
   the bead body). Then update this plan's row in `plans/README.md` to
   `BLOCKED (awaiting product sign-off on default tier)` and report back.
   **Do not proceed to Step 2.**
3. If a recorded decision EXISTS naming `full`: no code change is needed.
   Update the CHANGELOG only if the operator wants the "considered and kept"
   note; otherwise mark this plan `DONE (decision: keep full)` in
   `plans/README.md` and stop.
4. If a recorded decision EXISTS naming `subtle` or `off`: note the bead ID
   and proceed. Every commit message for this plan must reference that bead ID.

**Verify**: `bd show <id>` → shows a human-recorded decision naming exactly one
of `full` / `subtle` / `off`.

### Step 2: Change the schema default

In `packages/coding-agent/src/config/settings-schema.ts` line 939, inside the
`"display.animations"` block quoted in "Current state", change:

```ts
		default: "full",
```

to the decided tier, e.g.:

```ts
		default: "subtle",
```

**Verify**: `grep -n 'default: "subtle"' packages/coding-agent/src/config/settings-schema.ts`
(substitute the decided tier) → exactly one hit, at the line inside the
`"display.animations"` block (around line 939). Then
`bun --cwd=packages/coding-agent run check` → exit 0.

### Step 3: Point the 16 widget fallbacks at the schema default

In each of the 16 `index.ts` files listed in "Current state", the
`readMotionSetting()` helper hardcodes `"full"` twice. Replace both literals
with `getDefault("display.animations")`, and add `getDefault` to the existing
`../config/settings` import. Target shape (identical in all 16 files):

```ts
import { getDefault, isSettingsInitialized, settings } from "../config/settings";

function readMotionSetting(): MotionSetting {
	if (!isSettingsInitialized()) return getDefault("display.animations");
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : getDefault("display.animations");
}
```

Do not change anything else in these files. This makes the fallback follow the
schema default forever, so a future default change is one line again.

**Verify**:
`grep -rln 'return "full"' packages/coding-agent/src/*/index.ts` → no matches.
`grep -rc 'getDefault("display.animations")' packages/coding-agent/src/*/index.ts | grep -c ':2$'` → `16`.
`bun --cwd=packages/coding-agent run check` → exit 0.

### Step 4: Update the settings documentation

In `docs/settings.md`:

- Line 561: change `  animations: full           # full, subtle, off` so the
  example shows the decided default (keep the comment listing all values).
- Line 580: in the `display.animations` table row, change the Default column
  from `` `full` `` to the decided tier. Leave the Values column and prose
  unchanged.

**Verify**: `grep -n "animations" docs/settings.md` → both lines show the
decided tier as the default; no other lines changed
(`git diff --stat docs/settings.md` → 1 file, 2 lines changed).

### Step 5: Add a CHANGELOG entry

In `packages/coding-agent/CHANGELOG.md`, under `## [Unreleased]` →
`### Changed` (line 16), add one entry (adjust tier wording to the decision):

```md
- `display.animations` now defaults to `subtle` (was `full`): ambient animated widgets ship at reduced ~12fps cadence by default; set `display.animations: full` to opt into full-cadence motion. Non-TTY/`NO_COLOR`/`CI`/dumb terminals remain always-static regardless of this setting.
```

**Verify**: `grep -n "display.animations" packages/coding-agent/CHANGELOG.md`
→ includes the new entry under the Unreleased `### Changed` section.

## Test plan

No new tests: the default is data in the schema, the enum values and gating
logic are unchanged, and no existing test asserts the default (verified at
planning time — see "Current state"). Regression coverage:

- `bun test packages/animation/test/animation-kit.test.ts` → all pass
  (motion policy tests pass explicit settings; unaffected by the default).
- `bun --cwd=packages/coding-agent run check` → exit 0 (type-level check that
  `getDefault("display.animations")` is assignable to `MotionSetting` in all
  16 files).

## Done criteria

Machine-checkable. ALL must hold (when the decision is `subtle` or `off`):

- [ ] A bead records the human decision; its ID is referenced in the commit(s)
- [ ] `grep -n 'default: "full"' packages/coding-agent/src/config/settings-schema.ts` shows NO hit inside the `display.animations` block (lines ~936-953)
- [ ] `grep -rln 'return "full"' packages/coding-agent/src/*/index.ts` → no matches
- [ ] `bun --cwd=packages/coding-agent run check` exits 0
- [ ] `bun --cwd=packages/animation run check` exits 0
- [ ] `bun test packages/animation/test/animation-kit.test.ts` → all pass
- [ ] `docs/settings.md` lines 561 + 580 show the decided default
- [ ] CHANGELOG Unreleased/Changed entry present
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

(When the decision is `full`: the only done criterion is the recorded decision
bead + the `plans/README.md` row marked `DONE (decision: keep full)`.)

## STOP conditions

Stop and report back (do not improvise) if:

- **No human-recorded sign-off exists naming the chosen tier.** File the bead
  per Step 1 and stop. Under no circumstances change the default on your own
  judgment — this is the plan's core rule.
- The `display.animations` block is no longer at
  `settings-schema.ts:936-953` or its default is no longer `"full"` (someone
  already decided/changed it — reconcile with the bead before touching it).
- Fewer or more than 16 files match
  `grep -rln "function readMotionSetting" packages/coding-agent/src/` (the
  widget family changed since planning; re-derive the list, and if any file's
  helper differs from the quoted shape, stop).
- `bun --cwd=packages/coding-agent run check` fails twice after a reasonable
  fix attempt.
- Any fix appears to require touching `packages/animation/src/motion-policy.ts`
  or a controller/widget file.

## Maintenance notes

- **This plan is a `bd human` candidate**: the entire value is the recorded
  product decision. Reviewers should scrutinize that the shipped default
  matches the bead, and that docs + CHANGELOG say the same word.
- `packages/animation/src/motion-policy.ts:77` keeps a `= "full"` constructor
  convenience default. All production callers pass the setting explicitly, and
  the animation package cannot see the settings schema. If a caller is ever
  added that relies on the constructor default, align it with the schema
  default then (deliberately deferred here — cross-package coupling for a
  dead-in-practice path).
- If a future release wants per-widget tiers or a first-run "animations are
  new, pick a tier" prompt, this plan's single-setting gate is the anchor —
  discoverability concerns from choosing `subtle`/`off` should be solved
  there, not by flipping the default back silently.
- The `ui.description` in the schema and `docs/settings.md:580` both duplicate
  the gating prose ("always forced off outside a TTY..."); keep them in sync
  on future edits.
