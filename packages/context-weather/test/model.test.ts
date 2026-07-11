import { describe, expect, it } from "bun:test";
import { contextWeatherModel, IMMINENT_WINDOW_FRACTION } from "../src/model";
import { usageFixture } from "./helpers";

describe("contextWeatherModel — level mapping", () => {
	const WINDOW = 200_000; // token thresholds (150k/270k/500k) stay above the percent gates

	it("maps percent 20/55/75/92 to normal/warning/purple/error", () => {
		expect(contextWeatherModel(usageFixture(20, WINDOW)).level).toBe("normal");
		expect(contextWeatherModel(usageFixture(55, WINDOW)).level).toBe("warning");
		expect(contextWeatherModel(usageFixture(75, WINDOW)).level).toBe("purple");
		expect(contextWeatherModel(usageFixture(92, WINDOW)).level).toBe("error");
	});

	it("escalates via the token-equivalent threshold on a huge window", () => {
		// 1M window: warning trips at 150k tokens = 15%, before the 50% percent gate.
		const big = 1_000_000;
		expect(contextWeatherModel(usageFixture(14, big)).level).toBe("normal");
		expect(contextWeatherModel(usageFixture(16, big)).level).toBe("warning");
	});

	it("clamps fillRatio into [0,1] and derives it from percent", () => {
		expect(contextWeatherModel(usageFixture(55, WINDOW)).fillRatio).toBeCloseTo(0.55, 5);
		expect(contextWeatherModel(usageFixture(140, WINDOW)).fillRatio).toBe(1);
	});
});

describe("contextWeatherModel — neutral guards", () => {
	it("returns a neutral static state for undefined usage (no NaN)", () => {
		const state = contextWeatherModel(undefined);
		expect(state.level).toBe("normal");
		expect(state.fillRatio).toBe(0);
		expect(state.phaseSpeed).toBe(0);
		expect(state.imminent).toBe(false);
		expect(Number.isNaN(state.fillRatio)).toBe(false);
	});

	it("returns a neutral static state when the context window is zero", () => {
		const state = contextWeatherModel(usageFixture(50, 0));
		expect(state.level).toBe("normal");
		expect(state.fillRatio).toBe(0);
		expect(state.phaseSpeed).toBe(0);
		expect(state.imminent).toBe(false);
	});
});

describe("contextWeatherModel — imminent (storm) boundary", () => {
	const WINDOW = 200_000;
	const margin = WINDOW * IMMINENT_WINDOW_FRACTION; // 10_000

	it("flips imminent exactly at the forecast margin boundary", () => {
		const usage = usageFixture(60, WINDOW);
		expect(contextWeatherModel(usage, { tokensUntilCompaction: margin + 1 }).imminent).toBe(false);
		expect(contextWeatherModel(usage, { tokensUntilCompaction: margin }).imminent).toBe(true);
	});

	it("treats overdue (negative) headroom as a storm", () => {
		const usage = usageFixture(95, WINDOW);
		expect(contextWeatherModel(usage, { tokensUntilCompaction: -500 }).imminent).toBe(true);
	});

	it("falls back to stormAtPercent when no forecast is present", () => {
		expect(contextWeatherModel(usageFixture(84.9, WINDOW)).imminent).toBe(false);
		expect(contextWeatherModel(usageFixture(85, WINDOW)).imminent).toBe(true);
	});

	it("honors a custom stormAtPercent fallback", () => {
		const usage = usageFixture(71, WINDOW);
		expect(contextWeatherModel(usage, undefined, { stormAtPercent: 70 }).imminent).toBe(true);
		expect(contextWeatherModel(usage, undefined, { stormAtPercent: 80 }).imminent).toBe(false);
	});

	it("quickens the phase speed during a storm at the same fill", () => {
		const usage = usageFixture(88, WINDOW);
		const calm = contextWeatherModel(usage, undefined, { stormAtPercent: 100 });
		const storm = contextWeatherModel(usage, undefined, { stormAtPercent: 80 });
		expect(storm.imminent).toBe(true);
		expect(calm.imminent).toBe(false);
		expect(storm.phaseSpeed).toBeGreaterThan(calm.phaseSpeed);
	});
});
