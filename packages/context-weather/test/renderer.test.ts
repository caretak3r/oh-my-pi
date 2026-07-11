import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { contextWeatherModel } from "../src/model";
import { type ContextWeatherStyle, renderBarometer } from "../src/renderer";
import { fakeTheme, usageFixture } from "./helpers";

const theme = fakeTheme();
const STYLES: ContextWeatherStyle[] = ["tide", "bar", "barometer"];

describe("renderBarometer — determinism", () => {
	it("is byte-identical for the same (state, phase) across styles", () => {
		const state = contextWeatherModel(usageFixture(72));
		for (const style of STYLES) {
			const a = renderBarometer(state, 640, theme, 40, { style });
			const b = renderBarometer(state, 640, theme, 40, { style });
			expect(a).toBe(b);
			expect(a.length).toBeGreaterThan(0);
		}
	});

	it("changes between distinct phases when animating (motion present)", () => {
		const state = contextWeatherModel(usageFixture(72)); // warning: phaseSpeed > 0
		const frames = new Set<string>();
		for (let phase = 0; phase < 2000; phase += 160) {
			frames.add(renderBarometer(state, phase, theme, 40, { style: "tide" }));
		}
		expect(frames.size).toBeGreaterThan(1);
	});
});

describe("renderBarometer — capability degradation", () => {
	const state = contextWeatherModel(usageFixture(72));

	it("emits no 24-bit color escapes when trueColor is false, still non-empty", () => {
		const mono = renderBarometer(state, 320, theme, 40, {
			style: "tide",
			caps: { trueColor: false, synchronizedOutput: true },
		});
		expect(mono).not.toContain("38;2");
		expect(mono.trim().length).toBeGreaterThan(0);
	});

	it("emits 24-bit color escapes when trueColor is true", () => {
		const color = renderBarometer(state, 320, theme, 40, {
			style: "tide",
			caps: { trueColor: true, synchronizedOutput: true },
		});
		expect(color).toContain("38;2");
	});

	it("freezes to a calm static frame when synchronizedOutput is false", () => {
		const caps = { trueColor: true, synchronizedOutput: false };
		const f1 = renderBarometer(state, 0, theme, 40, { style: "tide", caps });
		const f2 = renderBarometer(state, 5000, theme, 40, { style: "tide", caps });
		expect(f1).toBe(f2);
	});
});

describe("renderBarometer — width bound", () => {
	it("never exceeds the requested visible width", () => {
		for (const percent of [0, 45, 72, 96]) {
			const state = contextWeatherModel(usageFixture(percent), { tokensUntilCompaction: 100 });
			for (const style of STYLES) {
				for (const width of [1, 8, 20, 40, 120]) {
					for (const phase of [0, 333, 1200]) {
						const out = renderBarometer(state, phase, theme, width, { style });
						expect(visibleWidth(out)).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});

	it("returns empty output for non-positive width", () => {
		const state = contextWeatherModel(usageFixture(50));
		expect(renderBarometer(state, 0, theme, 0)).toBe("");
	});
});

describe("renderBarometer — storm variant", () => {
	it("differs from the calm frame at the same fillRatio", () => {
		const usage = usageFixture(88);
		const calm = contextWeatherModel(usage, undefined, { stormAtPercent: 100 });
		const storm = contextWeatherModel(usage, undefined, { stormAtPercent: 80 });
		expect(calm.fillRatio).toBe(storm.fillRatio);
		const calmFrame = renderBarometer(calm, 240, theme, 40, { style: "tide" });
		const stormFrame = renderBarometer(storm, 240, theme, 40, { style: "tide" });
		expect(stormFrame).not.toBe(calmFrame);
	});
});
