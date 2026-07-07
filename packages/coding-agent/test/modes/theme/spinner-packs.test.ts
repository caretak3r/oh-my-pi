import { describe, expect, it } from "bun:test";
import {
	colorizeAtPhase,
	detectSpinnerCapabilities,
	isSpinnerPackId,
	resolveSpinnerPack,
	SPINNER_PACK_IDS,
	SPINNER_PACKS,
	type SpinnerCapabilities,
	type SpinnerPackId,
	sampleGradient,
} from "@oh-my-pi/pi-coding-agent/modes/theme/spinner-packs";

const TRUE_COLOR: SpinnerCapabilities = { color: true, trueColor: true };
const COLOR_256: SpinnerCapabilities = { color: true, trueColor: false };
const NO_COLOR: SpinnerCapabilities = { color: false, trueColor: false };

// Matches a 24-bit foreground escape (38;2;r;g;b) — the marker of true-color output.
const TRUECOLOR_ESCAPE = /\x1b\[38;2;\d+;\d+;\d+m/;
const ANSI256_ESCAPE = /\x1b\[38;5;\d+m/;

describe("spinner pack registry", () => {
	it("ships the eight documented packs with non-empty frames and >= 2 gradient stops", () => {
		const expected: SpinnerPackId[] = [
			"fire",
			"ocean",
			"matrix",
			"synthwave",
			"aurora",
			"dots-classic",
			"pulse",
			"reactive",
		];
		expect(SPINNER_PACK_IDS).toEqual(expected);
		for (const id of SPINNER_PACK_IDS) {
			const pack = SPINNER_PACKS[id];
			expect(pack.frames.length).toBeGreaterThan(0);
			// Frames must be renderable, not blank padding.
			for (const frame of pack.frames) {
				expect(frame.length).toBeGreaterThan(0);
			}
			expect(pack.stops.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("narrows only known ids", () => {
		expect(isSpinnerPackId("fire")).toBe(true);
		expect(isSpinnerPackId("reactive")).toBe(true);
		expect(isSpinnerPackId("default")).toBe(false);
		expect(isSpinnerPackId("nope")).toBe(false);
	});
});

describe("colorizeAtPhase determinism and capability degradation", () => {
	it("is deterministic for a fixed (text, phase, capabilities)", () => {
		for (const id of SPINNER_PACK_IDS) {
			const pack = SPINNER_PACKS[id];
			const a = colorizeAtPhase(pack, "Working on it", 0.37, TRUE_COLOR);
			const b = colorizeAtPhase(pack, "Working on it", 0.37, TRUE_COLOR);
			expect(a).toBe(b);
			// The visible payload is always preserved exactly.
			expect(Bun.stripANSI(a)).toBe("Working on it");
		}
	});

	it("advancing the phase changes the emitted colors", () => {
		const pack = SPINNER_PACKS.fire;
		const atZero = colorizeAtPhase(pack, "streaming tokens", 0, TRUE_COLOR);
		const atHalf = colorizeAtPhase(pack, "streaming tokens", 0.5, TRUE_COLOR);
		expect(atZero).not.toBe(atHalf);
		expect(Bun.stripANSI(atZero)).toBe("streaming tokens");
		expect(Bun.stripANSI(atHalf)).toBe("streaming tokens");
	});

	it("emits 24-bit escapes only with true color", () => {
		const pack = SPINNER_PACKS.ocean;
		const trueColor = colorizeAtPhase(pack, "hello", 0.2, TRUE_COLOR);
		expect(trueColor).toMatch(TRUECOLOR_ESCAPE);

		const degraded = colorizeAtPhase(pack, "hello", 0.2, COLOR_256);
		expect(degraded).not.toMatch(TRUECOLOR_ESCAPE);
		expect(degraded).toMatch(ANSI256_ESCAPE);
		expect(Bun.stripANSI(degraded)).toBe("hello");
	});

	it("emits no escapes at all when color is unavailable", () => {
		for (const id of SPINNER_PACK_IDS) {
			const rendered = colorizeAtPhase(SPINNER_PACKS[id], "compiling", 0.9, NO_COLOR);
			expect(rendered).toBe("compiling");
		}
	});

	it("returns an empty string for empty text", () => {
		expect(colorizeAtPhase(SPINNER_PACKS.matrix, "", 0.1, TRUE_COLOR)).toBe("");
	});
});

describe("sampleGradient", () => {
	it("wraps cyclically so the sweep is seamless at the loop boundary", () => {
		const stops = SPINNER_PACKS.fire.stops;
		// t and t+1 address the same cyclic position.
		expect(sampleGradient(stops, 0.25)).toEqual(sampleGradient(stops, 1.25));
		// A single stop degenerates to a constant color.
		const solid = sampleGradient([{ r: 10, g: 20, b: 30 }], 0.8);
		expect(solid).toEqual({ r: 10, g: 20, b: 30 });
	});
});

describe("detectSpinnerCapabilities", () => {
	it("disables color for non-TTY output", () => {
		const caps = detectSpinnerCapabilities({ env: {} as NodeJS.ProcessEnv, isTTY: false, trueColor: true });
		expect(caps).toEqual({ color: false, trueColor: false });
	});

	it("disables color under NO_COLOR even on a true-color TTY", () => {
		const caps = detectSpinnerCapabilities({
			env: { NO_COLOR: "1" } as unknown as NodeJS.ProcessEnv,
			isTTY: true,
			trueColor: true,
		});
		expect(caps.color).toBe(false);
	});

	it("disables color under CI", () => {
		const caps = detectSpinnerCapabilities({
			env: { CI: "true" } as unknown as NodeJS.ProcessEnv,
			isTTY: true,
			trueColor: true,
		});
		expect(caps.color).toBe(false);
	});

	it("keeps color but drops true color when the terminal lacks it", () => {
		const caps = detectSpinnerCapabilities({ env: {} as NodeJS.ProcessEnv, isTTY: true, trueColor: false });
		expect(caps).toEqual({ color: true, trueColor: false });
	});
});

describe("resolveSpinnerPack", () => {
	it("selecting a pack yields that pack's frames", () => {
		const fire = resolveSpinnerPack("fire", { animations: true, capabilities: TRUE_COLOR });
		const ocean = resolveSpinnerPack("ocean", { animations: true, capabilities: TRUE_COLOR });
		expect(fire?.frames).toEqual([...SPINNER_PACKS.fire.frames]);
		expect(ocean?.frames).toEqual([...SPINNER_PACKS.ocean.frames]);
		expect(fire?.frames).not.toEqual(ocean?.frames);
	});

	it("carries the animated flag when animations are on and color is available", () => {
		let now = 0;
		const clock = () => now;
		const { colorize } = resolveSpinnerPack("synthwave", {
			animations: true,
			capabilities: TRUE_COLOR,
			clock,
		})!;
		expect((colorize as { animated?: true }).animated).toBe(true);

		// Advancing the clock advances the sweep -> different output for the same text.
		const first = colorize("indexing files");
		now = 500;
		const later = colorize("indexing files");
		expect(first).not.toBe(later);
		expect(Bun.stripANSI(first)).toBe("indexing files");
	});

	it("animations=off yields a static colorizer with no animated flag", () => {
		let now = 0;
		const clock = () => now;
		const { colorize } = resolveSpinnerPack("aurora", {
			animations: false,
			capabilities: TRUE_COLOR,
			clock,
		})!;
		expect((colorize as { animated?: true }).animated).toBeUndefined();
		const first = colorize("thinking");
		now = 10_000;
		const later = colorize("thinking");
		// Frozen phase -> identical output regardless of elapsed time.
		expect(first).toBe(later);
		expect(first).toMatch(TRUECOLOR_ESCAPE);
	});

	it("drops the animated flag and all escapes when color is unavailable", () => {
		const { colorize } = resolveSpinnerPack("matrix", {
			animations: true,
			capabilities: NO_COLOR,
		})!;
		expect((colorize as { animated?: true }).animated).toBeUndefined();
		expect(colorize("no color here")).toBe("no color here");
	});

	it("reactive pack speeds up with throughput but stays deterministic", () => {
		let now = 0;
		const clock = () => now;
		const slow = resolveSpinnerPack("reactive", {
			animations: true,
			capabilities: TRUE_COLOR,
			clock,
			tokensPerSecond: () => 0,
		})!;
		const fast = resolveSpinnerPack("reactive", {
			animations: true,
			capabilities: TRUE_COLOR,
			clock,
			tokensPerSecond: () => 200,
		})!;
		now = 300;
		// Higher throughput advances the sweep further in the same wall-clock time.
		expect(slow.colorize("generating")).not.toBe(fast.colorize("generating"));
	});

	it("returns undefined for an unknown id", () => {
		// Cast through unknown: callers guard with isSpinnerPackId, but the resolver
		// must fail closed rather than throw.
		const resolved = resolveSpinnerPack("bogus" as never, { animations: true, capabilities: TRUE_COLOR });
		expect(resolved).toBeUndefined();
	});
});
