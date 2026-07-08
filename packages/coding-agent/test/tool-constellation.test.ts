import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { CATEGORY_ICON, categorizeTool } from "@oh-my-pi/pi-coding-agent/tool-constellation/categories";
import {
	type ToolConstellationContext,
	ToolConstellationController,
} from "@oh-my-pi/pi-coding-agent/tool-constellation/controller";
import {
	assignCell,
	GRID_CELLS,
	hashCell,
	isTwinkling,
	STAR_GLYPHS,
	starBrightness,
	starGlyph,
} from "@oh-my-pi/pi-coding-agent/tool-constellation/sky";
import { ConstellationState } from "@oh-my-pi/pi-coding-agent/tool-constellation/state";
import {
	type ConstellationTheme,
	renderConstellationGrid,
	renderConstellationTally,
	ToolConstellationWidget,
} from "@oh-my-pi/pi-coding-agent/tool-constellation/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: ConstellationTheme = { fg: (_color, text) => text };

/** Manual frame scheduler: drives host ticks and the shared clock deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

function toolCallEvent(toolName: string, toolCallId = "1"): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input: {} } as ToolCallEvent;
}

describe("tool constellation category classification", () => {
	it("maps builtin tool names, legacy aliases, and mcp bridge names to the bead's palette buckets", () => {
		expect(categorizeTool("read")).toBe("read");
		expect(categorizeTool("edit")).toBe("write");
		expect(categorizeTool("write")).toBe("write");
		expect(categorizeTool("bash")).toBe("bash");
		expect(categorizeTool("grep")).toBe("search");
		expect(categorizeTool("glob")).toBe("search");
		expect(categorizeTool("search")).toBe("search"); // legacy alias -> grep
		expect(categorizeTool("find")).toBe("search"); // legacy alias -> glob
		expect(categorizeTool("task")).toBe("agent");
		expect(categorizeTool("mcp__puppeteer_screenshot")).toBe("mcp");
		expect(categorizeTool("some_custom_tool")).toBe("other");
	});

	it("gives every category a distinct static-tally icon", () => {
		const icons = Object.values(CATEGORY_ICON);
		expect(new Set(icons).size).toBe(icons.length);
	});
});

describe("tool constellation grid math", () => {
	it("hashCell is a deterministic pure function of the tool name", () => {
		expect(hashCell("bash")).toBe(hashCell("bash"));
		expect(hashCell("bash", GRID_CELLS)).toBeGreaterThanOrEqual(0);
		expect(hashCell("bash", GRID_CELLS)).toBeLessThan(GRID_CELLS);
	});

	it("assignCell linear-probes past occupied cells to the next free one, deterministically", () => {
		const hash = hashCell("bash", 4);
		const occupied = new Set([hash]);
		const assigned = assignCell("bash", occupied, 4);
		expect(assigned).not.toBe(hash);
		expect(occupied.has(assigned)).toBe(false);
		// Re-running with the same occupancy set yields the same probe result.
		expect(assignCell("bash", occupied, 4)).toBe(assigned);
	});

	it("assignCell returns the raw hash slot immediately when it is free", () => {
		const assigned = assignCell("read", new Set(), GRID_CELLS);
		expect(assigned).toBe(hashCell("read", GRID_CELLS));
	});

	it("starBrightness decays monotonically with elapsed and a fresh fire resets to max", () => {
		expect(starBrightness(0)).toBe(1);
		expect(starBrightness(260)).toBe(1); // still within the flare hold window
		const samples = [260, 500, 1000, 2000, 5000, Number.POSITIVE_INFINITY].map(starBrightness);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
		}
		expect(starBrightness(Number.POSITIVE_INFINITY)).toBeCloseTo(0.12, 5); // settles at the floor, never fired
		expect(starBrightness(0)).toBeGreaterThan(starBrightness(5000)); // fresh fire is brighter than a stale one
	});

	it("starGlyph is monotonic non-decreasing along the brightness ramp", () => {
		const glyphIndices = [0, 0.2, 0.4, 0.6, 0.8, 1].map(b =>
			STAR_GLYPHS.indexOf(starGlyph(b) as (typeof STAR_GLYPHS)[number]),
		);
		const sorted = [...glyphIndices].sort((a, b) => a - b);
		expect(glyphIndices).toEqual(sorted);
		expect(starGlyph(0)).toBe(STAR_GLYPHS[0]);
		expect(starGlyph(1)).toBe(STAR_GLYPHS[STAR_GLYPHS.length - 1]);
	});

	it("isTwinkling fires a short periodic blip per cell, offset by cell index", () => {
		expect(isTwinkling(0, 0)).toBe(true);
		expect(isTwinkling(0, 139)).toBe(true);
		expect(isTwinkling(0, 200)).toBe(false);
		// Cell 1 is phase-shifted: at a moment cell 0 is mid-blip, cell 1 already is not.
		expect(isTwinkling(0, 138)).toBe(true);
		expect(isTwinkling(1, 138)).toBe(false);
	});
});

describe("tool constellation grid rendering (pure)", () => {
	it("is byte-stable across repeated calls with the same snapshot and elapsed time", () => {
		const snapshot = {
			stars: [
				{ toolName: "bash", category: "bash" as const, cell: 2, lastFireAt: 1000, fireCount: 3 },
				{ toolName: "read", category: "read" as const, cell: 5, lastFireAt: 1000, fireCount: 1 },
			],
			lastFired: "read",
			previousFired: "bash",
		};
		const first = renderConstellationGrid(snapshot, 1600, idTheme, "full");
		const second = renderConstellationGrid(snapshot, 1600, idTheme, "full");
		expect(first).toEqual(second);
		expect(first).toHaveLength(3); // GRID_ROWS
	});

	it("renders the newest fired star as a comet head within the comet window", () => {
		const snapshot = {
			stars: [{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 1000, fireCount: 1 }],
			lastFired: "bash",
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 1200, idTheme, "full"); // 200ms since fire, inside the 500ms comet window
		expect(rows[0]?.startsWith("☄")).toBe(true);
	});

	it("renders a non-comet recently-fired star at the top of the flare ramp", () => {
		const snapshot = {
			stars: [
				{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 1000, fireCount: 1 },
				{ toolName: "read", category: "read" as const, cell: 1, lastFireAt: 1000, fireCount: 1 },
			],
			lastFired: "read", // bash is the *other* star, not the comet head
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 1200, idTheme, "full");
		expect(rows[0]?.startsWith(STAR_GLYPHS[STAR_GLYPHS.length - 1])).toBe(true);
	});

	it("decays a long-idle star down to the dim background glyph", () => {
		const snapshot = {
			stars: [{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 0, fireCount: 1 }],
			lastFired: "bash",
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 500_000, idTheme, "full");
		expect(rows[0]?.startsWith(STAR_GLYPHS[0])).toBe(true);
	});

	it("draws a ley-line only between the last two distinct fired stars sharing a grid row", () => {
		const sameRow = renderConstellationGrid(
			{
				stars: [
					{ toolName: "a", category: "read" as const, cell: 2, lastFireAt: 0, fireCount: 1 },
					{ toolName: "b", category: "bash" as const, cell: 5, lastFireAt: 0, fireCount: 1 },
				],
				lastFired: "b",
				previousFired: "a",
			},
			600, // past the comet window so glyph choice doesn't obscure the connector cells
			idTheme,
			"full",
		);
		expect(sameRow[0]).toContain("─");

		const differentRow = renderConstellationGrid(
			{
				stars: [
					{ toolName: "a", category: "read" as const, cell: 2, lastFireAt: 0, fireCount: 1 },
					{ toolName: "b", category: "bash" as const, cell: 15, lastFireAt: 0, fireCount: 1 },
				],
				lastFired: "b",
				previousFired: "a",
			},
			600,
			idTheme,
			"full",
		);
		expect(differentRow.join("")).not.toContain("─");
	});

	it("subtle tier renders binary brighten-on-fire dots with no comet, twinkle, or ley-line", () => {
		const rows = renderConstellationGrid(
			{
				stars: [
					{ toolName: "a", category: "read" as const, cell: 2, lastFireAt: 0, fireCount: 1 },
					{ toolName: "b", category: "bash" as const, cell: 5, lastFireAt: 0, fireCount: 1 },
				],
				lastFired: "b",
				previousFired: "a",
			},
			0,
			idTheme,
			"subtle",
		);
		expect(rows.join("")).not.toContain("☄");
		expect(rows.join("")).not.toContain("─");
	});
});

describe("tool constellation static tally", () => {
	it("formats one segment per category with a nonzero count, in a fixed order", () => {
		const counts = new Map([
			["bash" as const, 3],
			["read" as const, 12],
		]);
		const line = renderConstellationTally(counts, idTheme);
		expect(line).toBe(`${CATEGORY_ICON.read} 12 · ${CATEGORY_ICON.bash} 3`);
	});

	it("falls back to a placeholder when nothing has fired yet", () => {
		expect(renderConstellationTally(new Map(), idTheme)).toContain("no tool activity");
	});
});

describe("tool constellation widget lifecycle", () => {
	it("subscribes on mount, reflects the shared clock, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.recordFire("bash", scheduler.now());
		const widget = new ToolConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);
		expect(host.running).toBe(true);

		const initial = widget.render(80);
		scheduler.advance(5000); // well past the flare/comet window
		const decayed = widget.render(80);
		expect(decayed).not.toEqual(initial); // frame clock drove the decay

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.recordFire("bash", scheduler.now());
		const widget = new ToolConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		// off tier resolves through the widget's subtle branch: a bright dot, never a comet/ley-line.
		expect(widget.render(80).join("")).toContain("•");
		expect(widget.render(80).join("")).not.toContain("☄");
	});
});

describe("tool constellation controller", () => {
	function recordingContext(
		_scheduler: FrameScheduler,
		overrides: Partial<ToolConstellationContext> = {},
	): { ctx: ToolConstellationContext; calls: Array<{ key: string; content: unknown }> } {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: ToolConstellationContext = {
			hasUI: true,
			isTTY: true,
			env: {},
			motionSetting: "full",
			theme: idTheme,
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	it("mounts an animated widget on the first tool_call and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler);

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: ConstellationTheme) => ToolConstellationWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);
		expect(scheduler.running).toBe(true);

		controller.onToolCall(toolCallEvent("read"), ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.categoryCounts().get("bash")).toBe(1);
		expect(controller.state.categoryCounts().get("read")).toBe(1);
	});

	it("renders and updates a static tally for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler, { motionSetting: "off" });

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
		expect((calls[0].content as string[])[0]).toContain(CATEGORY_ICON.bash);
		expect(scheduler.running).toBe(false); // static tier never starts the shared frame clock

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect((calls[1].content as string[])[0]).toContain("2"); // second fire bumps the tally in place
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler, { isTTY: false, motionSetting: "full" });

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler, { hasUI: false });

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler);

		controller.onToolCall(toolCallEvent("bash"), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: ConstellationTheme) => ToolConstellationWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
