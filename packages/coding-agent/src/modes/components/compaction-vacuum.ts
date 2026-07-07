import { AnimatedWidget, type AnimatedWidgetOptions } from "@oh-my-pi/pi-animation";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/** The four auto-compaction strategies the runtime can run. */
export type CompactionAction = "context-full" | "handoff" | "shake" | "snapcompact";

/** Human-facing label for each compaction strategy. */
export function compactionActionLabel(action: CompactionAction): string {
	switch (action) {
		case "handoff":
			return "Auto-handoff";
		case "shake":
			return "Auto-shake";
		case "snapcompact":
			return "Auto-snapcompact";
		default:
			return "Auto context-full";
	}
}

/**
 * What a completed compaction preserved, per strategy. Kept honest to the actual
 * mechanics so the settle caption never over-promises: context-full/snapcompact
 * summarize older turns (goals/files/todos survive), shake only trims tool
 * output, handoff starts a fresh context seeded from a summary.
 */
export function compactionKeptCaption(action: CompactionAction): string {
	switch (action) {
		case "shake":
			return "trimmed tool output";
		case "handoff":
			return "handed off to fresh context";
		default:
			return "kept goals, open files, TODOs";
	}
}

/**
 * Compact token display: `142k`, `1.2k`, `812`. Rounds to the nearest 0.1k above
 * 1000 and drops a trailing `.0`. Negative inputs clamp to 0.
 */
export function formatTokensCompact(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	if (n < 1000) return String(n);
	const k = n / 1000;
	const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}k`;
}

export interface CompactionSettleInput {
	action: CompactionAction;
	/** Token count before compaction ran. */
	beforeTokens: number;
	/** Token count after compaction settled (the live post-compaction usage). */
	afterTokens: number;
}

/**
 * Build the persistent settle line shown once a compaction actually reclaimed
 * context. Only emitted for genuine reclamation: when `afterTokens` is not
 * strictly below `beforeTokens` (both known and positive) there is no honest
 * "reclaimed" number to show, so this returns `undefined` and the caller falls
 * back to a plain completion message — never a false or negative reclaim.
 */
export function formatCompactionSettle(input: CompactionSettleInput): string | undefined {
	const before = Math.max(0, Math.round(input.beforeTokens));
	const after = Math.max(0, Math.round(input.afterTokens));
	if (before <= 0 || after <= 0 || after >= before) return undefined;
	const reclaimed = before - after;
	const label = compactionActionLabel(input.action);
	const kept = compactionKeptCaption(input.action);
	return `${label} · ${formatTokensCompact(before)} → ${formatTokensCompact(after)} (−${formatTokensCompact(reclaimed)}, ${kept})`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_CADENCE_MS = 90;
/** Density ramp scrolled through the vacuum lane — sparse → dense toward the funnel. */
const LANE_RAMP = [" ", "·", "∘", "░", "▒", "▓"] as const;
const LANE_WIDTH = 14;
const LANE_SCROLL_MS = 80;
const FUNNEL = "⟩";
const SUMMARY_NODE = "◆";

export interface CompactionVacuumOptions extends AnimatedWidgetOptions {
	/** Strategy driving this compaction, for the inline label. */
	action: CompactionAction;
	/** Token count captured when compaction started (the "before" figure). */
	beforeTokens: number;
	/** Leading reason clause, e.g. `"Context overflow detected, "`. May be empty. */
	reasonText?: string;
	/** Trailing hint, e.g. `" (esc to cancel)"`. May be empty. */
	escHint?: string;
}

/**
 * The in-place condense animation that replaces the opaque auto-compaction
 * freeze. While compaction runs, older transcript is depicted flowing into a
 * summary node — a live, legible signal that the session is being condensed
 * rather than stalled. Purely a function of `elapsedMs`, `width`, and the
 * captured before-token snapshot, so the shared {@link AnimatedWidget} frame
 * loop can diff frames cheaply and the `off` motion tier renders exactly one
 * static frame.
 *
 * Settlement (the real before→after counts + kept caption) is committed to the
 * transcript by the event controller via {@link formatCompactionSettle}; this
 * widget owns only the transient "working" phase, mirroring the loader it
 * replaces.
 */
export class CompactionVacuumWidget extends AnimatedWidget {
	readonly #action: CompactionAction;
	readonly #beforeTokens: number;
	readonly #reasonText: string;
	readonly #escHint: string;

	constructor(options: CompactionVacuumOptions) {
		super(options);
		this.#action = options.action;
		this.#beforeTokens = Math.max(0, Math.round(options.beforeTokens));
		this.#reasonText = options.reasonText ?? "";
		this.#escHint = options.escHint ?? "";
	}

	renderFrame(width: number): readonly string[] {
		const elapsed = this.elapsedMs;
		const spinner = SPINNER_FRAMES[Math.floor(elapsed / SPINNER_CADENCE_MS) % SPINNER_FRAMES.length];
		const lane = this.#renderLane(elapsed);
		const before = formatTokensCompact(this.#beforeTokens);
		const label = `${this.#reasonText}${compactionActionLabel(this.#action)}`;
		const line =
			`${theme.fg("accent", spinner)} ${theme.fg("muted", `${label} · condensing`)} ` +
			`${theme.fg("dim", before)} ${lane} ${theme.fg("accent", SUMMARY_NODE)}` +
			`${theme.fg("dim", this.#escHint)}`;
		return [truncateToWidth(line, Math.max(1, width))];
	}

	/** The scrolling density lane: transcript being drawn toward the funnel. */
	#renderLane(elapsedMs: number): string {
		const scroll = Math.floor(elapsedMs / LANE_SCROLL_MS);
		let cells = "";
		for (let x = 0; x < LANE_WIDTH; x++) {
			// Scroll the density ramp toward the funnel (right edge); cells nearer the
			// funnel read denser, giving the "sucked in and compacted" motion.
			const idx = (((x + scroll) % LANE_RAMP.length) + LANE_RAMP.length) % LANE_RAMP.length;
			cells += LANE_RAMP[idx];
		}
		return `${theme.fg("muted", cells)}${theme.fg("accent", FUNNEL)}`;
	}
}
