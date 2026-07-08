import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { InputEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	BAR_CELLS,
	CHARGE_TAU_CHARS,
	chargeBucket,
	chargeFraction,
	filledCells,
	RELEASE_DURATION_MS,
	releaseIntensity,
	releaseProgress,
} from "@oh-my-pi/pi-coding-agent/prompt-charge/charge";
import { type PromptChargeContext, PromptChargeController } from "@oh-my-pi/pi-coding-agent/prompt-charge/controller";
import { PromptChargeState } from "@oh-my-pi/pi-coding-agent/prompt-charge/state";
import {
	type PromptChargeTheme,
	PromptChargeWidget,
	renderPromptChargeOffText,
	renderPromptChargeRow,
} from "@oh-my-pi/pi-coding-agent/prompt-charge/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: PromptChargeTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color token the renderer chose.
const taggedTheme: PromptChargeTheme = { fg: (color, text) => `${color}:${text}` };

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

const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

function inputEvent(text: string): InputEvent {
	return { type: "input", text, source: "interactive" };
}

describe("prompt charge pure math", () => {
	it("chargeFraction is 0 for empty/negative input and climbs monotonically with length", () => {
		expect(chargeFraction(0)).toBe(0);
		expect(chargeFraction(-5)).toBe(0);
		const a = chargeFraction(10);
		const b = chargeFraction(50);
		const c = chargeFraction(200);
		expect(a).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
		expect(c).toBeLessThan(1);
	});

	it("chargeFraction reaches ~63% (1 - 1/e) at tau characters", () => {
		expect(chargeFraction(CHARGE_TAU_CHARS)).toBeCloseTo(1 - 1 / Math.E, 5);
	});

	it("chargeFraction never reaches or exceeds 1 for any finite length", () => {
		expect(chargeFraction(2000)).toBeLessThan(1);
	});

	it("releaseProgress is 0 at/before the start, climbs linearly, and clamps to 1 at/after RELEASE_DURATION_MS", () => {
		expect(releaseProgress(0, 0)).toBe(0);
		expect(releaseProgress(50, 100)).toBe(0); // before the release started
		expect(releaseProgress(RELEASE_DURATION_MS / 2, 0)).toBeCloseTo(0.5, 5);
		expect(releaseProgress(RELEASE_DURATION_MS, 0)).toBe(1);
		expect(releaseProgress(RELEASE_DURATION_MS * 10, 0)).toBe(1);
	});

	it("releaseIntensity starts at chargeAtRelease and decays to 0 as progress reaches 1", () => {
		expect(releaseIntensity(0.8, 0)).toBe(0.8);
		expect(releaseIntensity(0.8, 1)).toBe(0);
		const mid = releaseIntensity(0.8, 0.5);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(0.8);
	});

	it("releaseIntensity is monotonically non-increasing in progress", () => {
		let prev = releaseIntensity(1, 0);
		for (const progress of [0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
			const next = releaseIntensity(1, progress);
			expect(next).toBeLessThanOrEqual(prev);
			prev = next;
		}
	});

	it("filledCells clamps to [0, BAR_CELLS] and rounds to the nearest cell", () => {
		expect(filledCells(0)).toBe(0);
		expect(filledCells(1)).toBe(BAR_CELLS);
		expect(filledCells(-1)).toBe(0);
		expect(filledCells(2)).toBe(BAR_CELLS);
		expect(filledCells(0.5)).toBe(Math.round(0.5 * BAR_CELLS));
	});

	it("chargeBucket classifies ascending fractions in order: idle, building, charged, full", () => {
		expect(chargeBucket(0)).toBe("idle");
		expect(chargeBucket(0.2)).toBe("building");
		expect(chargeBucket(0.6)).toBe("charged");
		expect(chargeBucket(0.95)).toBe("full");
	});
});

describe("prompt charge state", () => {
	it("sampleEditorLength records the live typed character count", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(42);
		expect(state.snapshot().typedChars).toBe(42);
	});

	it("sampleEditorLength clamps negative/NaN input to 0", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(-3);
		expect(state.snapshot().typedChars).toBe(0);
		state.sampleEditorLength(Number.NaN);
		expect(state.snapshot().typedChars).toBe(0);
	});

	it("release stamps the captured charge and start time", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(200);
		state.release(chargeFraction(200), 1000);
		const snapshot = state.snapshot();
		expect(snapshot.chargeAtRelease).toBeCloseTo(chargeFraction(200), 10);
		expect(snapshot.releaseStartAt).toBe(1000);
	});

	it("a later release supersedes an earlier one", () => {
		const state = new PromptChargeState();
		state.release(0.5, 100);
		state.release(0.9, 500);
		const snapshot = state.snapshot();
		expect(snapshot.chargeAtRelease).toBe(0.9);
		expect(snapshot.releaseStartAt).toBe(500);
	});
});

