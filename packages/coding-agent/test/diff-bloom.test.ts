import { describe, expect, it } from "bun:test";
import { AnimationHost, backpressureFromTui, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import {
	BLOOM_DURATION_MS,
	BLOOM_GROW_MS,
	bloomGlyph,
	bloomIntensity,
	bloomProgress,
	filledCellCount,
	lineFraction,
	MAX_REFERENCE_LINES,
} from "@oh-my-pi/pi-coding-agent/diff-bloom/bloom";
import { type DiffBloomContext, DiffBloomController } from "@oh-my-pi/pi-coding-agent/diff-bloom/controller";
import { DiffBloomState } from "@oh-my-pi/pi-coding-agent/diff-bloom/state";
import {
	type DiffBloomTheme,
	DiffBloomWidget,
	renderDiffBloomIdleRow,
	renderDiffBloomOffText,
	renderDiffBloomRow,
} from "@oh-my-pi/pi-coding-agent/diff-bloom/widget";
import type { EditToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: DiffBloomTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which token the renderer chose.
const taggedTheme: DiffBloomTheme = { fg: (color, text) => `${color}:${text}` };

/** Manual frame scheduler: drives host ticks deterministically. */
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

const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

/** Records every `setWidget` call for assertion, with sensible full-motion defaults. */
function recordingContext(overrides: Partial<DiffBloomContext> = {}): {
	ctx: DiffBloomContext;
	calls: Array<{ key: string; content: unknown }>;
} {
	const calls: Array<{ key: string; content: unknown }> = [];
	const ctx: DiffBloomContext = {
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

const sampleDiff = ["+1|line one", "+2|line two", "-1|old line"].join("\n");

class ToggleTui {
	renderUnderPressure = false;
	requestComponentRender(): void {}
}

/** Build a minimal `edit` `tool_result` event with the given diff. */
function editResult(diff: string, opts: { path?: string; isError?: boolean } = {}): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path: opts.path ?? "src/foo.ts" },
		content: [{ type: "text", text: "ok" }],
		isError: opts.isError ?? false,
		details: { diff, path: opts.path },
	};
}

describe("diff bloom pure math", () => {
	it("bloomProgress is 0 at the start, 1 at the boundary, and clamps beyond", () => {
		expect(bloomProgress(0, 1000)).toBe(0);
		expect(bloomProgress(500, 1000)).toBe(0.5);
		expect(bloomProgress(1000, 1000)).toBe(1);
		expect(bloomProgress(5000, 1000)).toBe(1);
		expect(bloomProgress(-100, 1000)).toBe(0);
	});

	it("bloomIntensity grows from 0 to 1 by BLOOM_GROW_MS, then wipes back to 0 by BLOOM_DURATION_MS", () => {
		expect(bloomIntensity(0)).toBe(0);
		expect(bloomIntensity(BLOOM_GROW_MS)).toBeCloseTo(1, 5);
		expect(bloomIntensity(BLOOM_DURATION_MS)).toBe(0);
		expect(bloomIntensity(BLOOM_DURATION_MS + 500)).toBe(0);
	});

	it("bloomIntensity is monotonically non-decreasing during grow, then non-increasing during wipe", () => {
		const growSamples = Array.from({ length: 5 }, (_, i) => bloomIntensity((i * BLOOM_GROW_MS) / 4));
		for (let i = 1; i < growSamples.length; i++) {
			expect(growSamples[i]).toBeGreaterThanOrEqual(growSamples[i - 1] - 1e-9);
		}
		const wipeSamples = Array.from({ length: 6 }, (_, i) =>
			bloomIntensity(BLOOM_GROW_MS + (i * (BLOOM_DURATION_MS - BLOOM_GROW_MS)) / 5),
		);
		for (let i = 1; i < wipeSamples.length; i++) {
			expect(wipeSamples[i]).toBeLessThanOrEqual(wipeSamples[i - 1] + 1e-9);
		}
	});

	it("lineFraction clamps at MAX_REFERENCE_LINES and is 0 for non-positive input", () => {
		expect(lineFraction(0)).toBe(0);
		expect(lineFraction(-5)).toBe(0);
		expect(lineFraction(MAX_REFERENCE_LINES)).toBe(1);
		expect(lineFraction(MAX_REFERENCE_LINES * 10)).toBe(1);
		expect(lineFraction(MAX_REFERENCE_LINES / 2)).toBeCloseTo(0.5, 5);
	});

	it("bloomGlyph maps low intensity to a fainter glyph than high intensity", () => {
		expect(bloomGlyph(0)).toBe(" ");
		expect(bloomGlyph(1)).toBe("█");
		expect(bloomGlyph(0.1)).not.toBe(bloomGlyph(0.9));
	});

	it("filledCellCount scales with lines, segment width, and intensity; 0 at any zero factor", () => {
		expect(filledCellCount(0, 10, 1)).toBe(0);
		expect(filledCellCount(20, 0, 1)).toBe(0);
		expect(filledCellCount(20, 10, 0)).toBe(0);
		expect(filledCellCount(MAX_REFERENCE_LINES, 10, 1)).toBe(10);
		expect(filledCellCount(MAX_REFERENCE_LINES / 2, 10, 1)).toBe(5);
	});
});

describe("diff bloom pure rendering", () => {
	it("width <= 0 renders an empty row", () => {
		expect(renderDiffBloomRow(500, 0, taggedTheme, 5, 5, "full")).toBe("");
		expect(renderDiffBloomIdleRow(0, idTheme)).toBe("");
	});

	it("the idle row is byte-identical across repeated calls and carries no bloom glyph", () => {
		const a = renderDiffBloomIdleRow(12, idTheme);
		const b = renderDiffBloomIdleRow(12, idTheme);
		expect(a).toBe(b);
		expect(a).toBe("·".repeat(12));
	});

	it("at intensity 0 (elapsed >= BLOOM_DURATION_MS) full tier renders the plain idle row", () => {
		const row = renderDiffBloomRow(BLOOM_DURATION_MS, 20, taggedTheme, 30, 10, "full");
		expect(row).toBe(renderDiffBloomIdleRow(20, taggedTheme));
	});

	it("full tier: added cells render on the left half with the added token, removed on the right half with the removed token", () => {
		const row = renderDiffBloomRow(BLOOM_GROW_MS, 20, taggedTheme, MAX_REFERENCE_LINES, MAX_REFERENCE_LINES, "full");
		expect(row.includes("toolDiffAdded:")).toBe(true);
		expect(row.includes("toolDiffRemoved:")).toBe(true);
		const addedIndex = row.indexOf("toolDiffAdded:");
		const removedIndex = row.indexOf("toolDiffRemoved:");
		expect(addedIndex).toBeLessThan(removedIndex);
	});

	it("full tier: more added lines fill more of the left segment than fewer added lines", () => {
		const width = 20;
		const heavy = renderDiffBloomRow(BLOOM_GROW_MS, width, taggedTheme, MAX_REFERENCE_LINES, 0, "full");
		const light = renderDiffBloomRow(BLOOM_GROW_MS, width, taggedTheme, 1, 0, "full");
		const countToken = (row: string, token: string) => row.split(token).length - 1;
		expect(countToken(heavy, "toolDiffAdded:")).toBeGreaterThan(countToken(light, "toolDiffAdded:"));
	});

	it("full tier: zero added and zero removed renders a plain background with no colored cells", () => {
		const row = renderDiffBloomRow(BLOOM_GROW_MS, 20, taggedTheme, 0, 0, "full");
		expect(row.includes("toolDiffAdded:")).toBe(false);
		expect(row.includes("toolDiffRemoved:")).toBe(false);
	});

	it("subtle tier: a single centered glyph colored by whichever side dominates", () => {
		const width = 11;
		const addedDominant = renderDiffBloomRow(BLOOM_GROW_MS, width, taggedTheme, 30, 5, "subtle");
		const removedDominant = renderDiffBloomRow(BLOOM_GROW_MS, width, taggedTheme, 5, 30, "subtle");
		expect(addedDominant.includes("toolDiffAdded:")).toBe(true);
		expect(removedDominant.includes("toolDiffRemoved:")).toBe(true);
	});

	it("subtle tier at width 1 renders a single glyph with no background", () => {
		const row = renderDiffBloomRow(BLOOM_GROW_MS, 1, taggedTheme, 10, 2, "subtle");
		expect(row.startsWith("toolDiffAdded:")).toBe(true);
	});

	it("the off-tier text names the path and added/removed counts, and falls back to a neutral message before any bloom", () => {
		expect(renderDiffBloomOffText({ path: undefined, added: 0, removed: 0, bloomCount: 0 })).toBe("no edits yet");
		expect(renderDiffBloomOffText({ path: "src/foo.ts", added: 12, removed: 4, bloomCount: 1 })).toBe(
			"🌸 src/foo.ts +12/-4",
		);
	});
});

describe("DiffBloomState", () => {
	it("starts idle and a bloom moves it to blooming, tracking path/added/removed and a running bloom count", () => {
		const state = new DiffBloomState();
		expect(state.phase).toBe("idle");
		expect(state.snapshot()).toEqual({ phase: "idle", path: undefined, added: 0, removed: 0, bloomCount: 0 });

		state.applyBloom("src/foo.ts", 12, 4, 1000);
		expect(state.phase).toBe("blooming");
		expect(state.snapshot()).toEqual({ phase: "blooming", path: "src/foo.ts", added: 12, removed: 4, bloomCount: 1 });
		expect(state.bloomElapsedMs(1500)).toBe(500);
	});

	it("settleIfDone flips to idle exactly at the settle boundary and only fires once", () => {
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 1, 0, 0);

		expect(state.settleIfDone(BLOOM_DURATION_MS - 1)).toBe(false);
		expect(state.phase).toBe("blooming");

		expect(state.settleIfDone(BLOOM_DURATION_MS)).toBe(true);
		expect(state.phase).toBe("idle");
		expect(state.settleIfDone(BLOOM_DURATION_MS + 500)).toBe(false);
	});

	it("a fresh bloom while still blooming restarts the flower and updates path/counts", () => {
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 5, 1, 0);
		state.applyBloom("b.ts", 2, 9, 400);
		expect(state.phase).toBe("blooming");
		expect(state.snapshot()).toEqual({ phase: "blooming", path: "b.ts", added: 2, removed: 9, bloomCount: 2 });
		expect(state.bloomElapsedMs(500)).toBe(100);
	});

	it("settleIfDone on an already-idle state is a no-op", () => {
		const state = new DiffBloomState();
		expect(state.settleIfDone(10_000)).toBe(false);
	});
});

