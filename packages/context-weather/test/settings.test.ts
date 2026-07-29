import { describe, expect, it } from "bun:test";
import { MotionPolicy } from "@oh-my-pi/pi-animation";
import {
	CONTEXT_WEATHER_DEFAULTS,
	readContextWeatherSettingsFromEnv,
	resolveContextWeatherSettings,
	resolveContextWeatherSettingsFromSources,
} from "../src/settings";

describe("resolveContextWeatherSettings", () => {
	it("returns defaults for an empty record", () => {
		expect(resolveContextWeatherSettings({})).toEqual(CONTEXT_WEATHER_DEFAULTS);
	});

	it("falls back to defaults for unknown enum values", () => {
		const resolved = resolveContextWeatherSettings({
			animations: "hyperspeed",
			contextWeatherStyle: "spiral",
			contextWeatherPlacement: "above", // note: NOT the WidgetPlacement spelling
		});
		expect(resolved.animations).toBe("full");
		expect(resolved.style).toBe("tide");
		expect(resolved.placement).toBe("aboveEditor");
	});

	it("maps contextWeatherPlacement to the WidgetPlacement literal", () => {
		expect(resolveContextWeatherSettings({ contextWeatherPlacement: "belowEditor" }).placement).toBe("belowEditor");
		expect(resolveContextWeatherSettings({ contextWeatherPlacement: "aboveEditor" }).placement).toBe("aboveEditor");
	});

	it("clamps stormAtPercent to [0,100] and coerces strings", () => {
		expect(resolveContextWeatherSettings({ contextWeatherStormAtPercent: "150" }).stormAtPercent).toBe(100);
		expect(resolveContextWeatherSettings({ contextWeatherStormAtPercent: -5 }).stormAtPercent).toBe(0);
		expect(resolveContextWeatherSettings({ contextWeatherStormAtPercent: "abc" }).stormAtPercent).toBe(85);
		expect(resolveContextWeatherSettings({ contextWeatherStormAtPercent: 70 }).stormAtPercent).toBe(70);
	});

	it("accepts boolean and stringified booleans for notifyOnImminent", () => {
		expect(resolveContextWeatherSettings({ contextWeatherNotifyOnImminent: false }).notifyOnImminent).toBe(false);
		expect(resolveContextWeatherSettings({ contextWeatherNotifyOnImminent: "false" }).notifyOnImminent).toBe(false);
		expect(resolveContextWeatherSettings({ contextWeatherNotifyOnImminent: "true" }).notifyOnImminent).toBe(true);
	});
});

describe("readContextWeatherSettingsFromEnv", () => {
	it("reads env fallbacks and applies defaults for absent vars", () => {
		const resolved = readContextWeatherSettingsFromEnv({
			OMP_CONTEXT_WEATHER_ANIMATIONS: "full",
			OMP_CONTEXT_WEATHER_STYLE: "bar",
		});
		expect(resolved.animations).toBe("full");
		expect(resolved.style).toBe("bar");
		expect(resolved.placement).toBe(CONTEXT_WEATHER_DEFAULTS.placement);
		expect(resolved.stormAtPercent).toBe(CONTEXT_WEATHER_DEFAULTS.stormAtPercent);
	});
});

describe("resolveContextWeatherSettingsFromSources", () => {
	it("inherits the supplied core motion tier when neither source sets animations", () => {
		const resolved = resolveContextWeatherSettingsFromSources({}, {}, "subtle");
		expect(resolved.animations).toBe("subtle");
	});

	it("lets stored plugin settings override env fallbacks", () => {
		const resolved = resolveContextWeatherSettingsFromSources(
			{ animations: "subtle" },
			{ OMP_CONTEXT_WEATHER_ANIMATIONS: "full" },
		);
		expect(resolved.animations).toBe("subtle");
	});

	it("uses env fallbacks when the store is empty and defaults for absent keys", () => {
		const resolved = resolveContextWeatherSettingsFromSources({}, { OMP_CONTEXT_WEATHER_ANIMATIONS: "full" });
		expect(resolved.animations).toBe("full");
		expect(resolved.style).toBe("tide");
	});

	it("lets nullish stored values fall through to env fallbacks", () => {
		const resolved = resolveContextWeatherSettingsFromSources(
			{ animations: null as unknown },
			{ OMP_CONTEXT_WEATHER_ANIMATIONS: "full" },
		);
		expect(resolved.animations).toBe("full");
	});

	it("validates invalid stored values through the shared resolver", () => {
		const resolved = resolveContextWeatherSettingsFromSources({ contextWeatherStormAtPercent: "abc" }, {});
		expect(resolved.stormAtPercent).toBe(85);
	});
});

describe("settings drive the kit MotionPolicy tier live", () => {
	it("flips the effective tier when animations changes at runtime", () => {
		const policy = new MotionPolicy(
			{ hasUI: true, isTTY: true, env: {} },
			resolveContextWeatherSettings({ animations: "off" }).animations,
		);
		expect(policy.tier).toBe("off");

		policy.setSetting(resolveContextWeatherSettings({ animations: "full" }).animations);
		expect(policy.tier).toBe("full");

		policy.setSetting(resolveContextWeatherSettings({ animations: "subtle" }).animations);
		expect(policy.tier).toBe("subtle");
	});
});