describe("prompt charge rendering (byte-stable)", () => {
	it("renders idle (empty bar) before any typing", () => {
		const state = new PromptChargeState();
		const row = renderPromptChargeRow(state.snapshot(), 0, idTheme, "full");
		expect(row).toContain("▱".repeat(BAR_CELLS));
		expect(row).toContain("0%");
	});

	it("full tier shows the glyph, bar, and percentage; subtle drops the percentage", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(200);
		const full = renderPromptChargeRow(state.snapshot(), 0, idTheme, "full");
		const subtle = renderPromptChargeRow(state.snapshot(), 0, idTheme, "subtle");
		expect(full).toContain("⚡");
		expect(full).toMatch(/\d+%/);
		expect(subtle).toContain("⚡");
		expect(subtle).not.toMatch(/\d+%/);
	});

	it("a longer typed prompt fills more bar cells than a short one", () => {
		const short = new PromptChargeState();
		short.sampleEditorLength(5);
		const long = new PromptChargeState();
		long.sampleEditorLength(300);
		const shortRow = renderPromptChargeRow(short.snapshot(), 0, idTheme, "full");
		const longRow = renderPromptChargeRow(long.snapshot(), 0, idTheme, "full");
		expect(shortRow).not.toBe(longRow);
	});

	it("rendering is deterministic given the same snapshot and elapsedMs", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(80);
		const a = renderPromptChargeRow(state.snapshot(), 500, idTheme, "full");
		const b = renderPromptChargeRow(state.snapshot(), 500, idTheme, "full");
		expect(a).toBe(b);
	});

	it("a release burst displays at full captured intensity immediately after submit, even though typed chars reset to 0", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(300);
		const chargeAtSubmit = chargeFraction(300);
		state.release(chargeAtSubmit, 1000);
		state.sampleEditorLength(0); // editor clears immediately on submit

		const atRelease = renderPromptChargeRow(state.snapshot(), 1000, taggedTheme, "full");
		const idle = renderPromptChargeRow(
			{ typedChars: 0, releaseStartAt: undefined, chargeAtRelease: 0 },
			0,
			taggedTheme,
			"full",
		);
		expect(atRelease).not.toBe(idle);
		expect(atRelease).toContain(`${Math.round(chargeAtSubmit * 100)}%`);
	});

	it("a release burst decays back to idle once RELEASE_DURATION_MS has fully elapsed", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(300);
		state.release(chargeFraction(300), 0);
		state.sampleEditorLength(0);

		const settled = renderPromptChargeRow(state.snapshot(), RELEASE_DURATION_MS * 10, idTheme, "full");
		expect(settled).toContain("0%");
	});

	it("renderPromptChargeOffText reports idle before any typing", () => {
		const state = new PromptChargeState();
		expect(renderPromptChargeOffText(state.snapshot())).toBe("⚡ idle");
	});

	it("renderPromptChargeOffText reports the live charge percentage before any submit", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(300);
		expect(renderPromptChargeOffText(state.snapshot())).toBe(`⚡ ${Math.round(chargeFraction(300) * 100)}% charged`);
	});

	it("renderPromptChargeOffText reports the released percentage once a submit has happened", () => {
		const state = new PromptChargeState();
		state.sampleEditorLength(300);
		state.release(chargeFraction(300), 0);
		expect(renderPromptChargeOffText(state.snapshot())).toBe(
			`⚡ released (${Math.round(chargeFraction(300) * 100)}%)`,
		);
	});
});

describe("PromptChargeWidget", () => {
	it("polls getEditorText every frame and renders the resulting charge", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PromptChargeState();
		let editorText = "";
		const widget = new PromptChargeWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			getEditorText: () => editorText,
		});

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		const initial = widget.render(80);
		editorText = "a".repeat(300);
		scheduler.advance(1000 / 30);
		const next = widget.render(80);
		expect(next).not.toEqual(initial);
		expect(state.snapshot().typedChars).toBe(300);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes, so it never polls the editor", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PromptChargeState();
		let pollCount = 0;
		const widget = new PromptChargeWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			getEditorText: () => {
				pollCount++;
				return "";
			},
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		widget.render(80);
		scheduler.advance(1000);
		expect(pollCount).toBe(0);
	});
});

describe("prompt charge controller", () => {
	function recordingContext(overrides: Partial<PromptChargeContext> = {}): {
		ctx: PromptChargeContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: PromptChargeContext = {
			hasUI: true,
			isTTY: true,
			env: {},
			motionSetting: "full",
			theme: idTheme,
			getEditorText: () => "",
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	it("mounts an animated widget unconditionally on the first mount() call", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext();

		controller.mount(ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		controller.mount(ctx);
		expect(calls).toHaveLength(1); // idempotent: no remount
	});

	it("stays dormant with no UI surface", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.mount(ctx);
		expect(calls).toHaveLength(0);
	});

	it("falls back to a static widget outside a TTY even when animations are on", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.mount(ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("onInput starts a release burst sized to the submitted text's length", () => {
		const scheduler = manualScheduler();
		const controller = new PromptChargeController({ scheduler });
		const { ctx } = recordingContext();

		controller.mount(ctx);
		controller.onInput(inputEvent("a".repeat(200)), ctx);

		const snapshot = controller.state.snapshot();
		expect(snapshot.chargeAtRelease).toBeCloseTo(chargeFraction(200), 10);
		expect(snapshot.releaseStartAt).toBe(0);
	});

	it("onInput mounts the widget if it has not mounted yet", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext();

		controller.onInput(inputEvent("hello"), ctx);
		expect(calls).toHaveLength(1);
	});

	it("onInput redraws the static off-tier line, only reporting the release", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.mount(ctx);
		expect((calls[0].content as string[])[0]).toBe("⚡ idle");

		controller.onInput(inputEvent("a".repeat(300)), ctx);
		expect(calls).toHaveLength(2);
		expect((calls[calls.length - 1].content as string[])[0]).toBe(
			`⚡ released (${Math.round(chargeFraction(300) * 100)}%)`,
		);
	});

	it("onInput is a no-op with no UI surface", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onInput(inputEvent("hello"), ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().releaseStartAt).toBeUndefined();
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new PromptChargeController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.mount(ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: PromptChargeTheme) => PromptChargeWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});

	it("dispose is idempotent when never mounted", () => {
		const controller = new PromptChargeController();
		const { ctx, calls } = recordingContext();
		controller.dispose(ctx);
		expect(calls).toHaveLength(0);
	});
});
