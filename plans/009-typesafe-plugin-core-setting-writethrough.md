# Plan 009: Validate plugin→core setting write-through instead of casting around the typed settings API

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e7466a84f..HEAD -- packages/coding-agent/src/extensibility/plugins/manager.ts packages/coding-agent/test/plugin-mapped-settings.test.ts`
> If `manager.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but see Test plan: write tests default-agnostic so this
  never couples to plan 008's possible change of the `display.animations` default)
- **Category**: tech-debt
- **Planned at**: commit `e7466a84f`, 2026-07-24

## Why this matters

Plugin settings can declare `mapsTo: "<core setting path>"` so a plugin
setting mirrors a core setting (one source of truth — that design is correct
and stays). But the write path erases the typed settings API with
`settings.set as unknown as (path, value) => void`, and `Settings.set` itself
performs **no runtime validation** (verified — see "Current state"). So a
plugin manifest declaring a bad `mapsTo` target, a bad `mapsToTrue`/
`mapsToFalse`, or an out-of-schema value writes garbage straight into a core
setting, persisted to the user's global config — and the cast hides all of it
from the typechecker. Worse, a `mapsTo` naming a nonexistent core path makes
the *read* path (`readMappedCoreValue` → `settings.get`) throw a `TypeError`,
crashing `getPluginSettings`. This plan adds runtime validation at the
write-through boundary, guards the read, and shrinks the cast to a
post-validation value cast — with the invalid case falling back to the
plugin-config store plus a `logger.warn` instead of corrupting core config.

## Current state

All in `packages/coding-agent/src/extensibility/plugins/manager.ts` unless
noted. Line numbers verified at commit `e7466a84f`.

- Imports (manager.ts:14):

  ```ts
  import { isSettingsInitialized, type SettingPath, settings } from "../../config/settings";
  ```

  `logger` is already imported from `@oh-my-pi/pi-utils` (manager.ts:12), used
  as e.g. `logger.warn("Failed to load plugin runtime config", { path: lockPath, error: String(err) })`
  (manager.ts:178). Match that call shape.

- The read helper (manager.ts:116–131):

  ```ts
  /**
   * Read the core setting a mapped plugin setting mirrors, coerced back to the
   * plugin setting's own type. Returns `undefined` when the schema is unmapped or
   * the core settings singleton is not initialized (e.g. some CLI contexts).
   */
  function readMappedCoreValue(schema: PluginSettingSchema): unknown {
  	if (!schema.mapsTo || !isSettingsInitialized()) return undefined;
  	const core = settings.get(schema.mapsTo as SettingPath) as unknown;
  	if (schema.type === "boolean") {
  		const off = schema.mapsToFalse ?? false;
  		return core !== off;
  	}
  	return core;
  }
  ```

- The write helper with the offending cast (manager.ts:133–154; the cast is
  line 141):

  ```ts
  /**
   * Write a mapped plugin setting through to its core setting so both share one
   * source of truth. Returns `true` when the write was routed to core, `false`
   * when the setting is unmapped or core settings are unavailable (caller then
   * falls back to the plugin-config store).
   */
  function writeMappedCoreValue(schema: PluginSettingSchema, value: unknown): boolean {
  	if (!schema.mapsTo || !isSettingsInitialized()) return false;
  	const key = schema.mapsTo as SettingPath;
  	const set = settings.set as unknown as (path: SettingPath, value: unknown) => void;
  	if (schema.type === "boolean") {
  		const on = value === true || value === "true";
  		if (on) {
  			const off = schema.mapsToFalse ?? false;
  			if (settings.get(key) === off) set(key, schema.mapsToTrue ?? true);
  		} else {
  			set(key, schema.mapsToFalse ?? false);
  		}
  	} else {
  		set(key, value);
  	}
  	return true;
  }
  ```

  Boolean semantics to preserve exactly: turning ON only writes
  `mapsToTrue ?? true` when the core value currently equals
  `mapsToFalse ?? false` (so a richer already-on state like `"subtle"` is not
  clobbered), but still returns `true` (routed); turning OFF always writes
  `mapsToFalse ?? false`; `value === "true"` string coercion counts as on.

