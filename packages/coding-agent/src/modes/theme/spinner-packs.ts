/**
 * Spinner Personality Packs — themed spinner frames + animated gradient
 * colorizers for the working/loading {@link Loader}.
 *
 * The feature rides the existing `Loader` API only: a pack resolves to a
 * `{ frames, colorize }` pair where `colorize` is a {@link LoaderMessageColorFn}.
 * When animation is enabled and the terminal supports color, `colorize.animated`
 * is set so the loader repaints at 30fps and the gradient sweeps over time.
 *
 * Design notes:
 * - The gradient math is a pure function of `(text, phase, capabilities)` so a
 *   colorizer is fully deterministic for a fixed phase — the animated wrapper
 *   only injects the phase from an (injectable) clock.
 * - Capability degradation is explicit: 24-bit escapes are emitted only when the
 *   terminal advertises true color; otherwise the same gradient is quantized to
 *   the xterm-256 cube. With no color at all (non-TTY / `NO_COLOR` / `CI`) the
 *   colorizer is the identity function and never emits escapes.
 */
import type { LoaderMessageColorFn } from "@oh-my-pi/pi-tui";

const FG_RESET = "\x1b[39m";

/** 0–255 RGB triple used for gradient stops. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Identifier of a built-in spinner pack. */
export type SpinnerPackId =
	| "fire"
	| "ocean"
	| "matrix"
	| "synthwave"
	| "aurora"
	| "dots-classic"
	| "pulse"
	| "reactive";

/** Static definition of a spinner pack. */
export interface SpinnerPackDef {
	id: SpinnerPackId;
	/** Human-readable name for settings UI. */
	label: string;
	/** One-line description for settings UI. */
	description: string;
	/** Spinner frames; advanced by the loader. Always non-empty. */
	frames: readonly string[];
	/** Cyclic gradient stops (>= 2). The sweep loops last -> first seamlessly. */
	stops: readonly Rgb[];
	/** Gradient cycles that fit across the full message width. */
	wraps: number;
	/** Sweep speed in gradient-cycles per second. */
	speed: number;
	/**
	 * When true the sweep speed scales with the agent's tokens/sec if a provider
	 * is supplied; otherwise it falls back to the fixed time-based `speed`.
	 */
	reactive?: boolean;
}

// ─── Registry ────────────────────────────────────────────────────────────────
// Frames favor terminal-safe glyphs. Braille/box-drawing packs stay legible in
// any monospace font; a couple of packs use emoji for personality (the loader's
// spinner-frame color function is applied by the caller and emoji ignore fg SGR,
// which is fine — the animated gradient rides the *message* text).

const PACK_LIST: readonly SpinnerPackDef[] = [
	{
		id: "fire",
		label: "Fire",
		description: "Flickering ember gradient, red through amber",
		frames: ["🔥", "🔥", "✨", "🔥", "💥", "🔥"],
		stops: [
			{ r: 180, g: 20, b: 0 },
			{ r: 255, g: 70, b: 0 },
			{ r: 255, g: 150, b: 20 },
			{ r: 255, g: 224, b: 90 },
		],
		wraps: 1.5,
		speed: 0.7,
	},
	{
		id: "ocean",
		label: "Ocean",
		description: "Rolling deep-blue to cyan swell",
		frames: ["⠈", "⠊", "⠒", "⠢", "⠆", "⠃", "⠉", "⠘"],
		stops: [
			{ r: 0, g: 48, b: 120 },
			{ r: 0, g: 120, b: 200 },
			{ r: 40, g: 200, b: 220 },
			{ r: 0, g: 120, b: 200 },
		],
		wraps: 1,
		speed: 0.5,
	},
	{
		id: "matrix",
		label: "Matrix",
		description: "Cascading terminal green rain",
		frames: ["ﾊ", "ﾐ", "ﾋ", "ｰ", "ｳ", "ｼ", "ﾅ", "ﾓ", "ﾆ", "ｻ"],
		stops: [
			{ r: 0, g: 60, b: 0 },
			{ r: 0, g: 200, b: 40 },
			{ r: 140, g: 255, b: 140 },
			{ r: 0, g: 120, b: 20 },
		],
		wraps: 2,
		speed: 0.9,
	},
	{
		id: "synthwave",
		label: "Synthwave",
		description: "Neon magenta / violet / cyan sunset",
		frames: ["▰▱▱", "▱▰▱", "▱▱▰", "▱▰▱"],
		stops: [
			{ r: 255, g: 40, b: 160 },
			{ r: 150, g: 60, b: 220 },
			{ r: 60, g: 200, b: 240 },
		],
		wraps: 1,
		speed: 0.6,
	},
	{
		id: "aurora",
		label: "Aurora",
		description: "Northern-lights green into violet",
		frames: ["░", "▒", "▓", "█", "▓", "▒"],
		stops: [
			{ r: 60, g: 220, b: 140 },
			{ r: 40, g: 200, b: 220 },
			{ r: 150, g: 90, b: 230 },
			{ r: 40, g: 200, b: 220 },
		],
		wraps: 1,
		speed: 0.35,
	},
	{
		id: "dots-classic",
		label: "Dots Classic",
		description: "The familiar braille dots with a subtle shimmer",
		frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		stops: [
			{ r: 120, g: 120, b: 150 },
			{ r: 200, g: 200, b: 230 },
			{ r: 245, g: 245, b: 255 },
			{ r: 160, g: 160, b: 190 },
		],
		wraps: 1,
		speed: 0.5,
	},
	{
		id: "pulse",
		label: "Pulse",
		description: "Breathing single-hue heartbeat",
		frames: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"],
		stops: [
			{ r: 40, g: 70, b: 200 },
			{ r: 120, g: 160, b: 255 },
			{ r: 210, g: 230, b: 255 },
			{ r: 120, g: 160, b: 255 },
		],
		wraps: 0.5,
		speed: 0.8,
	},
	{
		id: "reactive",
		label: "Reactive",
		description: "VU-meter gradient that speeds up with throughput",
		frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
		stops: [
			{ r: 0, g: 200, b: 120 },
			{ r: 180, g: 220, b: 40 },
			{ r: 255, g: 150, b: 30 },
			{ r: 255, g: 60, b: 40 },
		],
		wraps: 1,
		speed: 0.6,
		reactive: true,
	},
];