describe("DiffBloomWidget", () => {
	it("renders phase-varying rows while blooming, driven by the injected clock", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 20, 5, 0);
		const tui = new ToggleTui();
		const widget = new DiffBloomWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		const first = widget.render(20)[0];
		scheduler.advance(BLOOM_GROW_MS);
		widget.markDirty();
		const second = widget.render(20)[0];
		expect(second).not.toBe(first);
		widget.dispose();
	});

	it("idle produces a single static frame; disposing leaves zero subscribers", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new DiffBloomState(); // never bloomed -> idle
		const tui = new ToggleTui();
		const widget = new DiffBloomWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		expect(widget.render(20)[0]).toBe(renderDiffBloomIdleRow(20, idTheme));
		scheduler.advance(1000);
		expect(widget.render(20)[0]).toBe(renderDiffBloomIdleRow(20, idTheme));
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("a bloom fires exactly one grow-and-wipe sequence, calling onSettled once when it fully wipes clear", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new DiffBloomState();
		let settledCount = 0;
		const tui = new ToggleTui();
		const widget = new DiffBloomWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {
				settledCount++;
			},
		});
		widget.render(20);

		state.applyBloom("a.ts", 10, 2, scheduler.now());

		scheduler.advance(BLOOM_DURATION_MS - 1);
		expect(settledCount).toBe(0);

		scheduler.advance(1);
		expect(settledCount).toBe(1);
		expect(state.phase).toBe("idle");

		scheduler.advance(1000);
		expect(settledCount).toBe(1);
		widget.dispose();
	});

	it("backpressure freezes the widget instantly: no frame is emitted while under pressure, the widget stays subscribed, and it resumes once pressure clears", () => {
		const scheduler = manualScheduler();
		const tui = new ToggleTui();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, backpressure: backpressureFromTui(tui), scheduler });
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 10, 2, 0);
		const widget = new DiffBloomWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});
		widget.render(20);
		expect(widget.animating).toBe(true);

		scheduler.advance(1000 / 30);
		const elapsedBeforePressure = widget.elapsedMs;
		expect(elapsedBeforePressure).toBeGreaterThan(0);

		tui.renderUnderPressure = true;
		scheduler.advance(1000 / 30);
		scheduler.advance(1000 / 30);
		// Host-level backpressure skips frame emission entirely (not a tier
		// flip): the widget stays subscribed and its phase freezes at the last
		// emitted frame instead of collapsing to the static `off` frame.
		expect(policy.tier).toBe("full");
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);
		expect(widget.elapsedMs).toBe(elapsedBeforePressure);

		tui.renderUnderPressure = false;
		scheduler.advance(1000 / 30);
		expect(widget.elapsedMs).toBeGreaterThan(elapsedBeforePressure);
		widget.dispose();
	});

	it("still responds to a live tier change via the policy subscription independently of host-level backpressure", () => {
		const scheduler = manualScheduler();
		const tui = new ToggleTui();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, backpressure: backpressureFromTui(tui), scheduler });
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 10, 2, 0);
		const widget = new DiffBloomWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});
		widget.render(20);
		expect(widget.animating).toBe(true);

		policy.setSetting("off");
		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);

		policy.setSetting("full");
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);
		widget.dispose();
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 10, 2, 0);
		const tui = new ToggleTui();
		const widget = new DiffBloomWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(20)[0]).toBe(renderDiffBloomIdleRow(20, idTheme));
	});
});