- Callers (same file): `getPluginSettings` overlays mapped reads at
  manager.ts:882–885 (`const mapped = readMappedCoreValue(schema); if (mapped !== undefined) merged[key] = mapped;`);
  `setPluginSetting` at manager.ts:893–903 — the fallback contract this plan
  relies on already exists:

  ```ts
  async setPluginSetting(name: string, key: string, value: unknown): Promise<void> {
  	const schema = (await this.#settingSchemas(name))[key];
  	if (schema && writeMappedCoreValue(schema, value)) return;
  	// ... falls through: writes config.settings[name][key] = value to the plugin-config store
  ```

  So "reject the write-through" = `return false` from `writeMappedCoreValue`;
  the caller then persists to the plugin store. No caller changes needed.

- **What the settings module exposes (verified — this resolves the planning
  question "is there a validate/coerce helper to reuse?"):** there is NO
  general runtime validator or coercer. `Settings.set`
  (`packages/coding-agent/src/config/settings.ts:382–397`) is compile-time
  typed (`set<P extends SettingPath>(path: P, value: SettingValue<P>)`) and
  writes unchecked at runtime. But the schema module exports enough primitives
  to build a small local validator (~20 lines) in manager.ts:
  - `SETTINGS_SCHEMA` — the schema object (`settings-schema.ts:336`); key
    membership check gives path validity.
  - `getType(path): SettingDef["type"]` (`settings-schema.ts:5069–5071`) —
    returns `"boolean" | "string" | "number" | "enum" | "array" | "record"`
    (the full `SettingDef` union is at `settings-schema.ts:259–265`).
  - `getEnumValues(path)` (`settings-schema.ts:5074–5077`) — allowed values
    for enum settings, `undefined` otherwise.
  - `SettingValue<P>` type (`settings-schema.ts:5024`).
  - All of these are re-exported through `../../config/settings`
    (`settings.ts:48–49`: `export type * from "./settings-schema"; export * from "./settings-schema";`),
    so manager.ts extends its existing import line — no new import path.

- Why an unknown `mapsTo` crashes reads today: `Settings.get`
  (`settings.ts:357–367`) does
  `getByPath(this.#merged, SETTING_PATH_SEGMENTS[path])`;
  `SETTING_PATH_SEGMENTS` (`settings.ts:93–95`) is built only from
  `Object.keys(SETTINGS_SCHEMA)`, so an unknown path yields `undefined`
  segments and `getByPath` (`settings.ts:82–92`) throws a `TypeError`
  iterating them.

- Plugin schema types (`packages/coding-agent/src/extensibility/plugins/types.ts:56–103`):
  `PluginSettingBase.mapsTo?: string` (plain string — nothing constrains it to
  a real core path), `BooleanSetting.mapsToTrue?: unknown` /
  `mapsToFalse?: unknown`, union `PluginSettingSchema = StringSetting | NumberSetting | BooleanSetting | EnumSetting`.

- Test scaffolding that exists (no test covers `mapsTo` today — verified by
  `grep -rn "mapsTo" packages/coding-agent/test/` → no hits):
  - Structural pattern for manager tests: `packages/coding-agent/test/plugin-config.test.ts`
    (tmp dir + `spyOn(piUtils, ...)` path getters + lockfile JSON + `mock.restore()`
    and `removeWithRetries(tmpRoot)` in `afterEach`).
  - Fuller spy block covering node_modules/package.json getters:
    `packages/coding-agent/test/plugin-install-local.test.ts:57–62` (spies
    `getPluginsDir`, `getPluginsNodeModules`, `getPluginsPackageJson`,
    `getPluginsLockfile`, `getProjectDir`, `getProjectPluginOverridesPath`).
  - Global settings singleton in tests: `await Settings.init({ agentDir, inMemory: true })`
    (see `packages/coding-agent/test/acp-agent.test.ts:450`) and
    `resetSettingsForTest()` (`settings.ts:1526`) to tear down.
  - How `PluginManager.list()` discovers a plugin (manager.ts:684–730): reads
    `getPluginsPackageJson()` for a `dependencies` map, then for each name
    reads `<getPluginsNodeModules()>/<name>/package.json` and takes the
    manifest from its `omp` (or legacy `pi`) field — so a fake installed
    plugin is just two JSON files under the temp plugins dir. A missing
    marketplace registry file is handled (try/catch returning an empty
    registry — `marketplace/registry.ts:107+`).

