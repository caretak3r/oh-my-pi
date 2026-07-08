import type { AnimatedWidgetOptions, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { BUCKET_THEME_COLOR, normalizeAmplitude, rateBucket, restingPulse, waveGlyph } from "./scale";
import type { TokenTideState } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type TokenTideTheme = Pick<Theme, "fg">;

/** Amplitude for one sampled column: normalized rate, or the shared resting pulse when idle. */
function columnAmplitude(tokensPerSecond: number, elapsedMs: number): number {
	if (tokensPerSecond > 0) return normalizeAmplitude(tokensPerSecond);
	return restingPulse(elapsedMs);
}

/**
 * Pure renderer: one scrolling waveform row for the `full` tier. Right-aligns
 * the buffer to `width` columns (padding blank columns on the left when the
 * buffer is narrower than the widget), coloring each column by its rate
 * bucket. Deterministic given `buffer`, `elapsedMs`, and `width` — no
 * wall-clock reads.
 */
export function renderWaveformRow(
	buffer: readonly number[],
	elapsedMs: number,
	theme: TokenTideTheme,
	width: number,
): string {
	const cols = Math.max(1, Math.floor(width));
	const visible = buffer.length > cols ? buffer.slice(buffer.length - cols) : buffer;
	const pad = cols - visible.length;
	const parts: string[] = [];
	for (let i = 0; i < pad; i++) parts.push(theme.fg("dim", " "));
	for (const rate of visible) {
		const bucket = rateBucket(rate);
		const glyph = waveGlyph(columnAmplitude(rate, elapsedMs));
		parts.push(theme.fg(BUCKET_THEME_COLOR[bucket], glyph));
	}
	return parts.join("");
}

const VU_BAR_WIDTH = 20;
const VU_FILLED_GLYPH = "█";
const VU_EMPTY_GLYPH = "░";

/**
 * Pure renderer: a single pulsing VU bar for the `subtle` tier, sized to the
 * current tok/s rate (or the shared resting pulse when idle). Deterministic
 * given `tokensPerSecond` and `elapsedMs`.
 */
export function renderVuBar(tokensPerSecond: number, elapsedMs: number, theme: TokenTideTheme): string {
	const amplitude = columnAmplitude(tokensPerSecond, elapsedMs);
	const filled = Math.round(amplitude * VU_BAR_WIDTH);
	const bucket = rateBucket(tokensPerSecond);
	const bucketColor: ThemeColor = BUCKET_THEME_COLOR[bucket];
	return (
		theme.fg(bucketColor, VU_FILLED_GLYPH.repeat(filled)) +
		theme.fg("dim", VU_EMPTY_GLYPH.repeat(VU_BAR_WIDTH - filled))
	);
}

/** Static one-line fallback for the motion-`off` tier: the numeric tok/s reading, or a dash when idle/unknown. */
export function renderTokenRateText(tokensPerSecond: number | null): string {
	if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "-- tok/s";
	return `${Math.round(tokensPerSecond)} tok/s`;
}

export interface TokenTideWidgetOptions extends AnimatedWidgetOptions {
	state: TokenTideState;
	theme: TokenTideTheme;
	/** Sample the live tok/s rate at a given wall-clock (epoch ms) reading. `null` when nothing is streaming. */
	sampleRate(wallNowMs: number): number | null;
	/** Wall clock (epoch ms) — distinct from the shared `AnimationHost`'s relative elapsed-ms, because
	 * throughput is computed from message timestamps, which are wall-clock-based. Injectable for tests. */
	wallClock: { now(): number };
}

/**
 * Ambient widget for the token-throughput oscilloscope. Each frame it samples
 * the live tok/s rate (via {@link TokenTideWidgetOptions.sampleRate}, reusing
 * the existing `token-rate.ts` provider rather than recomputing) into the
 * shared {@link TokenTideState} ring buffer, then renders a pure function of
 * that buffer plus the host's relative `elapsedMs` phase (used only for the
 * idle resting-pulse animation, never to derive the sampled rate itself).
 * The {@link AnimatedWidget} base owns the subscribe-on-mount /
 * unsubscribe-on-dispose lifecycle.
 */
export class TokenTideWidget extends AnimatedWidget {
	#state: TokenTideState;
	#theme: TokenTideTheme;
	#policy: MotionPolicy;
	#sampleRate: (wallNowMs: number) => number | null;
	#wallClock: { now(): number };

	constructor(options: TokenTideWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#sampleRate = options.sampleRate;
		this.#wallClock = options.wallClock;
	}

	override onFrame(_elapsedMs: number): void {
		const rate = this.#sampleRate(this.#wallClock.now());
		this.#state.pushSample(rate ?? 0);
	}

	renderFrame(width: number): readonly string[] {
		if (this.#policy.tier === "full") {
			return [renderWaveformRow(this.#state.snapshot(), this.elapsedMs, this.#theme, width)];
		}
		return [renderVuBar(this.#state.latest(), this.elapsedMs, this.#theme)];
	}
}
