# Plan 007: Bound per-frame feature work to visible output, not session history

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e7466a84f..HEAD -- packages/tui/src/components/editor.ts packages/coding-agent/src/prompt-charge packages/coding-agent/src/modes/theme/spinner-packs.ts packages/coding-agent/src/modes/controllers/event-controller.ts packages/coding-agent/src/session-bonsai packages/coding-agent/src/extensibility/extensions/types.ts packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 004 rewrites the prompt-charge
> controller's mount plumbing — the `onFrame` poll this plan fixes survives
> that rewrite; reconcile line numbers, not intent.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none (soft: benefits from plans/004-shared-family-clock.md; execute after it to avoid merge friction in prompt-charge)
- **Category**: perf
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

Backpressure decides WHETHER a frame is delivered; once delivered, feature work
is synchronous and unbudgeted, and three animations do work proportional to
unbounded user/model/session data instead of visible output. Prompt Charge
rebuilds the entire editor buffer into a fresh string up to 30 times per second
just to read its length. Spinner packs walk the full working message — whose
text is model-supplied with no length cap — code point by code point, emitting
gradient escapes, at 30fps, before the loader truncates to terminal width.
Session Bonsai keeps a spawn timestamp for every node id ever seen and
collects-and-sorts ALL leaves every frame before capping the display at 5.
Each is a small fix; together they make per-frame cost track what is on screen.

## Current state

### A. Prompt Charge polls by rebuilding the buffer

`packages/coding-agent/src/prompt-charge/widget.ts:127-129`:

```ts
	onFrame(_elapsedMs: number): void {
		this.#state.sampleEditorLength(this.#getEditorText().length);
	}
```

`#getEditorText` is `ExtensionContext.ui.getEditorText`
(`prompt-charge/index.ts:24`), implemented as
`() => this.ctx.editor.getText()`
(`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:82`),
and `getText` joins every line into a new string
(`packages/tui/src/components/editor.ts:1541-1543`):

```ts
	getText(): string {
		return this.#state.lines.join("\n");
	}
```

Editor state is `lines: string[]` (`editor.ts:335`). The consumer only needs
the character count (`PromptChargeState.sampleEditorLength`,
`prompt-charge/state.ts:32-34`, clamps and stores a number). Summing line
lengths is O(number of lines) with zero allocation and equals
`getText().length` exactly (`join("\n")` adds `lines.length - 1` separators).
`ExtensionUIContext.getEditorText` is declared at
`extensibility/extensions/types.ts:236`.

### B. Spinner packs colorize the full, uncapped message every frame

Per-code-point gradient loop
(`packages/coding-agent/src/modes/theme/spinner-packs.ts:300-302` and
`:312-338`, abbreviated):

```ts
function codePoints(text: string): string[] {
	return Array.from(text);
}
...
export function colorizeAtPhase(pack, text, phase, capabilities): string {
	if (!capabilities.color) return text;
	const chars = codePoints(text);
	const n = chars.length;
	...
	for (let i = 0; i < n; i++) {
		const t = frac((i / denom) * pack.wraps - phase);
		const rgb = sampleGradient(pack.stops, t);
		const seq = capabilities.trueColor ? trueColorEscape(rgb) : ansi256Escape(rgb);
		...
		out += chars[i];
	}
	return out + FG_RESET;
}
```

Called on every animated loader repaint via the `colorize` closure
(`spinner-packs.ts:389-397`, `animated` flag at `:398-400`). The loader
colorizes BEFORE truncating to width
(`packages/tui/src/components/loader.ts:94` builds
`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`; the
width-truncation happens afterwards in `render`, `loader.ts:42-48` via
`sliceByColumn`). And the message is the model-supplied intent with no length
cap (`packages/coding-agent/src/modes/controllers/event-controller.ts:297-306`):

```ts
	#updateWorkingMessageFromIntent(intent: unknown): void {
		if (this.ctx.session.isAborting) return;
		...
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}
```

### C. Session Bonsai: unbounded map + full sort per frame

`packages/coding-agent/src/session-bonsai/state.ts:24-51` — `#spawnAt` only
grows (`set` at `:40`, no `delete` anywhere):

```ts
export class BonsaiState {
	#spawnAt = new Map<string, number>();
	...
	update(roots: readonly RawTreeNode[], activeLeafId: string | null, elapsedMs: number): boolean {
		const nextTree = buildBonsaiTree(roots, activeLeafId);
		...
		const visit = (nodes: readonly BonsaiNode[]): void => {
			for (const node of nodes) {
				if (!this.#spawnAt.has(node.id)) {
					this.#spawnAt.set(node.id, isBaseline ? elapsedMs - UNFURL_DURATION_MS : elapsedMs);
					changed = true;
				}
				visit(node.children);
			}
		};
		visit(nextTree);
		...
```

