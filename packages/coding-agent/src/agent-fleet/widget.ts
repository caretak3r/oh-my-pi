import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import { brightnessFor, driftSeed, fireflyGlyph, restBrightness, wobblePhase } from "./firefly";
import type { AgentFleetSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type AgentFleetTheme = Pick<Theme, "fg">;

/** Cap on fireflies drawn before collapsing the rest into a "+N" trailer, so a large fleet still fits a thin strip. */
const MAX_FIREFLIES_SHOWN = 12;

/** Color key for a firefly's status. Reuses `statusLineSubagents` — the same color the existing status-line subagent-count badge already uses — for `working`, so this widget reads as the same concept rather than inventing a competing color. */
function fireflyColor(
	status: AgentFleetSnapshot["fireflies"][number]["status"],
): "statusLineSubagents" | "error" | "dim" {
	if (status === "working") return "statusLineSubagents";
	if (status === "failed") return "error";
	return "dim";
}

/**
 * Pure renderer: one row of fireflies for the current frame. `full` animates
 * each firefly's brightness (breathing while `working`, fading while `done`,
 * blinking while `failed`) and a three-state horizontal wobble within a
 * fixed-width cell — a scoped "drift" that keeps each firefly's slot
 * deterministic rather than a full 2D roaming field. `subtle` renders a
 * fixed dot per firefly at a discrete per-status brightness, no motion.
 * Deterministic given `snapshot` and `elapsedMs` — no wall-clock reads.
 */
export function renderAgentFleetRow(
	snapshot: AgentFleetSnapshot,
	elapsedMs: number,
	theme: AgentFleetTheme,
	tier: "full" | "subtle",
): readonly string[] {
	const shown = snapshot.fireflies.slice(0, MAX_FIREFLIES_SHOWN);
	const hidden = snapshot.fireflies.length - shown.length;
	if (shown.length === 0) return [theme.fg("dim", "(no subagents)")];

	const cells = shown.map(firefly => {
		const elapsedSinceSpawn = elapsedMs - firefly.spawnedAt;
		const elapsedSinceStatusChange = elapsedMs - firefly.statusChangedAt;
		const brightness =
			tier === "full"
				? brightnessFor(firefly.status, elapsedSinceSpawn, elapsedSinceStatusChange)
				: restBrightness(firefly.status);
		const glyph = theme.fg(fireflyColor(firefly.status), fireflyGlyph(brightness));
		if (tier !== "full") return glyph;
		const wobble = wobblePhase(driftSeed(firefly.id), elapsedSinceSpawn);
		return wobble === -1 ? `${glyph}  ` : wobble === 1 ? `  ${glyph}` : ` ${glyph} `;
	});

	let row = cells.join(tier === "full" ? "" : " ");
	if (hidden > 0) row += theme.fg("dim", ` +${hidden}`);
	return [row];
}

/** Static one-line fallback for the motion-`off` tier: a bucketed tally, or a bare note before any subagent has ever been tracked. */
export function renderAgentFleetOffText(snapshot: AgentFleetSnapshot, theme: AgentFleetTheme): string {
	if (snapshot.fireflies.length === 0) return theme.fg("dim", "no subagents");
	const parts: string[] = [];
	if (snapshot.workingCount > 0) parts.push(`${snapshot.workingCount} working`);
	if (snapshot.doneCount > 0) parts.push(`${snapshot.doneCount} done`);
	if (snapshot.failedCount > 0) parts.push(`${snapshot.failedCount} failed`);
	return parts.join(" · ");
}

/** Minimal clock seam the widget needs — shared with the controller so spawn/status timestamps and render reads agree. */
export type AgentFleetClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface AgentFleetWidgetState {
	snapshot(): AgentFleetSnapshot;
	pruneFireflies(elapsedMs: number): boolean;
}

export interface AgentFleetWidgetOptions extends AnimatedWidgetOptions {
	state: AgentFleetWidgetState;
	theme: AgentFleetTheme;
	/** Same clock the controller stamps spawn/status-change times with — NOT the host's internal relative elapsed-ms. */
	clock: AgentFleetClock;
}

/**
 * Ambient widget for the subagent firefly field. Each frame it prunes any
 * finished fireflies (state mutation, in {@link onFrame}) then takes a
 * snapshot and draws the row at the current clock reading and live
 * {@link MotionPolicy} tier ({@link renderFrame} stays pure). Deliberately
 * reads {@link AgentFleetClock} rather than `this.elapsedMs` — the host's
 * frame ticks only drive repaint cadence here, not firefly-phase math, so
 * mounting later than the controller's first registry event doesn't skew
 * spawn/fade timing. The {@link AnimatedWidget} base owns the
 * subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class AgentFleetWidget extends AnimatedWidget {
	#state: AgentFleetWidgetState;
	#theme: AgentFleetTheme;
	#policy: MotionPolicy;
	#clock: AgentFleetClock;

	constructor(options: AgentFleetWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	onFrame(_elapsedMs: number): void {
		this.#state.pruneFireflies(this.#clock.now());
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return renderAgentFleetRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier);
	}
}