describe("diff bloom controller", () => {
	it("mounts an animated widget on the first edit tool_result with a real, non-empty diff", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff, { path: "src/foo.ts" }), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");
		expect(controller.state.phase).toBe("blooming");
		expect(controller.state.snapshot()).toEqual({
			phase: "blooming",
			path: "src/foo.ts",
			added: 2,
			removed: 1,
			bloomCount: 1,
		});
	});

	it("ignores non-edit tool results", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			{
				type: "tool_result",
				toolName: "bash",
				toolCallId: "c1",
				input: {},
				content: [],
				isError: false,
				details: undefined,
			},
			ctx,
		);
		expect(calls).toHaveLength(0);
	});

	it("ignores an edit result with no details (thrown-error path) or an empty diff", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c1",
				input: {},
				content: [],
				isError: true,
				details: undefined,
			},
			ctx,
		);
		controller.onToolResult(editResult(""), ctx);
		expect(calls).toHaveLength(0);
	});

	it("ignores a diff that parses to zero added and zero removed lines (e.g. a pure rename)", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(" 1|unchanged context line"), ctx);
		expect(calls).toHaveLength(0);
	});

	it("a second edit while still blooming restarts the flower without a second mount call", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff, { path: "a.ts" }), ctx);
		scheduler.advance(100);
		controller.onToolResult(editResult("+1|only added", { path: "b.ts" }), ctx);
		expect(calls).toHaveLength(1); // no remount — the existing animated mount just re-renders
		expect(controller.state.snapshot().path).toBe("b.ts");
	});

	it("settles back to fully unmounted after the bloom wipes clear, then a later edit remounts fresh", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff, { path: "a.ts" }), ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: DiffBloomTheme) => DiffBloomWidget;
		const tui = new ToggleTui();
		const widget = factory(tui, idTheme);
		widget.render(20);
		expect(scheduler.running).toBe(true);

		scheduler.advance(BLOOM_DURATION_MS);
		expect(controller.state.phase).toBe("idle");
		expect(scheduler.running).toBe(false); // the animated host was disposed on settle
		expect(calls[calls.length - 1].content).toBeUndefined(); // widget removed entirely, not left as a static row

		controller.onToolResult(editResult(sampleDiff, { path: "c.ts" }), ctx);
		expect(typeof calls[calls.length - 1].content).toBe("function"); // remounted fresh
	});

	it("renders a static line naming the path and counts for the off tier, refreshed on each edit", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onToolResult(editResult(sampleDiff, { path: "a.ts" }), ctx);
		expect(calls[0].content).toEqual([renderDiffBloomOffText(controller.state.snapshot())]);
		expect(scheduler.running).toBe(false);

		controller.onToolResult(editResult("+1|x\n+2|y", { path: "b.ts" }), ctx);
		expect(calls[calls.length - 1].content).toEqual([renderDiffBloomOffText(controller.state.snapshot())]);
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onToolResult(editResult(sampleDiff), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onToolResult(editResult(sampleDiff), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff), ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: DiffBloomTheme) => DiffBloomWidget;
		factory(new ToggleTui(), idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});

	it("falls back to the input path's directory-relative form when details.path is absent (multi-file diff aggregation)", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c1",
				input: {},
				content: [],
				isError: false,
				details: { diff: sampleDiff, perFileResults: [{ path: "multi/a.ts", diff: sampleDiff }] },
			},
			ctx,
		);
		expect(calls).toHaveLength(1);
		expect(controller.state.snapshot().path).toBe("multi/a.ts");
	});
});

