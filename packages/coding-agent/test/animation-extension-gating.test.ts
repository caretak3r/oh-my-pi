import { describe, expect, it } from "bun:test";
import { loadAnimationExtensions } from "@oh-my-pi/pi-coding-agent/animation-extensions";

describe("animation extension gating", () => {
	it("registers no animation extensions without an interactive UI", async () => {
		expect(await loadAnimationExtensions(false)).toEqual([]);
	});

	it("registers the full 16-extension animation family for interactive sessions", async () => {
		const factories = await loadAnimationExtensions(true);
		expect(factories).toHaveLength(16);
		for (const factory of factories) expect(typeof factory).toBe("function");
		expect(new Set(factories).size).toBe(16); // all distinct
	});
});