Every frame, the widget re-prunes from scratch
(`session-bonsai/widget.ts:116-119` calls `renderBonsaiTree`, which calls
`pruneForDisplay` at `widget.ts:58`), and `pruneForDisplay`
(`session-bonsai/tree.ts:107-128`) collects ALL leaf ids and sorts them:

```ts
	const allLeafIds = collectLeafIds(nodes);
	if (allLeafIds.length <= MAX_DISPLAYED_LEAVES) return { nodes, hiddenLeaves: 0 };
	...
	const bySpawnDesc = allLeafIds
		.map((id, index) => ({ id, index, spawn: spawnAt.get(id) ?? Number.NEGATIVE_INFINITY }))
		.sort((a, b) => b.spawn - a.spawn || a.index - b.index);
```

(`MAX_DISPLAYED_LEAVES = 5`, `tree.ts:86`.) The tree, active leaf, and
`spawnAt` change ONLY inside `state.update()` — which runs per
`session_branch`/`session_tree` EVENT (`session-bonsai/controller.ts:115-118`),
not per frame. The only per-frame variance in the render is glyph choice from
`elapsedMs` (growth/shimmer). So the prune result can be computed once per
`update()` and cached; the per-frame path then renders a ≤(5-leaf) tree.

### Conventions

Bun; `logger` not `console`; ES `#private`; behavioral tests only;
render/state functions stay PURE of wall-clock — time arrives as an injected
`elapsedMs`/clock (see the doc comments on `renderBonsaiTree`,
`session-bonsai/widget.ts:44-51`, and `PromptChargeState`,
`prompt-charge/state.ts:12-26`; keep that property).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck+lint tui | `bun --cwd=packages/tui run check` | exit 0 |
| Typecheck+lint coding-agent | `bun --cwd=packages/coding-agent run check` | exit 0 |
| All workspaces | `bun run --workspaces --if-present check` | exit 0 |
| Prompt-charge tests | `bun test packages/coding-agent/test/prompt-charge.test.ts` | all pass |
| Spinner tests | `bun test packages/coding-agent/test/modes/theme/spinner-packs.test.ts` | all pass |
| Bonsai tests | `bun test packages/coding-agent/test/session-bonsai.test.ts` | all pass |
| Repo lint | `bun run check:tools` | exit 0 (ignore untracked `packages/coding-agent/scripts/wave2-live-demo.ts`) |

## Scope

