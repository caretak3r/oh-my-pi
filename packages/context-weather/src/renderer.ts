import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { VisualState } from "./model";

export type ContextWeatherStyle = "tide" | "bar" | "barometer";

/**
 * Terminal capabilities the renderer degrades against. Sourced from the host
 * `theme`/`tui` by the widget wrapper (this module stays pure — no host access).
 */
export interface BarometerCaps {
	/** When false, drop 24-bit color (render mono) so no truecolor escapes leak. */
	trueColor: boolean;
	/** When false, prefer a calmer/static frame (no per-cell shimmer). */
	synchronizedOutput: boolean;
}

export const DEFAULT_CAPS: BarometerCaps = { trueColor: true, synchronizedOutput: true };

export interface RenderBarometerOptions {
	style?: ContextWeatherStyle;
	caps?: BarometerCaps;
}

const WAVE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const EMPTY_CELL = "·";
const STORM_MARK = "⚡";
/** ms of phase per animation step; larger = slower visible motion. */
const MS_PER_STEP = 80;

/** Deterministic integer animation step derived purely from phase + speed. */
function stepOf(state: VisualState, phase: number, animate: boolean): number {
	if (!animate || state.phaseSpeed <= 0) return 0;
	return Math.floor((phase * state.phaseSpeed) / MS_PER_STEP);
}

function waveHeight(column: number, step: number): number {
	const s = Math.sin(column * 0.6 + step * 0.5);
	return Math.min(WAVE.length - 1, Math.max(0, Math.round(((s + 1) / 2) * (WAVE.length - 1))));
}

function renderTide(state: VisualState, step: number, inner: number): string {
	const fill = Math.round(state.fillRatio * inner);
	let out = "";
	for (let i = 0; i < inner; i++) {
		out += i < fill ? WAVE[waveHeight(i, step)] : EMPTY_CELL;
	}
	return out;
}

function renderBar(state: VisualState, step: number, inner: number): string {
	const fill = Math.round(state.fillRatio * inner);
	const shimmer = fill > 0 ? step % fill : -1;
	let out = "";
	for (let i = 0; i < inner; i++) {
		if (i < fill) out += i === shimmer ? "▓" : "█";
		else out += "░";
	}
	return out;
}

function renderGauge(state: VisualState, step: number, inner: number): string {
	if (inner <= 0) return "";
	const marker = Math.min(inner - 1, Math.round(state.fillRatio * (inner - 1)));
	const sweep = inner > 0 ? step % inner : -1;
	let out = "";
	for (let i = 0; i < inner; i++) {
		if (i === marker) out += "◆";
		else if (i === sweep) out += "│";
		else out += "─";
	}
	return out;
}

function renderTrack(style: ContextWeatherStyle, state: VisualState, step: number, inner: number): string {
	switch (style) {
		case "bar":
			return renderBar(state, step, inner);
		case "barometer":
			return renderGauge(state, step, inner);
		case "tide":
			return renderTide(state, step, inner);
	}
}

/** Storm color pulses between warning and error by step parity for pre-attentive urgency. */
function stormHue(step: number): ThemeColor {
	return step % 2 === 0 ? "error" : "warning";
}

/**
 * Deterministic (state, phase) → single styled cell/line. Pure of wall-clock:
 * `phase` (ms) is an input, so identical arguments yield byte-identical output.
 *
 * Degradation: `caps.trueColor === false` renders mono (no color escapes);
 * `caps.synchronizedOutput === false` freezes the shimmer to a calm static frame.
 * Visible width never exceeds `width`.
 */
export function renderBarometer(
	state: VisualState,
	phase: number,
	theme: Theme,
	width: number,
	options?: RenderBarometerOptions,
): string {
	if (!Number.isFinite(width) || width <= 0) return "";

	const style = options?.style ?? "tide";
	const caps = options?.caps ?? DEFAULT_CAPS;
	const animate = caps.synchronizedOutput;
	const step = stepOf(state, phase, animate);

	const percent = Math.round(state.fillRatio * 100);
	const label = `${percent}%`;
	const stormPrefix = state.imminent ? `${STORM_MARK} ` : "";
	// Reserve room for the storm mark, a separating space, and the percent label.
	const reserved = visibleWidth(stormPrefix) + 1 + visibleWidth(label);
	const inner = Math.max(0, width - reserved);

	const track = renderTrack(style, state, step, inner);

	const color: ThemeColor = state.imminent ? stormHue(step) : state.hue;
	const paint = (text: string): string => (caps.trueColor ? theme.fg(color, text) : text);

	const line = `${paint(stormPrefix + track)} ${paint(label)}`;
	return truncateToWidth(line, width);
}
