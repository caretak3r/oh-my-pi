import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import { formatTokensCompact, gemGlyph, sparkleIntensity } from "./crystal";
import type { MemoryCrystalsSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type MemoryCrystalsTheme = Pick<Theme, "fg">;

const EMPTY_TRAY_TEXT = "· tray empty ·";

/** Resting color tier for a crystal's magnitude — cool and muted for small reclaims, warming to a triumphant `success` for a large one. Pure. */
function gemColor(magnitude: number): "dim" | "syntaxType" | "success" {
	if (magnitude > 0.66) return "success";
	if (magnitude > 0.33) return "syntaxType";
	return "dim";
}

/**
 * Pure renderer for the crystal tray row. In the `full` tier, a crystal
 * spawned within {@link sparkleIntensity}'s window flashes `accent` (the
 * momentary landing flash) before settling into its plain magnitude-tiered
 * glyph/color; the `subtle` tier skips the sparkle and always shows the
 * resting glyph. Deterministic given its numeric inputs — no wall-clock
 * reads.
 */
export function renderMemoryCrystalsRow(
	snapshot: MemoryCrystalsSnapshot,
	elapsedMs: number,
	theme: MemoryCrystalsTheme,
	tier: "full" | "subtle",
): string {
	if (snapshot.crystals.length === 0) return theme.fg("dim", EMPTY_TRAY_TEXT);

	const cells = snapshot.crystals.map(crystal => {
		const glyph = gemGlyph(crystal.magnitude);
		if (tier === "full") {
			const sinceSpawn = elapsedMs - crystal.spawnedAt;
			const sparkle = sinceSpawn >= 0 ? sparkleIntensity(sinceSpawn) : 0;
			if (sparkle > 0.5) return theme.fg("accent", glyph);
		}
		return theme.fg(gemColor(crystal.magnitude), glyph);
	});

	const hidden = snapshot.hiddenCount > 0 ? theme.fg("dim", ` +${snapshot.hiddenCount} more`) : "";
	return cells.join(" ") + hidden;
}

/** Static one-line fallback for the motion-`off` tier: total crystals and tokens reclaimed this session. */
export function renderMemoryCrystalsOffText(snapshot: MemoryCrystalsSnapshot): string {
	if (snapshot.totalCrystals === 0) return "no crystals yet";
	const plural = snapshot.totalCrystals === 1 ? "" : "s";
	return `◆ ${snapshot.totalCrystals} crystal${plural} · ${formatTokensCompact(snapshot.totalTokensReclaimed)} tokens reclaimed`;
}

/** Minimal clock seam the widget needs — shared with the controller so crystal spawn timestamps and render reads agree. */
export type MemoryCrystalsClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface MemoryCrystalsWidgetState {
	snapshot(): MemoryCrystalsSnapshot;
}

export interface MemoryCrystalsWidgetOptions extends AnimatedWidgetOptions {
	state: MemoryCrystalsWidgetState;
	theme: MemoryCrystalsTheme;
	/** Same clock the controller stamps crystal spawns with — NOT the host's internal relative elapsed-ms. */
	clock: MemoryCrystalsClock;
}

/**
 * Ambient widget for the memory-crystal tray. Reads {@link MemoryCrystalsClock}
 * rather than `this.elapsedMs` for the same reason as every other Wave 2
 * feature: a widget that mounts after the controller's first recorded
 * crystal must not have its sparkle-decay math skewed by the host's own
 * mount-relative clock. `renderFrame` stays pure; the {@link AnimatedWidget}
 * base owns the subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class MemoryCrystalsWidget extends AnimatedWidget {
	#state: MemoryCrystalsWidgetState;
	#theme: MemoryCrystalsTheme;
	#policy: MotionPolicy;
	#clock: MemoryCrystalsClock;

	constructor(options: MemoryCrystalsWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return [renderMemoryCrystalsRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier)];
	}
}
