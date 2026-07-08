import { describe, expect, it } from "bun:test";
import { AnimationHost, MotionPolicy } from "@oh-my-pi/pi-animation";
import { ContextWeatherWidget } from "../src/widget";
import { FakeScheduler, fakeTheme, noopHost, usageFixture } from "./helpers";

const theme = fakeTheme();

function offPolicy(): MotionPolicy {
	return new MotionPolicy({ hasUI: true, isTTY: true, env: {} }, "off");
}
function fullPolicy(): MotionPolicy {
	return new MotionPolicy({ hasUI: true, isTTY: true, env: {} }, "full");
}

describe("ContextWeatherWidget — event-driven refresh (off tier / static)", () => {
	it("recomputes and repaints on setUsage without any frame tick", () => {
		const scheduler = new FakeScheduler();
		const policy = offPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const widget = new ContextWeatherWidget({
			tui: noopHost,
			host,
			policy,
			theme,
			style: "bar",
			stormAtPercent: 85,
			initialUsage: usageFixture(30),
		});

		// Off tier: never subscribes, no timer — proves the refresh is not frame-driven.
		expect(widget.animating).toBe(false);
		expect(host.running).toBe(false);

		const before = widget.render(30).join("");
		expect(before).toContain("30%");

		const changed = widget.setUsage(usageFixture(60));
		expect(changed).toBe(true);

		const after = widget.render(30).join("");
		expect(after).toContain("60%");
		expect(after).not.toBe(before);
	});

	it("returns false and stays put when usage does not change the visual state", () => {
		const scheduler = new FakeScheduler();
		const policy = offPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const widget = new ContextWeatherWidget({
			tui: noopHost,
			host,
			policy,
			theme,
			style: "bar",
			stormAtPercent: 85,
			initialUsage: usageFixture(60),
		});
		expect(widget.setUsage(usageFixture(60))).toBe(false);
	});
});

describe("ContextWeatherWidget — usage recomputed on change, not per-frame", () => {
	it("keeps level/fill constant across frames while usage is unchanged", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const widget = new ContextWeatherWidget({
			tui: noopHost,
			host,
			policy,
			theme,
			style: "tide",
			stormAtPercent: 85,
			initialUsage: usageFixture(55),
		});

		widget.render(40);
		const level = widget.state.level;
		const fill = widget.state.fillRatio;
		for (let i = 0; i < 20; i++) {
			scheduler.step();
			expect(widget.state.level).toBe(level);
			expect(widget.state.fillRatio).toBe(fill);
		}

		// Only a usage event moves the model.
		widget.setUsage(usageFixture(92));
		expect(widget.state.level).toBe("error");
	});
});

describe("ContextWeatherWidget — mount/dispose leaves no host subscription", () => {
	it("subscribes on mount (animating tier) and unsubscribes on dispose", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const widget = new ContextWeatherWidget({
			tui: noopHost,
			host,
			policy,
			theme,
			style: "tide",
			stormAtPercent: 85,
			initialUsage: usageFixture(55),
		});

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);
		expect(host.running).toBe(true);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(widget.animating).toBe(false);
		expect(host.running).toBe(false);
	});
});