- Conventions: Bun runtime; `logger`, never `console`; ES `#private`;
  behavioral tests only; Conventional Commits (e.g.
  `fix(plugins): drain subprocess pipes concurrently with proc.exited`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck+lint (coding-agent) | `bun --cwd=packages/coding-agent run check` | exit 0 (ignore any complaint about untracked scratch file `packages/coding-agent/scripts/wave2-live-demo.ts`) |
| New tests | `bun test packages/coding-agent/test/plugin-mapped-settings.test.ts` | all pass |
| Existing manager tests | `bun test packages/coding-agent/test/plugin-config.test.ts` | all pass |
| Repo lint | `bun run check:tools` | exit 0 |

## Scope

**In scope** (the only files you may modify/create):
- `packages/coding-agent/src/extensibility/plugins/manager.ts` — only the
  import line (14), `readMappedCoreValue` (116–131), `writeMappedCoreValue`
  (133–154), plus the two new module-private helpers beside them.
- `packages/coding-agent/test/plugin-mapped-settings.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/coding-agent/src/config/settings.ts` / `settings-schema.ts` — do
  NOT add a validator there; the boundary being hardened is plugin→core, and
  the schema module already exposes the needed primitives.
- `packages/coding-agent/src/extensibility/plugins/types.ts` — `mapsTo`
  stays a plain `string`; manifests are external data and must be validated
  at runtime anyway.
- `packages/coding-agent/src/modes/components/plugin-settings.ts` (settings
  UI) and `setPluginSetting`/`getPluginSettings` bodies — the existing
  `return false` → plugin-store fallback contract already does the right thing.

## Git workflow

- Branch: `advisor/009-typesafe-plugin-writethrough` (branched from `integration/all-features`)
- One commit, Conventional Commits style, e.g.
  `fix(plugins): validate mapped core-setting writes instead of casting settings.set`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add validation helpers next to the mapped-value helpers

In `manager.ts`, extend import line 14 to:

```ts
import {
	getEnumValues,
	getType,
	isSettingsInitialized,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
	settings,
} from "../../config/settings";
```

Directly above `readMappedCoreValue` (currently line 116), add two
module-private helpers (match the surrounding comment style — one-line JSDoc,
tabs):

```ts
/** Whether a manifest-supplied `mapsTo` names a real core setting. */
function isKnownSettingPath(path: string): path is SettingPath {
	return path in SETTINGS_SCHEMA;
}

/**
 * Whether `value` is in-schema for the core setting at `key`. Array/record
 * settings are never valid write-through targets — there is no sane mapping
 * from a scalar plugin setting.
 */
function isValidCoreValue(key: SettingPath, value: unknown): boolean {
	switch (getType(key)) {
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "enum":
			return typeof value === "string" && (getEnumValues(key)?.includes(value) ?? false);
		default:
			return false;
	}
}
```

**Verify**: `bun --cwd=packages/coding-agent run check` → exit 0 (helpers may
be momentarily unused — if biome flags unused symbols, proceed to Step 2 and
verify after; the two steps may land as one edit).

### Step 2: Guard the read path and validate the write path

Replace `readMappedCoreValue`'s guard line (manager.ts:123–124) so an unknown
path returns `undefined` instead of throwing, and drop the now-unneeded cast:

```ts
function readMappedCoreValue(schema: PluginSettingSchema): unknown {
	if (!schema.mapsTo || !isSettingsInitialized() || !isKnownSettingPath(schema.mapsTo)) return undefined;
	const core = settings.get(schema.mapsTo) as unknown;
	// ... boolean branch unchanged (lines 125-130)
```

Replace `writeMappedCoreValue` (manager.ts:138–154) with the validated
version. Delete the `const set = settings.set as unknown as ...` line
entirely. Target shape:

```ts
function writeMappedCoreValue(schema: PluginSettingSchema, value: unknown): boolean {
	if (!schema.mapsTo || !isSettingsInitialized()) return false;
	if (!isKnownSettingPath(schema.mapsTo)) {
		logger.warn("Plugin setting maps to unknown core setting; storing in plugin config instead", {
			mapsTo: schema.mapsTo,
		});
		return false;
	}
	const key = schema.mapsTo;
	const resolved =
		schema.type === "boolean"
			? value === true || value === "true"
				? (schema.mapsToTrue ?? true)
				: (schema.mapsToFalse ?? false)
			: value;
	if (schema.type === "boolean" && (value === true || value === "true")) {
		// Only flip on from the off state so a richer already-on core value survives.
		if (settings.get(key) !== (schema.mapsToFalse ?? false)) return true;
	}
	if (!isValidCoreValue(key, resolved)) {
		logger.warn("Plugin setting value is out of schema for its mapped core setting; storing in plugin config instead", {
			mapsTo: key,
			value: resolved,
		});
		return false;
	}
	settings.set(key, resolved as SettingValue<SettingPath>);
	return true;
}
```

Behavioral contract (must hold exactly — the test in Step 3 pins it):
- Unmapped schema or uninitialized settings → `false` (unchanged).
- Unknown `mapsTo` → `false` + one `logger.warn` (new; was a routed write into
  a nonexistent path).
- Boolean ON with core already in a non-off state → `true`, **no write**
  (unchanged).
- Boolean ON from off state → writes `mapsToTrue ?? true`; boolean OFF →
  writes `mapsToFalse ?? false`; either is first validated, invalid →
  `false` + warn (new).
- Non-boolean → value validated against the core setting's type/enum values,
  invalid → `false` + warn (new); valid → written.
- The only remaining cast is the value-level `as SettingValue<SettingPath>`
  after runtime validation (TypeScript cannot statically type a
  runtime-chosen path; the validation is the real gate). The
  function-signature erasure (`settings.set as unknown as ...`) is gone.

**Verify**:
`grep -n "as unknown as" packages/coding-agent/src/extensibility/plugins/manager.ts` → no matches.
`bun --cwd=packages/coding-agent run check` → exit 0.

### Step 3: Write the behavioral test

Create `packages/coding-agent/test/plugin-mapped-settings.test.ts`. Model the
harness on `plugin-config.test.ts` (describe/beforeEach/afterEach shape,
`mock.restore()` + `removeWithRetries`) with the fuller spy block of
`plugin-install-local.test.ts:57–62`, plus global settings init:

```ts
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
```

Setup per test (beforeEach):
1. `tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-mapped-"))`;
   `pluginsDir = path.join(tmpRoot, "plugins")`.
2. Spy `getPluginsDir` → `pluginsDir`, `getPluginsNodeModules` →
   `path.join(pluginsDir, "node_modules")`, `getPluginsPackageJson` →
   `path.join(pluginsDir, "package.json")`, `getPluginsLockfile` →
   `path.join(pluginsDir, "omp-plugins.lock.json")`, `getProjectDir` →
   `tmpRoot`, `getProjectPluginOverridesPath` →
   `path.join(tmpRoot, "plugin-overrides.json")`.
3. `await Settings.init({ agentDir: path.join(tmpRoot, "agent"), inMemory: true })`.
4. Write the fake installed plugin (helper taking the manifest `settings`
   record):
   - `<pluginsDir>/package.json`: `{ "dependencies": { "test-plugin": "1.0.0" } }`
   - `<pluginsDir>/node_modules/test-plugin/package.json`:
     `{ "name": "test-plugin", "version": "1.0.0", "omp": { "version": "1.0.0", "settings": { ...per-test schema... } } }`
   - `<pluginsDir>/omp-plugins.lock.json`:
     `{ "plugins": { "test-plugin": { "version": "1.0.0", "enabledFeatures": null, "enabled": true } }, "settings": {} }`

Teardown (afterEach): `mock.restore()`, `resetSettingsForTest()`,
`await removeWithRetries(tmpRoot)`.

Test cases (each sets `settings.set("display.animations", "full")` — or the
starting tier the case needs — explicitly first, so assertions never depend on
the schema default, which plan 008 may change):

1. **valid mapped enum write routes to core**: schema
   `{ motion: { type: "enum", values: ["full", "subtle", "off"], mapsTo: "display.animations" } }`;
   `setPluginSetting("test-plugin", "motion", "subtle")` →
   `settings.get("display.animations") === "subtle"`; lockfile JSON's
   `settings["test-plugin"]` does not contain `motion`;
   `getPluginSettings("test-plugin")` resolves with `motion: "subtle"`.
2. **out-of-schema mapped value falls back to the plugin store** (the
   regression this plan exists for): same schema but plugin declares
   `values: ["warp-speed"]`; `setPluginSetting("test-plugin", "motion", "warp-speed")`
   does not throw → `settings.get("display.animations")` still `"full"`;
   lockfile `settings["test-plugin"].motion === "warp-speed"`.
3. **unknown `mapsTo` neither crashes writes nor reads**: schema
   `{ broken: { type: "string", mapsTo: "not.a.real.setting" } }`;
   `setPluginSetting("test-plugin", "broken", "x")` resolves;
   `await getPluginSettings("test-plugin")` resolves (no `TypeError`) with
   `broken: "x"` from the store.
4. **boolean mapsToTrue/mapsToFalse semantics preserved**: schema
   `{ anims: { type: "boolean", mapsTo: "display.animations", mapsToTrue: "full", mapsToFalse: "off" } }`;
   from core `"off"`: set `true` → core `"full"`; set `false` → core `"off"`;
   from core `"subtle"`: set `true` → core stays `"subtle"` (already-on state
   not clobbered), and `getPluginSettings` reports `anims: true`.

**Verify**: `bun test packages/coding-agent/test/plugin-mapped-settings.test.ts`
→ 4 tests, all pass. Then delete/re-run to confirm determinism if flaky-looking.

### Step 4: Full gate

**Verify**:
- `bun --cwd=packages/coding-agent run check` → exit 0
- `bun test packages/coding-agent/test/plugin-mapped-settings.test.ts packages/coding-agent/test/plugin-config.test.ts` → all pass
- `bun run check:tools` → exit 0

## Test plan

Covered by Step 3: one new behavioral test file
`packages/coding-agent/test/plugin-mapped-settings.test.ts` with the 4 cases
listed there (happy-path write-through; out-of-schema value fallback — the
bug this plan fixes; unknown-`mapsTo` crash guard on read+write; boolean
mapsToTrue/mapsToFalse regression pin). Structural pattern:
`packages/coding-agent/test/plugin-config.test.ts`. Asserting the
`logger.warn` calls is optional — the load-bearing assertions are core-setting
integrity and store fallback; only add a `spyOn(piUtils.logger, "warn")` if it
works without fighting the logger's shape.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "as unknown as" packages/coding-agent/src/extensibility/plugins/manager.ts` → no matches
- [ ] `bun --cwd=packages/coding-agent run check` exits 0
- [ ] `bun test packages/coding-agent/test/plugin-mapped-settings.test.ts` → 4 new tests pass
- [ ] `bun test packages/coding-agent/test/plugin-config.test.ts` → still passes
- [ ] `bun run check:tools` exits 0
- [ ] `git status` shows no modified files outside the two in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `readMappedCoreValue`/`writeMappedCoreValue` no longer match the excerpts at
  manager.ts:116–154 (drift — e.g. someone already validated the write path).
- `getType`, `getEnumValues`, or `SETTINGS_SCHEMA` are NOT importable from
  `"../../config/settings"` (the re-export at `settings.ts:48–49` changed) —
  report what the settings module exposes instead; do not reach into
  `settings-schema.ts` by a new import path without noting it.
- The Step 3 scaffolding cannot get `PluginManager.list()` to return the fake
  plugin after mirroring `plugin-install-local.test.ts:57–62` exactly (the
  discovery path changed) — report which spy/file the manager actually reads.
- A verification fails twice after a reasonable fix attempt.
- Fixing the write path appears to require modifying `setPluginSetting`,
  `getPluginSettings`, or anything in `config/settings*.ts`.

## Maintenance notes

- Reviewers should scrutinize the boolean branch hardest: the
  "already-on state survives a redundant ON" behavior is easy to lose in the
  rewrite; test case 4 pins it.
- The remaining `as SettingValue<SettingPath>` cast is deliberate and
  localized: a runtime-chosen path cannot be statically narrowed, and the
  runtime validator is the actual gate. Do not "fix" it back to a
  function-signature cast.
- If plugin manifests later gain install-time validation (checking `mapsTo`
  against `SETTINGS_SCHEMA` when a plugin is installed/listed), these runtime
  guards stay — manifests can change on disk between install and use.
- Array/record core settings are deliberately unreachable via `mapsTo`
  (validator returns `false`). If a plugin ever legitimately needs to map onto
  one, that needs a real coercion design, not a relaxed validator.
- Follow-up explicitly deferred: `plugin-settings.ts` (settings UI) trusts the
  same manifest schemas for rendering; a bad manifest can still render a
  nonsensical control — cosmetic, not corrupting, so out of scope here.
