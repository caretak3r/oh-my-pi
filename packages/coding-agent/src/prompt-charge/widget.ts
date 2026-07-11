import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import {
	BAR_CELLS,
	CHARGE_BUCKET_COLOR,
	chargeBucket,
	chargeFraction,
	filledCells,
	releaseIntensity,
	releaseProgress,
} from "./charge";
import type { PromptChargeSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type PromptChargeTheme = Pick<Theme, "fg">;

/**
 * The fraction the caret glow displays at `now`: the greater of the live
 * typed-charge (from the editor's current character count) and any in-flight
 * release burst's decaying intensity. Taking the max — rather than switching
 * between the two — means a release right after a long prompt still shows
 * the full flash even though the editor clears to empty the instant it
 * submits. Pure.
 */
function displayedFraction(snapshot: PromptChargeSnapshot, now: number): number {
	const live = chargeFraction(snapshot.typedChars);
	if (snapshot.releaseStartAt === undefined) return live;
	const progress = releaseProgress(now, snapshot.releaseStartAt);
	const burst = releaseIntensity(snapshot.chargeAtRelease, progress);
	return Math.max(live, burst);
}

/**
 * Pure renderer: a bolt glyph plus a filled/empty cell bar, colored by the
 * current charge bucket. `full` tier appends the percentage; `subtle`
 * collapses to just the glyph and bar. Deterministic given `snapshot` and
 * `now` — no wall-clock reads.
 */
export function renderPromptChargeRow(
	snapshot: PromptChargeSnapshot,
	now: number,
	theme: PromptChargeTheme,
	tier: "full" | "subtle",
): string {
	const rawFraction = displayedFraction(snapshot, now);
	// `chargeBucket`/`filledCells` already treat NaN as the safe idle default; the
	// percentage text below has no array/bucket lookup to fall back through, so it
	// needs its own guard against rendering a literal "NaN%".
	const fraction = Number.isNaN(rawFraction) ? 0 : rawFraction;
	const color = CHARGE_BUCKET_COLOR[chargeBucket(fraction)];
	const filled = filledCells(fraction);
	const bar = "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled);
	const glyph = theme.fg(color, "⚡");
	const coloredBar = theme.fg(color, bar);

	if (tier === "subtle") return `${glyph} ${coloredBar}`;

	const pct = theme.fg("dim", `${Math.round(fraction * 100)}%`);
	return `${glyph} ${coloredBar} ${pct}`;
}

/**
 * Static one-line fallback for the motion-`off` tier: no theme, no ANSI, no
 * time-based decay (there is no frame clock in this mode — see the
 * controller's off-tier redraw, which only fires on the `input` submit
 * event). Reports the charge captured at the most recent release, or the
 * live typed charge before any submit this session.
 */
export function renderPromptChargeOffText(snapshot: PromptChargeSnapshot): string {
	if (snapshot.releaseStartAt !== undefined) {
		const pct = Math.round(snapshot.chargeAtRelease * 100);
		return pct > 0 ? `⚡ released (${pct}%)` : "⚡ idle";
	}
	const fraction = chargeFraction(snapshot.typedChars);
	if (fraction <= 0) return "⚡ idle";
	return `⚡ ${Math.round(fraction * 100)}% charged`;
}

/** Minimal clock seam the widget needs — shared with the controller so release timestamps and render reads agree. */
export type PromptChargeClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface PromptChargeWidgetState {
	sampleEditorLength(chars: number): void;
	snapshot(): PromptChargeSnapshot;
}

export interface PromptChargeWidgetOptions extends AnimatedWidgetOptions {
	state: PromptChargeWidgetState;
	theme: PromptChargeTheme;
	/** Same clock the controller stamps release starts with — NOT the host's internal relative elapsed-ms. */
	clock: PromptChargeClock;
	/** Pulls the core input editor's current text. Called once per frame tick — the stand-in for the per-keystroke `ExtensionEvent` this codebase does not have. */
	getEditorText: () => string;
}

/**
 * Ambient widget for Prompt Charge. Unlike every other Wave 2 widget, its
 * state mutation does not come from an event handler mutating shared state
 * out of band — there is no per-keystroke event to drive it. Instead
 * `onFrame` itself polls `getEditorText()` every tick and feeds the live
 * character count into the state, riding the same shared `AnimationHost`
 * clock every other ambient Wave 2 widget already subscribes to. Reads
 * {@link PromptChargeClock} rather than `this.elapsedMs` for the same
 * dual-clock-seam reason as every other Wave 2 widget: the host's relative
 * elapsed-ms is anchored to whenever the host's first subscriber attached,
 * not to a release's actual submit time, so release-decay math needs its
 * own shared clock seam. `renderFrame` stays pure.
 */
export class PromptChargeWidget extends AnimatedWidget {
	#state: PromptChargeWidgetState;
	#theme: PromptChargeTheme;
	#policy: MotionPolicy;
	#clock: PromptChargeClock;
	#getEditorText: () => string;

	constructor(options: PromptChargeWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#getEditorText = options.getEditorText;
	}

	onFrame(_elapsedMs: number): void {
		this.#state.sampleEditorLength(this.#getEditorText().length);
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return [renderPromptChargeRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier)];
	}
}
