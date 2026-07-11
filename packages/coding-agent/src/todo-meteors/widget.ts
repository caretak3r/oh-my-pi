import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import {
	combineBrightness,
	emberGlyph,
	emberRestBrightness,
	meteorColumn,
	meteorGlyph,
	meteorProgress,
	urgencyPulse,
} from "./ember";
import type { TodoMeteorsSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type TodoMeteorsTheme = Pick<Theme, "fg">;

/** Cap on embers drawn per row before collapsing the rest into a "+N" trailer, so a large todo list still fits a thin `aboveEditor` strip. */
const MAX_EMBERS_SHOWN = 12;
/** Width, in columns, of the meteor arc lane. */
const METEOR_LANE_WIDTH = 24;

/**
 * Pure renderer: the ember horizon for one frame, plus (full tier only) a
 * lane of any in-flight completion meteors. `full` animates the urgency
 * pulse and meteor arcs; `subtle` renders embers at resting brightness with
 * no pulse and no meteor lane — a completion's only subtle-tier signal is
 * its ember disappearing on the next update. Deterministic given `snapshot`
 * and `elapsedMs` — no wall-clock reads.
 */
export function renderTodoMeteorsRow(
	snapshot: TodoMeteorsSnapshot,
	elapsedMs: number,
	theme: TodoMeteorsTheme,
	tier: "full" | "subtle",
): readonly string[] {
	const shown = snapshot.embers.slice(0, MAX_EMBERS_SHOWN);
	const hidden = snapshot.embers.length - shown.length;
	const pulse = tier === "full" ? urgencyPulse(snapshot.attempt, snapshot.maxAttempts, elapsedMs) : 0;

	const emberGlyphs = shown.map(ember => {
		const brightness = combineBrightness(emberRestBrightness(ember.status), pulse);
		const glyph = emberGlyph(brightness);
		return theme.fg(ember.status === "in_progress" ? "accent" : "dim", glyph);
	});

	let horizon = emberGlyphs.length > 0 ? emberGlyphs.join(" ") : theme.fg("dim", "(no open todos)");
	if (hidden > 0) horizon += theme.fg("dim", ` +${hidden}`);

	const lines = [horizon];
	if (tier === "full" && snapshot.meteors.length > 0) {
		const lane = new Array<string>(METEOR_LANE_WIDTH).fill(" ");
		for (const meteor of snapshot.meteors) {
			const progress = meteorProgress(meteor.launchedAt, elapsedMs);
			lane[meteorColumn(progress, METEOR_LANE_WIDTH)] = meteorGlyph(progress);
		}
		lines.push(theme.fg("success", lane.join("")));
	}
	return lines;
}

/** Static one-line fallback for the motion-`off` tier: `N/M done`, or a bare note before any todos have been tracked. */
export function renderTodoMeteorsOffText(snapshot: TodoMeteorsSnapshot): string {
	if (snapshot.totalCount === 0) return "no todos";
	return `${snapshot.doneCount}/${snapshot.totalCount} done`;
}

/** Minimal clock seam the widget needs — shared with the controller so meteor launch timestamps and render reads agree. */
export type TodoMeteorsClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface TodoMeteorsWidgetState {
	snapshot(): TodoMeteorsSnapshot;
	pruneMeteors(elapsedMs: number): boolean;
}

export interface TodoMeteorsWidgetOptions extends AnimatedWidgetOptions {
	state: TodoMeteorsWidgetState;
	theme: TodoMeteorsTheme;
	/** Same clock the controller stamps meteor launch times with — NOT the host's internal relative elapsed-ms. */
	clock: TodoMeteorsClock;
}

/**
 * Ambient widget for the todo ember horizon. Each frame it prunes any
 * finished meteors (state mutation, in {@link onFrame}) then takes a
 * snapshot and draws the row at the current clock reading and live
 * {@link MotionPolicy} tier ({@link renderFrame} stays pure). Deliberately
 * reads {@link TodoMeteorsClock} rather than `this.elapsedMs` — the host's
 * frame ticks only drive repaint cadence here, not meteor/pulse phase, so
 * mounting later than the controller's first event doesn't skew arc math.
 * The {@link AnimatedWidget} base owns the subscribe-on-mount /
 * unsubscribe-on-dispose lifecycle.
 */
export class TodoMeteorsWidget extends AnimatedWidget {
	#state: TodoMeteorsWidgetState;
	#theme: TodoMeteorsTheme;
	#policy: MotionPolicy;
	#clock: TodoMeteorsClock;

	constructor(options: TodoMeteorsWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	onFrame(_elapsedMs: number): void {
		this.#state.pruneMeteors(this.#clock.now());
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return renderTodoMeteorsRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier);
	}
}