describe("diff bloom hardening: adversarial pure math", () => {
	it("bloomProgress treats non-finite elapsedMs/durationMs consistently with the non-positive-duration guard", () => {
		expect(bloomProgress(NaN, BLOOM_DURATION_MS)).toBeNaN();
		expect(bloomProgress(500, NaN)).toBeNaN();
		expect(bloomProgress(500, 0)).toBe(1);
		expect(bloomProgress(500, -100)).toBe(1);
	});

	it("bloomIntensity(NaN) propagates NaN rather than crashing", () => {
		expect(bloomIntensity(NaN)).toBeNaN();
	});

	it("bloomIntensity(Infinity) settles to 0, matching the 'past the wipe' end state", () => {
		expect(bloomIntensity(Infinity)).toBe(0);
	});

	it("lineFraction(NaN) propagates NaN; lineFraction(Infinity) clamps to 1 like any large count", () => {
		expect(lineFraction(NaN)).toBeNaN();
		expect(lineFraction(Infinity)).toBe(1);
		expect(lineFraction(-Infinity)).toBe(0);
	});

	it("bloomGlyph(NaN) falls back to the dimmest glyph instead of returning undefined (the recurring glyph-ramp bug)", () => {
		expect(bloomGlyph(NaN)).toBe(" ");
		expect(bloomGlyph(Infinity)).toBe("█");
		expect(bloomGlyph(-Infinity)).toBe(" ");
	});

	it("filledCellCount(NaN inputs) propagates NaN rather than throwing", () => {
		expect(filledCellCount(NaN, 10, 1)).toBeNaN();
		expect(filledCellCount(20, 10, NaN)).toBeNaN();
		expect(filledCellCount(20, NaN, 1)).toBeNaN();
		expect(filledCellCount(-5, 10, 1)).toBe(0);
	});
});

