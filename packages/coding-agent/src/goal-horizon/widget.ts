import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import {
	filledColumnCount,
	flareGlyph,
	flareIntensity,
	HORIZON_BAR_WIDTH,
	type HorizonBucket,
	horizonBucket,
	indeterminatePulse,
	milestoneColumn,
	nearestCrossedMilestone,
} from "./horizon";
import type { GoalHorizonSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type GoalHorizonTheme = Pick<Theme, "fg">;

const EMPTY_GLYPH = "░";
const FILL_GLYPH = "█";

/** Bucket -> theme color, warming from a dim pre-dawn through cool teal/cyan to a hot amber zenith — the sunrise gradient, built from existing {@link ThemeColor} tokens rather than invented raw ANSI colors (Token Tide's `BUCKET_THEME_COLOR` precedent). */
const BUCKET_THEME_COLOR: Readonly<Record<HorizonBucket, ThemeColor>> = {
	predawn: "dim",
	dawn: "syntaxType",
	morning: "syntaxVariable",
	noon: "syntaxFunction",
	zenith: "warning",
};

/** `GoalStatus` overrides that recolor the whole bar regardless of fill position. */
const STATUS_OVERRIDE_COLOR: Readonly<Partial<Record<string, ThemeColor>>> = {
	complete: "success",
	dropped: "dim",
	paused: "dim",
};

/** Flare amplitude at `elapsedMs` for `snapshot`, decayed since its last recorded milestone crossing. Pure. */
function currentFlareAmplitude(snapshot: GoalHorizonSnapshot, elapsedMs: number): number {
	if (snapshot.lastFlareAt === undefined) return 0;
	return flareIntensity(snapshot.lastFlarePeakIntensity, elapsedMs - snapshot.lastFlareAt);
}

function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/**
 * Pure renderer for the determinate (budgeted) bar: cell-by-cell sunrise
 * gradient filled from the left, with a milestone-flare overlay glyph at
 * the most recently crossed threshold's column while it's still decaying.
 * Deterministic given `snapshot` and `elapsedMs` — no wall-clock reads.
 */
export function renderHorizonBar(
	fraction: number,
	elapsedMs: number,
	snapshot: GoalHorizonSnapshot,
	theme: GoalHorizonTheme,
): string {
	const filled = filledColumnCount(fraction, HORIZON_BAR_WIDTH);
	const flareAmplitude = currentFlareAmplitude(snapshot, elapsedMs);
	const flareMilestone = flareAmplitude > 0 ? nearestCrossedMilestone(fraction) : undefined;
	const flareColumn = flareMilestone === undefined ? -1 : milestoneColumn(flareMilestone, HORIZON_BAR_WIDTH);
	const statusColor = snapshot.status ? STATUS_OVERRIDE_COLOR[snapshot.status] : undefined;

	const cells: string[] = [];
	for (let i = 0; i < HORIZON_BAR_WIDTH; i++) {
		if (i === flareColumn) {
			cells.push(theme.fg("warning", flareGlyph(flareAmplitude)));
			continue;
		}
		if (i < filled) {
			const position = (i + 1) / HORIZON_BAR_WIDTH;
			const color = statusColor ?? BUCKET_THEME_COLOR[horizonBucket(position)];
			cells.push(theme.fg(color, FILL_GLYPH));
			continue;
		}
		cells.push(theme.fg("dim", EMPTY_GLYPH));
	}
	return cells.join("");
}

/** Pure renderer for an unbounded goal (no `tokenBudget`): a slow pulsing glyph plus a running token count, since there's no numeric target to fill toward. */
export function renderHorizonIndeterminate(elapsedMs: number, tokensUsed: number, theme: GoalHorizonTheme): string {
	const glyph = flareGlyph(indeterminatePulse(elapsedMs));
	return `${theme.fg("dim", glyph)} ${theme.fg("dim", `${tokensUsed} tok · no budget`)}`;
}

/**
 * Pure renderer: one line combining the sunrise bar (or the indeterminate
 * pulse, for an unbounded goal) with the current percentage and objective.
 * `subtle` tier collapses to a single dominant-bucket glyph and the
 * percentage. Deterministic given `snapshot` and `elapsedMs`.
 */
export function renderGoalHorizonRow(
	snapshot: GoalHorizonSnapshot,
	elapsedMs: number,
	theme: GoalHorizonTheme,
	tier: "full" | "subtle",
): string {
	if (!snapshot.hasGoal) return theme.fg("dim", "no active goal");

	if (snapshot.fraction === undefined) {
		const indeterminate = renderHorizonIndeterminate(elapsedMs, snapshot.tokensUsed, theme);
		return tier === "full" ? `${indeterminate} ${theme.fg("dim", snapshot.objective)}` : indeterminate;
	}

	const percent = theme.fg("dim", formatPercent(snapshot.fraction));
	if (tier === "subtle") {
		const dominant = BUCKET_THEME_COLOR[horizonBucket(snapshot.fraction)];
		return `${theme.fg(dominant, FILL_GLYPH)} ${percent}`;
	}

	const bar = renderHorizonBar(snapshot.fraction, elapsedMs, snapshot, theme);
	return `${bar} ${percent} ${theme.fg("dim", snapshot.objective)}`;
}

/** Static one-line fallback for the motion-`off` tier. */
export function renderGoalHorizonOffText(snapshot: GoalHorizonSnapshot): string {
	if (!snapshot.hasGoal) return "no active goal";
	if (snapshot.fraction === undefined) return `🌅 ${snapshot.objective} — ${snapshot.tokensUsed} tok (no budget)`;
	return `🌅 ${snapshot.objective} ${formatPercent(snapshot.fraction)} (${snapshot.tokensUsed}/${snapshot.tokenBudget} tok)`;
}

/** Minimal clock seam the widget needs — shared with the controller so milestone-flare timestamps and render reads agree. */
export type GoalHorizonClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface GoalHorizonWidgetState {
	snapshot(): GoalHorizonSnapshot;
}

export interface GoalHorizonWidgetOptions extends AnimatedWidgetOptions {
	state: GoalHorizonWidgetState;
	theme: GoalHorizonTheme;
	/** Same clock the controller stamps milestone flares with — NOT the host's internal relative elapsed-ms. */
	clock: GoalHorizonClock;
}

/**
 * Ambient widget for the goal horizon bar. Reads {@link GoalHorizonClock}
 * rather than `this.elapsedMs` for the same reason as every other Wave 2
 * feature: a widget that mounts later than the controller's first recorded
 * event must not have its flare-decay math skewed by the host's own
 * mount-relative clock. `renderFrame` stays pure; the {@link AnimatedWidget}
 * base owns the subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class GoalHorizonWidget extends AnimatedWidget {
	#state: GoalHorizonWidgetState;
	#theme: GoalHorizonTheme;
	#policy: MotionPolicy;
	#clock: GoalHorizonClock;

	constructor(options: GoalHorizonWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return [renderGoalHorizonRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier)];
	}
}
