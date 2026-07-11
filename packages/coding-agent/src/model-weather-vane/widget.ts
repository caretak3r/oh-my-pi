import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import type { ModelWeatherVaneSnapshot } from "./state";
import {
	DIRECTION_GLYPHS,
	modelColor,
	modelDirectionGlyph,
	modelDirectionIndex,
	spinDisplayIndex,
	spinProgress,
	truncateLabel,
	VANE_COLORS,
} from "./vane";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type ModelWeatherVaneTheme = Pick<Theme, "fg">;

/** One emblem frame: the compass glyph and the color it settles/spins at. */
interface Emblem {
	readonly glyph: string;
	readonly color: (typeof VANE_COLORS)[number];
}

/**
 * The emblem `snapshot` displays at `elapsedMs`: the settled target
 * direction/color once no spin is in flight (or the spin has fully decayed),
 * otherwise the in-progress sweep from the previous model's slot toward the
 * new one. Pure, `undefined` before any assistant message has been observed.
 */
function currentEmblem(snapshot: ModelWeatherVaneSnapshot, elapsedMs: number): Emblem | undefined {
	if (snapshot.currentModelId === undefined) return undefined;
	const toIndex = modelDirectionIndex(snapshot.currentModelId);

	if (snapshot.spinStartAt !== undefined && snapshot.previousModelId !== undefined) {
		const progress = spinProgress(elapsedMs, snapshot.spinStartAt);
		if (progress < 1) {
			const fromIndex = modelDirectionIndex(snapshot.previousModelId);
			const index = spinDisplayIndex(fromIndex, toIndex, progress);
			return { glyph: DIRECTION_GLYPHS[index], color: VANE_COLORS[index] };
		}
	}
	return { glyph: modelDirectionGlyph(snapshot.currentModelId), color: modelColor(snapshot.currentModelId) };
}

/**
 * Pure renderer: one line combining the spinning/settled compass emblem with
 * the current model's id. `full` tier appends the provider; `subtle`
 * collapses to just the colored glyph and the (possibly truncated) model id.
 * Deterministic given `snapshot` and `elapsedMs` — no wall-clock reads.
 */
export function renderModelWeatherVaneRow(
	snapshot: ModelWeatherVaneSnapshot,
	elapsedMs: number,
	theme: ModelWeatherVaneTheme,
	tier: "full" | "subtle",
): string {
	const emblem = currentEmblem(snapshot, elapsedMs);
	if (!emblem || snapshot.currentModelId === undefined) return theme.fg("dim", "no model yet");

	const glyph = theme.fg(emblem.color, emblem.glyph);
	const label = theme.fg("dim", truncateLabel(snapshot.currentModelId));
	if (tier === "subtle") return `${glyph} ${label}`;

	const provider = snapshot.currentProvider ? theme.fg("dim", `(${snapshot.currentProvider})`) : "";
	return provider ? `${glyph} ${label} ${provider}` : `${glyph} ${label}`;
}

/** Static one-line fallback for the motion-`off` tier: no theme, no ANSI. */
export function renderModelWeatherVaneOffText(snapshot: ModelWeatherVaneSnapshot): string {
	if (snapshot.currentModelId === undefined) return "no model yet";
	return snapshot.currentProvider
		? `🧭 ${truncateLabel(snapshot.currentModelId)} (${snapshot.currentProvider})`
		: `🧭 ${truncateLabel(snapshot.currentModelId)}`;
}

/** Minimal clock seam the widget needs — shared with the controller so spin-start timestamps and render reads agree. */
export type ModelWeatherVaneClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface ModelWeatherVaneWidgetState {
	snapshot(): ModelWeatherVaneSnapshot;
}

export interface ModelWeatherVaneWidgetOptions extends AnimatedWidgetOptions {
	state: ModelWeatherVaneWidgetState;
	theme: ModelWeatherVaneTheme;
	/** Same clock the controller stamps spin starts with — NOT the host's internal relative elapsed-ms. */
	clock: ModelWeatherVaneClock;
}

/**
 * Ambient widget for the model weather vane. Reads {@link ModelWeatherVaneClock}
 * rather than `this.elapsedMs` for the same reason as every other Wave 2
 * feature: a widget that mounts later than the controller's first recorded
 * message must not have its spin-progress math skewed by the host's own
 * mount-relative clock. `renderFrame` stays pure; the {@link AnimatedWidget}
 * base owns the subscribe-on-mount / unsubscribe-on-dispose lifecycle. Once a
 * spin fully settles (`elapsedMs - spinStartAt >= SPIN_DURATION_MS`) the
 * frame stops changing, so `AnimatedWidget`'s host keeps ticking harmlessly
 * at rest — the same steady-state behavior every other ambient-status Wave 2
 * widget (Cost Candle, Goal Horizon) already has.
 */
export class ModelWeatherVaneWidget extends AnimatedWidget {
	#state: ModelWeatherVaneWidgetState;
	#theme: ModelWeatherVaneTheme;
	#policy: MotionPolicy;
	#clock: ModelWeatherVaneClock;

	constructor(options: ModelWeatherVaneWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return [renderModelWeatherVaneRow(this.#state.snapshot(), this.#clock.now(), this.#theme, tier)];
	}
}
