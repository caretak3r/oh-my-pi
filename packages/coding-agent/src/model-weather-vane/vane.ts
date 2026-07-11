import type { ThemeColor } from "../modes/theme/theme";

/**
 * Pure math for Model Weather Vane: a compass emblem whose direction and
 * color are a deterministic hash of the active model's id, spinning through
 * intermediate directions when a mid-session model switch is detected before
 * settling on the new model's emblem. Every function is deterministic given
 * its inputs — no wall-clock reads — so frames stay byte-stable given an
 * injected clock.
 */

/**
 * 32-bit FNV-1a. Hand-rolled (not `Bun.hash`) so the direction/color pairing
 * is stable across Bun versions and byte-stable in behavioral tests —
 * matching the precedent set by Tool Constellation's grid-cell hashing,
 * Agent Fleet's drift-seed hashing, and Context Constellation's scatter fill.
 */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Ordered compass directions the vane points to — N, NE, E, SE, S, SW, W, NW. */
export const DIRECTION_GLYPHS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"] as const;

/**
 * One {@link ThemeColor} per compass direction — "one color per model" per
 * the idea doc — chosen from the existing syntax-highlight token set rather
 * than inventing raw ANSI colors (the `BUCKET_THEME_COLOR` precedent set by
 * Token Tide/Goal Horizon), picking eight visually distinct, vivid tokens.
 */
export const VANE_COLORS: readonly ThemeColor[] = [
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"accent",
] as const;

/** Duration, in ms, a direction/color swap spins before settling on the target model's emblem. */
export const SPIN_DURATION_MS = 700;

/** Maximum characters shown for a model id label before truncation. */
export const MAX_LABEL_LENGTH = 28;

/** Deterministic `[0, DIRECTION_GLYPHS.length)` index for a model id — the emblem's direction+color slot. Pure. */
export function modelDirectionIndex(modelId: string): number {
	return fnv1a(modelId) % DIRECTION_GLYPHS.length;
}

/** The compass glyph a model id's emblem settles on. Pure. */
export function modelDirectionGlyph(modelId: string): string {
	return DIRECTION_GLYPHS[modelDirectionIndex(modelId)];
}

/** The theme color a model id's emblem settles on, paired 1:1 with {@link modelDirectionGlyph} via the same hash slot. Pure. */
export function modelColor(modelId: string): ThemeColor {
	return VANE_COLORS[modelDirectionIndex(modelId)];
}

/** Swap progress in `[0, 1]` at `elapsedMs` since a spin started at `spinStartMs`. Pure, monotonic non-decreasing, clamps to `1` at/after {@link SPIN_DURATION_MS}. */
export function spinProgress(elapsedMs: number, spinStartMs: number): number {
	const elapsed = elapsedMs - spinStartMs;
	if (elapsed <= 0) return 0;
	if (elapsed >= SPIN_DURATION_MS) return 1;
	return elapsed / SPIN_DURATION_MS;
}

/**
 * Direction index the vane displays mid-spin: always sweeps through one full
 * extra loop plus the shortest forward delta from `fromIndex` to `toIndex`,
 * landing exactly on `toIndex` at `progress === 1`. Guarantees a visible spin
 * even when `fromIndex === toIndex` (two different model ids that hash to
 * the same slot still swing all the way around before settling). Pure,
 * `progress` expected in `[0, 1]`.
 */
export function spinDisplayIndex(fromIndex: number, toIndex: number, progress: number): number {
	const slots = DIRECTION_GLYPHS.length;
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
	const forwardDelta = (((toIndex - fromIndex) % slots) + slots) % slots; // in [0, slots)
	const steps = forwardDelta + slots; // one full extra loop + the forward delta
	const traveled = Math.floor(clamped * steps);
	return (fromIndex + traveled) % slots;
}

/** Truncate a model id label to {@link MAX_LABEL_LENGTH}, appending an ellipsis when cut. Pure. */
export function truncateLabel(modelId: string, maxLength: number = MAX_LABEL_LENGTH): string {
	if (modelId.length <= maxLength || maxLength <= 1) return modelId;
	return `${modelId.slice(0, maxLength - 1)}…`;
}
