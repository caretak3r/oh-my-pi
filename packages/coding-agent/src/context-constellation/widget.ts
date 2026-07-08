import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import { formatContextUsage, getContextUsageThemeColor } from "../modes/components/status-line/context-thresholds";
import type { Theme } from "../modes/theme/theme";
import {
	COMET_GLYPH,
	EMPTY_GLYPH,
	FLARE_GLYPH,
	GRID_COLS,
	GRID_ROWS,
	growFlareIntensity,
	lerpCells,
	RANK_OF_CELL,
	STAR_GLYPH,
	SWEEP_DURATION_MS,
	sweepProgress,
} from "./sky";
import type { ConstellationSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type ConstellationTheme = Pick<Theme, "fg">;

/** Displayed lit-cell count at `elapsedMs`: the live sweep interpolation while one is running, otherwise the plain ground-truth count. Pure. */
export function displayedFilledCells(snapshot: ConstellationSnapshot, elapsedMs: number): number {
	const sweep = snapshot.sweep;
	if (!sweep) return snapshot.filledCells;
	const sinceSweep = elapsedMs - sweep.startedAt;
	if (sinceSweep < 0 || sinceSweep >= SWEEP_DURATION_MS) return snapshot.filledCells;
	return lerpCells(sweep.from, sweep.to, sweepProgress(sinceSweep));
}

/**
 * Pure renderer for one row of the sky grid (a slice of {@link RANK_OF_CELL}
 * covering `rowStart..rowStart+GRID_COLS`). In the `full` tier, the newest
 * lit star flares and an in-progress sweep shows a comet-front glyph at its
 * wipe boundary; the `subtle` tier renders plain lit/unlit glyphs with no
 * transient motion. Deterministic given its numeric inputs — no wall-clock
 * reads.
 */
export function renderConstellationRow(
	snapshot: ConstellationSnapshot,
	elapsedMs: number,
	theme: ConstellationTheme,
	tier: "full" | "subtle",
	rowStart: number,
	rowCells: number = GRID_COLS,
): string {
	const color = getContextUsageThemeColor(snapshot.level);
	const displayed = tier === "full" ? displayedFilledCells(snapshot, elapsedMs) : snapshot.filledCells;
	const sweeping =
		tier === "full" && snapshot.sweep !== undefined && elapsedMs - snapshot.sweep.startedAt < SWEEP_DURATION_MS;

	const glyphs: string[] = [];
	for (let col = 0; col < rowCells; col++) {
		const rank = RANK_OF_CELL[rowStart + col] ?? 0;
		if (rank >= displayed) {
			glyphs.push(theme.fg("dim", EMPTY_GLYPH));
			continue;
		}
		if (sweeping && rank === displayed - 1) {
			glyphs.push(theme.fg(color, COMET_GLYPH));
			continue;
		}
		if (tier === "full" && snapshot.lastGrowAt !== undefined && rank === displayed - 1) {
			const sinceGrow = elapsedMs - snapshot.lastGrowAt;
			if (sinceGrow >= 0 && growFlareIntensity(sinceGrow) > 0.5) {
				glyphs.push(theme.fg(color, FLARE_GLYPH));
				continue;
			}
		}
		glyphs.push(theme.fg(color, STAR_GLYPH));
	}
	return glyphs.join(" ");
}

/** Pure renderer for the full sky grid, one row per line. Deterministic given its numeric inputs. */
export function renderConstellationGrid(
	snapshot: ConstellationSnapshot,
	elapsedMs: number,
	theme: ConstellationTheme,
	tier: "full" | "subtle",
): readonly string[] {
	const rows: string[] = [];
	for (let row = 0; row < GRID_ROWS; row++) {
		rows.push(renderConstellationRow(snapshot, elapsedMs, theme, tier, row * GRID_COLS, GRID_COLS));
	}
	return rows;
}

/** Static one-line fallback for the motion-`off` tier: the same percent/window readout the status line already shows. */
export function renderConstellationOffText(snapshot: ConstellationSnapshot): string {
	if (snapshot.contextWindow === 0 && snapshot.tokens === 0) return "✦ context empty";
	return `✦ ${formatContextUsage(snapshot.percent, snapshot.contextWindow, snapshot.tokens)}`;
}

/** Minimal clock seam the widget needs — shared with the controller so grow/sweep timestamps and render reads agree. */
export type ConstellationClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface ConstellationWidgetState {
	snapshot(): ConstellationSnapshot;
}

export interface ConstellationWidgetOptions extends AnimatedWidgetOptions {
	state: ConstellationWidgetState;
	theme: ConstellationTheme;
	/** Same clock the controller stamps grow/sweep events with — NOT the host's internal relative elapsed-ms. */
	clock: ConstellationClock;
}

/**
 * Ambient widget for the context-fill sky grid. Reads {@link ConstellationClock}
 * rather than `this.elapsedMs` for the same reason as every other Wave 2
 * feature: a widget that mounts after the controller's first recorded
 * reading must not have its flare/sweep math skewed by the host's own
 * mount-relative clock. `renderFrame` stays pure; the {@link AnimatedWidget}
 * base owns the subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class ContextConstellationWidget extends AnimatedWidget {
	#state: ConstellationWidgetState;
	#theme: ConstellationTheme;
	#policy: MotionPolicy;
	#clock: ConstellationClock;

	constructor(options: ConstellationWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return renderConstellationGrid(this.#state.snapshot(), this.#clock.now(), this.#theme, tier);
	}
}