**In scope** (the only files you should modify):
- `packages/tui/src/components/editor.ts` (ONE additive accessor next to `getText`)
- `packages/coding-agent/src/extensibility/extensions/types.ts` (one optional member)
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` (one line in the uiContext literal)
- `packages/coding-agent/src/prompt-charge/{index.ts,controller.ts,widget.ts}` + `packages/coding-agent/test/prompt-charge.test.ts`
- `packages/coding-agent/src/modes/theme/spinner-packs.ts` + `packages/coding-agent/test/modes/theme/spinner-packs.test.ts`
- `packages/coding-agent/src/modes/controllers/event-controller.ts` (only `#updateWorkingMessageFromIntent`)
- `packages/coding-agent/src/session-bonsai/{state.ts,tree.ts,widget.ts}` + `packages/coding-agent/test/session-bonsai.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `packages/tui/src/components/loader.ts` — restructuring the loader to
  truncate before colorize changes gradient spread for every colorizer
  (including shimmer) and touches a hot shared component; the caps below make
  it unnecessary.
- Editor internals beyond the one accessor — no caching layers, no `onChange`
  hooks; sum-of-lines is already O(lines).
- Any other feature's per-frame work (token-tide, diff-bloom, …) — measure
  first, separate plan if warranted.
- `session-bonsai/controller.ts` — the per-EVENT full-tree rebuild
  (`toRawTree`, `controller.ts:65-67`) is event-frequency work, not
  frame-frequency; leave it.

## Git workflow

- Branch: `advisor/007-per-frame-budget`
- Conventional Commits, one commit per phase
  (`perf(prompt-charge): ...`, `perf(spinner-packs): ...`, `perf(session-bonsai): ...`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Editor length accessor (tui)

`packages/tui/src/components/editor.ts` — directly below `getText()`
(`:1541-1543`) add:

```ts
	/** Character count of {@link getText}'s result without building the string. */
	getTextLength(): number {
		let length = this.#state.lines.length - 1; // "\n" separators
		for (const line of this.#state.lines) length += line.length;
		return length;
	}
```

Add a behavioral assertion in the tui editor test suite (find it with
`ls packages/tui/test | grep -i editor`; if a dedicated editor test file
exists, extend it; if not, add the check to the closest editor-behavior test):
for a few multi-line fixtures, `editor.getTextLength() === editor.getText().length`.

**Verify**: `bun --cwd=packages/tui run check` → exit 0; the edited test file passes via `bun test <that file>`

### Step 2: Thread the length signal to Prompt Charge

1. `packages/coding-agent/src/extensibility/extensions/types.ts` — next to
   `getEditorText()` (`:236`) add
   `/** Length of getEditorText() without building the string. Optional: fall back to getEditorText().length. */`
   `getEditorTextLength?(): number;`
2. `extension-ui-controller.ts` — in the uiContext literal next to
   `getEditorText` (`:82`): `getEditorTextLength: () => this.ctx.editor.getTextLength(),`
3. `prompt-charge/index.ts` — in `toPromptChargeContext` (`:17-27`):
   `getEditorTextLength: () => ctx.ui.getEditorTextLength?.() ?? ctx.ui.getEditorText().length,`
4. `prompt-charge/controller.ts` — add `getEditorTextLength(): number` to
   `PromptChargeContext` (keep `getEditorText` only if something else still
   uses it; at `e7466a84f` the controller passes it solely to the widget —
   replace it) and hand it to the widget where `getEditorText` is handed today
   (`controller.ts:128,133`).
5. `prompt-charge/widget.ts` — `onFrame` becomes
   `this.#state.sampleEditorLength(this.#getEditorTextLength());`; rename the
   field and option accordingly.

Update `packages/coding-agent/test/prompt-charge.test.ts`: its fake contexts
supply `getEditorText`; switch them to `getEditorTextLength` (mechanical). Add
one behavioral case: a fake whose `getEditorText` throws but whose
`getEditorTextLength` returns N still charges to N — proving the hot path no
longer materializes the string.

**Verify**: `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/prompt-charge.test.ts` → exit 0, all pass

### Step 3: Cap spinner-pack colorization and the intent boundary

1. `spinner-packs.ts` — add
   `/** Gradient work is bounded by what a terminal row can show; beyond this the tail renders plain. */`
   `const MAX_COLORIZED_CODE_POINTS = 256;`
   In `colorizeAtPhase` (`:312-338`): iterate at most
   `Math.min(n, MAX_COLORIZED_CODE_POINTS)` code points for the gradient loop;
   if `n` exceeds the cap, append the REMAINDER of the original string after
   `FG_RESET` unchanged (plain). Keep the gradient spread math (`denom`) based
   on the COLORIZED count so visuals under the cap are byte-identical to today.
   The plain tail is invisible in the loader (truncated to width at
   `loader.ts:42-48`) — the cap only removes work, not visible color, for any
   terminal ≤256 columns of message.
2. `event-controller.ts` `#updateWorkingMessageFromIntent` (`:297-306`) — cap
   the model-supplied intent before it becomes the working message:
   `const capped = trimmed.length > 200 ? \`${trimmed.slice(0, 199)}…\` : trimmed;`
   compare/assign `#lastIntent` with the CAPPED value and pass the capped value
   to `setWorkingMessage`. 200 is a display cap for a one-line status message,
   not a protocol constant — keep it a named module constant with a comment.

Tests in `packages/coding-agent/test/modes/theme/spinner-packs.test.ts`
(model on the existing `colorizeAtPhase` describe at `:54`):
- Output for a message under the cap is byte-identical before/after this change
  (lock one existing expected string).
- For a message of 300 code points: escapes appear only in the first 256; the
  remaining 44 characters appear verbatim after the final reset; the full text
  content (escapes stripped) equals the input.

**Verify**: `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/modes/theme/spinner-packs.test.ts` → exit 0, all pass (2+ new)

### Step 4: Session Bonsai — prune the map, cache the display tree

`packages/coding-agent/src/session-bonsai/state.ts`:
1. In `update()`, collect the live ids during `visit` into a `Set`; after the
   walk, delete every `#spawnAt` key not in the set (nodes removed from the
   session tree no longer pin memory; a deletion also sets `changed = true`
   only if you document why — display does not change for absent nodes, so
   prefer NOT flagging changed for deletions alone).
2. Move the prune to update-time: compute
   `pruneForDisplay(nextTree, activeLeafId, this.#spawnAt)` once at the end of
   `update()` and store `#displayTree` + `#hiddenLeaves`. Extend
   `BonsaiSnapshot` (`state.ts:5-9`) with `displayTree` and `hiddenLeaves`
   (keep `tree` for the off-text renderer `renderBonsaiOffText`,
   `widget.ts:75-80`, which needs total counts).
3. `session-bonsai/widget.ts` — `renderBonsaiTree` (`:52-72`) consumes
   `snapshot.displayTree`/`snapshot.hiddenLeaves` instead of calling
   `pruneForDisplay` per frame. It stays pure: same inputs, same rows.
4. `session-bonsai/tree.ts` — `pruneForDisplay` itself is unchanged (it is
   still the one implementation; it just runs per event now). Do not micro-opt
   the sort: per event with pruned `spawnAt` it is bounded by live leaves.

Tests in `packages/coding-agent/test/session-bonsai.test.ts`:
- Behavioral: after an `update` whose raw tree dropped node ids, a subsequent
  snapshot's `spawnAt` no longer contains them (expose via the existing
  `snapshot()`; it already returns the map).