/** All packs keyed by id. */
export const SPINNER_PACKS: Readonly<Record<SpinnerPackId, SpinnerPackDef>> = Object.freeze(
	Object.fromEntries(PACK_LIST.map(pack => [pack.id, pack])) as Record<SpinnerPackId, SpinnerPackDef>,
);

/** Ordered list of pack ids (registration order). */
export const SPINNER_PACK_IDS: readonly SpinnerPackId[] = PACK_LIST.map(pack => pack.id);

/** Narrow an arbitrary string to a known pack id. */
export function isSpinnerPackId(value: string): value is SpinnerPackId {
	return Object.hasOwn(SPINNER_PACKS, value);
}

// ─── Capabilities ────────────────────────────────────────────────────────────

/** Terminal color capabilities that gate gradient rendering. */
export interface SpinnerCapabilities {
	/** Any ANSI foreground color may be emitted. */
	color: boolean;
	/** 24-bit (`38;2;r;g;b`) escapes may be emitted. */
	trueColor: boolean;
}

/**
 * Inputs for {@link detectSpinnerCapabilities}; every field is injectable for
 * tests. The module stays free of any `@oh-my-pi/pi-tui` value import (which
 * would transitively load the native addon), so the caller supplies the
 * terminal's `trueColor` capability — the interactive mode already holds the
 * `TERMINAL` singleton.
 */
export interface DetectCapabilitiesOptions {
	env?: NodeJS.ProcessEnv;
	/** Whether stdout is a TTY. Defaults to `process.stdout.isTTY`. */
	isTTY?: boolean;
	/** Whether the terminal advertises true color. Defaults to `false` (safe: 256-color). */
	trueColor?: boolean;
}

