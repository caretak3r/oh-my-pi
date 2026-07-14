import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import { bloomGlyph, bloomIntensity, filledCellCount } from "./bloom";
import type { DiffBloomPhase, DiffBloomSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — added/removed diff coloring plus foreground dimming. */
export type DiffBloomTheme = Pick<Theme, "fg">;

/** Fixed width used only for the motion-`off` static fallback, which has no real terminal width to size against. */
export const STATIC_BLOOM_WIDTH = 40;

const RESTING_GLYPH = "·";

/**
 * Pure renderer for one Diff Bloom row at `elapsedMs` since the triggering
 * `edit` `tool_result`. `full` tier splits the row into an added segment
 * (growing inward from the left) and a removed segment (growing inward from
 * the right), each filled proportionally to the edit's normalized line
 * count at the current bloom intensity. `subtle` collapses both to a single
 * centered glyph colored by whichever side dominates. Deterministic given
 * its numeric inputs — no wall-clock reads.
 */
export function renderDiffBloomRow(
	elapsedMs: number,
	width: number,
	theme: DiffBloomTheme,
	added: number,
	removed: number,
	tier: "full" | "subtle",
): string {
	if (width <= 0) return "";
	const intensity = bloomIntensity(elapsedMs);
	if (intensity <= 0) return renderDiffBloomIdleRow(width, theme);
	const glyph = bloomGlyph(intensity);
	const dominant = added >= removed ? "toolDiffAdded" : "toolDiffRemoved";

	if (tier === "subtle") {
		if (width === 1) return theme.fg(dominant, glyph);
		const center = Math.floor((width - 1) / 2);
		const before = RESTING_GLYPH.repeat(center);
		const after = RESTING_GLYPH.repeat(width - center - 1);
		return theme.fg("dim", before) + theme.fg(dominant, glyph) + theme.fg("dim", after);
	}

	const leftWidth = Math.floor(width / 2);
	const rightWidth = width - leftWidth;
	const addedCells = filledCellCount(added, leftWidth, intensity);
	const removedCells = filledCellCount(removed, rightWidth, intensity);

	const left: string[] = [];
	for (let i = 0; i < leftWidth; i++) {
		const filled = i >= leftWidth - addedCells;
		left.push(filled ? theme.fg("toolDiffAdded", glyph) : theme.fg("dim", RESTING_GLYPH));
	}
	const right: string[] = [];
	for (let i = 0; i < rightWidth; i++) {
		const filled = i < removedCells;
		right.push(filled ? theme.fg("toolDiffRemoved", glyph) : theme.fg("dim", RESTING_GLYPH));
	}
	return left.join("") + right.join("");
}

/** The byte-identical resting frame: plain dim dots, no bloom anywhere — used for the idle phase and as the wipe's landing frame. */
export function renderDiffBloomIdleRow(width: number, theme: DiffBloomTheme): string {
	if (width <= 0) return "";
	return theme.fg("dim", RESTING_GLYPH.repeat(width));
}

/** Static one-line fallback for the motion-`off` tier: the most recent bloom's path and added/removed counts. */
export function renderDiffBloomOffText(
	snapshot: Pick<DiffBloomSnapshot, "path" | "added" | "removed" | "bloomCount">,
): string {
	if (snapshot.bloomCount === 0) return "no edits yet";
	return `🌸 ${snapshot.path ?? "edit"} +${snapshot.added}/-${snapshot.removed}`;
}

/** Minimal clock seam the widget needs — shared with the controller so trigger timestamps and render reads agree. */
export type DiffBloomClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface DiffBloomWidgetState {
	readonly phase: DiffBloomPhase;
	bloomElapsedMs(now: number): number;
	settleIfDone(now: number): boolean;
	snapshot(): DiffBloomSnapshot;
}

export interface DiffBloomWidgetOptions extends AnimatedWidgetOptions {
	state: DiffBloomWidgetState;
	theme: DiffBloomTheme;
	/** Same clock the controller stamps trigger timestamps with — NOT the host's internal relative elapsed-ms. */
	clock: DiffBloomClock;
	/**
	 * Invoked exactly once, from {@link onFrame}, on the `blooming` -> `idle`
	 * transition. The controller uses this to dispose the animated host and
	 * remove the widget entirely — a settled bloom carries zero subscriptions
	 * and no lingering visual, matching Reflection Ripple's "felt, not seen"
	 * ambient framing for something that only ever fires briefly.
	 */
	onSettled: () => void;
}

/**
 * Ambient widget for Diff Bloom. Render-backpressure is wired into the
 * {@link AnimationHost} directly (constructed by the controller), which
 * time-skips frame emission while under pressure — this widget's `onFrame`
 * simply never fires during a skipped frame, so the bloom freezes in place
 * and resumes from the correct wall-clock phase once pressure clears. Each
 * frame it checks whether the bloom just finished wiping clear. Reads {@link
 * DiffBloomClock} rather than `this.elapsedMs` for the same dual-clock-seam
 * reason as every other Wave 2 widget: the host's relative elapsed-ms is
 * anchored to whenever the host's first subscriber attached, not to the
 * triggering event, so bloom-phase math needs its own shared clock seam.
 */
export class DiffBloomWidget extends AnimatedWidget {
	#state: DiffBloomWidgetState;
	#theme: DiffBloomTheme;
	#policy: MotionPolicy;
	#clock: DiffBloomClock;
	#onSettled: () => void;

	constructor(options: DiffBloomWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#onSettled = options.onSettled;
	}

	onFrame(_elapsedMs: number): void {
		if (this.#state.settleIfDone(this.#clock.now())) {
			this.#onSettled();
		}
	}

	renderFrame(width: number): readonly string[] {
		if (this.#policy.tier === "off") {
			// Off tier is a hard no-op: fully static regardless of bloom phase.
			return [renderDiffBloomIdleRow(width, this.#theme)];
		}
		if (this.#state.phase === "idle") {
			return [renderDiffBloomIdleRow(width, this.#theme)];
		}
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		const elapsed = this.#state.bloomElapsedMs(this.#clock.now());
		const snapshot = this.#state.snapshot();
		return [renderDiffBloomRow(elapsed, width, this.#theme, snapshot.added, snapshot.removed, tier)];
	}
}