describe("diff bloom hardening: rendering never leaks literal 'undefined'", () => {
	it("a NaN elapsedMs never renders the literal string 'undefined' in full tier", () => {
		const row = renderDiffBloomRow(NaN, 20, taggedTheme, 10, 3, "full");
		expect(row.includes("undefined")).toBe(false);
	});

	it("a NaN elapsedMs never renders the literal string 'undefined' in subtle tier at width > 1", () => {
		const row = renderDiffBloomRow(NaN, 11, taggedTheme, 10, 3, "subtle");
		expect(row.includes("undefined")).toBe(false);
	});

	it("an Infinity elapsedMs renders the plain idle row (past the wipe, same as any large finite elapsed)", () => {
		const row = renderDiffBloomRow(Infinity, 20, taggedTheme, 10, 3, "full");
		expect(row).toBe(renderDiffBloomIdleRow(20, taggedTheme));
	});

	it("negative width is treated the same as zero width: an empty row", () => {
		expect(renderDiffBloomRow(500, -5, taggedTheme, 5, 5, "full")).toBe("");
		expect(renderDiffBloomIdleRow(-5, idTheme)).toBe("");
	});

	it("negative added/removed counts render as an empty (unfilled) diff without crashing", () => {
		const row = renderDiffBloomRow(BLOOM_GROW_MS, 20, taggedTheme, -5, -5, "full");
		expect(row.includes("toolDiffAdded:")).toBe(false);
		expect(row.includes("toolDiffRemoved:")).toBe(false);
	});
});