- Behavioral: render output for a >5-leaf tree is identical before/after the
  caching move (lock the current rendered rows for a fixed snapshot +
  `elapsedMs`).
- Regression: two consecutive `update`s where only the active leaf changes
  still re-prune (active leaf is a prune input — it must be recomputed on
  every update, which it is, since prune now runs inside `update`).

**Verify**: `bun --cwd=packages/coding-agent run check && bun test packages/coding-agent/test/session-bonsai.test.ts packages/coding-agent/test/wave2-gallery.test.ts` → exit 0, all pass

### Step 5: Full sweep

**Verify**: `bun run --workspaces --if-present check` → exit 0

## Test plan

- Editor: `getTextLength() === getText().length` across multi-line fixtures
  (Step 1).
- Prompt Charge: length path works without materializing the buffer (throwing
  `getEditorText` fake, Step 2); existing suite green after the mechanical
  context rename.
- Spinner packs: under-cap byte-identity; over-cap plain tail + content
  preserved (Step 3). Existing determinism/degradation describes stay green.
- Working message: if an existing event-controller/working-message test
  exercises intent updates, extend it with a >200-char intent asserting the
  cap; if none exists, the spinner-pack content test plus typecheck is the
  gate — note that in the report.
- Session Bonsai: spawnAt pruning, render-identity lock, active-leaf re-prune
  (Step 4). Model all new tests on the existing describes in each file.
- Verification: per-step commands plus Step 5.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run --workspaces --if-present check` exits 0
- [ ] `grep -n "getEditorText().length" packages/coding-agent/src/prompt-charge/widget.ts` → no matches
- [ ] `grep -n "getTextLength" packages/tui/src/components/editor.ts` → match present
- [ ] `grep -n "MAX_COLORIZED_CODE_POINTS" packages/coding-agent/src/modes/theme/spinner-packs.ts` → match present
- [ ] `grep -n "pruneForDisplay" packages/coding-agent/src/session-bonsai/widget.ts` → no matches (moved to state update-time)
- [ ] `bun test packages/coding-agent/test/prompt-charge.test.ts packages/coding-agent/test/modes/theme/spinner-packs.test.ts packages/coding-agent/test/session-bonsai.test.ts packages/coding-agent/test/wave2-gallery.test.ts` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  beyond plan-004's documented prompt-charge plumbing rewrite.
- Adding `getTextLength` appears to require touching any editor hot path other
  than adding the one method (e.g. someone proposes caching invalidation hooks
  — out of scope by design).
- Capping the intent or the colorized length changes an existing
  NON-animation loader behavior test (the default `renderWorkingMessage`
  shimmer path must be unaffected; if a shimmer test breaks, the cap landed in
  the wrong layer).
- `colorizeAtPhase` under the cap is NOT byte-identical for the locked
  fixture (the `denom` handling drifted — fix the math, and if two attempts
  fail, stop).
- Session Bonsai's locked render-identity test cannot be made to pass without
  changing rendered output (the caching move must be behavior-preserving).

## Maintenance notes

- If a per-keystroke editor event is ever added to the `ExtensionEvent` union,
  Prompt Charge should switch from per-frame polling to event-driven sampling
  and this plan's accessor becomes a nicety, not a necessity (the state doc
  comment at `prompt-charge/state.ts:12-26` records the polling rationale —
  update it then).
- If terminals wider than `MAX_COLORIZED_CODE_POINTS` columns matter someday,
  plumb the loader's known width into the colorizer instead of raising the
  constant blindly (that is the loader restructuring this plan deliberately
  avoided).
- Reviewer focus: the bonsai `changed`-flag semantics around deletions (must
  not trigger spurious static-mode repaints), and that `BonsaiSnapshot` stays
  an immutable view (the cached `displayTree` must be replaced, not mutated).
- Deferred: a kit-level frame-budget helper (measure per-listener frame cost,
  log offenders via `logger.warn`) — worth a bead only if a fourth offender
  appears; the three fixed here were the measured outliers.