function envFlagSet(value: string | undefined): boolean {
	return value != null && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Resolve color capabilities from environment + terminal. Color is disabled for
 * non-TTY output, `NO_COLOR`, and `CI`; true color additionally requires the
 * terminal to advertise it (defaults off so 24-bit is never emitted unless the
 * caller confirms support).
 */
export function detectSpinnerCapabilities(options: DetectCapabilitiesOptions = {}): SpinnerCapabilities {
	const env = options.env ?? Bun.env;
	const isTTY = options.isTTY ?? process.stdout.isTTY === true;
	const terminalTrueColor = options.trueColor ?? false;
	// NO_COLOR: presence disables color regardless of value (https://no-color.org).
	const noColor = env.NO_COLOR != null && env.NO_COLOR !== "";
	const color = isTTY && !noColor && !envFlagSet(env.CI);
	return { color, trueColor: color && terminalTrueColor };
}

// ─── Gradient math ───────────────────────────────────────────────────────────

function frac(x: number): number {
	return x - Math.floor(x);
}

function clamp8(value: number): number {
	if (value < 0) return 0;
	if (value > 255) return 255;
	return Math.round(value);
}

/**
 * Sample a cyclic gradient at position `t` in `[0, 1)`. The stops wrap around
 * (last interpolates back to first) so a continuous sweep never jumps.
 */
export function sampleGradient(stops: readonly Rgb[], t: number): Rgb {
	const n = stops.length;
	if (n === 0) return { r: 255, g: 255, b: 255 };
	if (n === 1) return stops[0]!;
	const pos = frac(t) * n;
	const i = Math.floor(pos) % n;
	const next = (i + 1) % n;
	const f = pos - Math.floor(pos);
	const a = stops[i]!;
	const b = stops[next]!;
	return {
		r: clamp8(a.r + (b.r - a.r) * f),
		g: clamp8(a.g + (b.g - a.g) * f),
		b: clamp8(a.b + (b.b - a.b) * f),
	};
}

function trueColorEscape(rgb: Rgb): string {
	return `\x1b[38;2;${clamp8(rgb.r)};${clamp8(rgb.g)};${clamp8(rgb.b)}m`;
}

/** Map an RGB triple to the nearest xterm-256 color index. */
export function rgbToAnsi256(rgb: Rgb): number {
	const r = clamp8(rgb.r);
	const g = clamp8(rgb.g);
	const b = clamp8(rgb.b);
	// Grayscale ramp (232–255) when the channels are close together.
	if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	const ri = Math.round((r / 255) * 5);
	const gi = Math.round((g / 255) * 5);
	const bi = Math.round((b / 255) * 5);
	return 16 + 36 * ri + 6 * gi + bi;
}

function ansi256Escape(rgb: Rgb): string {
	return `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
}

function codePoints(text: string): string[] {
	return Array.from(text);
}

/**
 * Colorize `text` with `pack`'s gradient at a fixed `phase` (in gradient-cycles).
 * Pure and deterministic for a fixed `(text, phase, capabilities)`.
 *
 * - No color -> returns `text` unchanged (never emits escapes).
 * - true color -> 24-bit `38;2;r;g;b` escapes.
 * - color without true color -> quantized xterm-256 `38;5;n` escapes.
 */
export function colorizeAtPhase(
	pack: SpinnerPackDef,
	text: string,
	phase: number,
	capabilities: SpinnerCapabilities,
): string {
	if (!capabilities.color) return text;
	const chars = codePoints(text);
	const n = chars.length;
	if (n === 0) return "";
	const denom = n > 1 ? n - 1 : 1;
	let out = "";
	let prevSeq = "";
	for (let i = 0; i < n; i++) {
		// Position along the gradient: spread the pack's `wraps` cycles across the
		// message and slide the whole field by `phase` over time.
		const t = frac((i / denom) * pack.wraps - phase);
		const rgb = sampleGradient(pack.stops, t);
		const seq = capabilities.trueColor ? trueColorEscape(rgb) : ansi256Escape(rgb);
		if (seq !== prevSeq) {
			out += seq;
			prevSeq = seq;
		}
		out += chars[i];
	}
	return out + FG_RESET;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/** Options controlling how a pack resolves into a live `{ frames, colorize }`. */
export interface ResolveSpinnerPackOptions {
	/** When false the colorizer is static (frozen gradient, no `animated` flag). */
	animations: boolean;
	/** Color capabilities. Defaults to {@link detectSpinnerCapabilities}. */
	capabilities?: SpinnerCapabilities;
	/** Monotonic clock in ms. Defaults to `performance.now`. Injectable for tests. */
	clock?: () => number;
	/** For the `reactive` pack: current agent throughput in tokens/sec, if known. */
	tokensPerSecond?: () => number | undefined;
}

/** A pack resolved into values consumable by `new Loader(...)`. */
export interface ResolvedSpinner {
	frames: string[];
	colorize: LoaderMessageColorFn;
}

const REACTIVE_TOKENS_PER_CYCLE = 40;
const REACTIVE_MAX_SPEED = 4;
/** Max time delta (ms) integrated in one frame, so a stalled render can't lurch the sweep. */
const MAX_FRAME_MS = 100;

function sweepSpeed(pack: SpinnerPackDef, options: ResolveSpinnerPackOptions): number {
	if (!pack.reactive) return pack.speed;
	const tps = options.tokensPerSecond?.();
	if (tps == null || !Number.isFinite(tps) || tps <= 0) return pack.speed;
	// Base speed plus a throughput term, capped so a burst never strobes.
	return Math.min(REACTIVE_MAX_SPEED, pack.speed + tps / REACTIVE_TOKENS_PER_CYCLE);
}

/**
 * Resolve a pack id into live frames + a colorizer. Returns `undefined` for an
 * unknown id so the caller can fall back to the theme default.
 *
 * The colorizer's phase comes from `clock`; when `animations` is on and color is
 * available it carries the `animated` flag so the loader repaints at 30fps.
 */
export function resolveSpinnerPack(id: SpinnerPackId, options: ResolveSpinnerPackOptions): ResolvedSpinner | undefined {
	const pack = SPINNER_PACKS[id];
	if (!pack) return undefined;
	const capabilities = options.capabilities ?? detectSpinnerCapabilities();
	const clock = options.clock ?? (() => performance.now());
	const animate = options.animations && capabilities.color;
	// Phase is the time-integral of the (possibly live) sweep speed: `phase += speed * dt`.
	let lastClock = clock();
	let phase = 0;
	const colorize = ((message: string): string => {
		if (animate) {
			const now = clock();
			const dt = Math.min(Math.max(now - lastClock, 0), MAX_FRAME_MS);
			lastClock = now;
			phase = frac(phase + (sweepSpeed(pack, options) * dt) / 1000);
		}
		return colorizeAtPhase(pack, message, phase, capabilities);
	}) as LoaderMessageColorFn;
	if (animate) {
		(colorize as { animated?: true }).animated = true;
	}
	return { frames: [...pack.frames], colorize };
}