describe("diff bloom hardening: DiffBloomState clock-skew and NaN-poisoning", () => {
	it("bloomElapsedMs clamps backward clock skew (now before bloomedAt) to 0 rather than going negative", () => {
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 1, 0, 1000);
		expect(state.bloomElapsedMs(500)).toBe(0);
	});

	it("a NaN trigger timestamp poisons bloomElapsedMs permanently, and settleIfDone's '<' guard reads that as already-past-threshold: the bloom settles on the very next check instead of hanging forever", () => {
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 1, 0, NaN);
		expect(state.phase).toBe("blooming");
		expect(state.bloomElapsedMs(0)).toBeNaN();

		// NaN < SETTLE_MS is false, so the "still pending" branch is skipped and
		// the state falls straight through to the idle transition — the same
		// "'<' used as a stay-pending gate is backwards for NaN" shape Reflection
		// Ripple's hardening pass first documented for settleIfDone.
		expect(state.settleIfDone(0)).toBe(true);
		expect(state.phase).toBe("idle");
	});

	it("a NaN `now` passed directly to settleIfDone (bloomedAt itself finite) has the same immediate-settle effect", () => {
		const state = new DiffBloomState();
		state.applyBloom("a.ts", 1, 0, 0);
		expect(state.settleIfDone(NaN)).toBe(true);
		expect(state.phase).toBe("idle");
	});

	it("applyBloom with a negative line count is stored as-is (no clamping at the state layer)", () => {
		const state = new DiffBloomState();
		state.applyBloom("a.ts", -3, -7, 0);
		expect(state.snapshot()).toEqual({ phase: "blooming", path: "a.ts", added: -3, removed: -7, bloomCount: 1 });
	});
});

describe("diff bloom hardening: controller dispose/remount idempotency", () => {
	it("dispose() with no prior mount is a safe no-op", () => {
		const controller = new DiffBloomController();
		const { ctx, calls } = recordingContext();
		expect(() => controller.dispose(ctx)).not.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("calling dispose() twice in a row only tears the widget down once", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff), ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;
		controller.dispose(ctx);
		expect(calls).toHaveLength(callsAfterFirstDispose); // no extra setWidget(undefined) call
	});

	it("a stale settle callback firing after the controller was already explicitly disposed is a safe no-op (guarded by the host-identity check)", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff), ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: DiffBloomTheme) => DiffBloomWidget;
		const widget = factory(new ToggleTui(), idTheme);
		widget.render(20);
		scheduler.advance(BLOOM_DURATION_MS - 1);

		controller.dispose(ctx);
		const callsAfterDispose = calls.length;

		// The orphaned widget instance still exists and its onFrame still runs
		// (nothing unsubscribed it directly) — it must not resurrect the widget
		// or double-dispose the already-torn-down host.
		expect(() => widget.onFrame(BLOOM_DURATION_MS)).not.toThrow();
		expect(calls).toHaveLength(callsAfterDispose);
	});

	it("a new edit after an explicit dispose() remounts fresh rather than staying dormant", () => {
		const scheduler = manualScheduler();
		const controller = new DiffBloomController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(sampleDiff, { path: "a.ts" }), ctx);
		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();

		controller.onToolResult(editResult(sampleDiff, { path: "b.ts" }), ctx);
		expect(typeof calls[calls.length - 1].content).toBe("function"); // remounted, not left dormant
		expect(controller.state.snapshot().bloomCount).toBe(2); // state survived dispose — only the mount tore down
	});
});
