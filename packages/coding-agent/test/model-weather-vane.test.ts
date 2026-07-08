import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { MessageStartEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type ModelWeatherVaneContext,
	ModelWeatherVaneController,
} from "@oh-my-pi/pi-coding-agent/model-weather-vane/controller";
import { ModelWeatherVaneState } from "@oh-my-pi/pi-coding-agent/model-weather-vane/state";
import {
	DIRECTION_GLYPHS,
	MAX_LABEL_LENGTH,
	modelColor,
	modelDirectionGlyph,
	modelDirectionIndex,
	SPIN_DURATION_MS,
	spinDisplayIndex,
	spinProgress,
	truncateLabel,
	VANE_COLORS,
} from "@oh-my-pi/pi-coding-agent/model-weather-vane/vane";
import {
	type ModelWeatherVaneTheme,
	ModelWeatherVaneWidget,
	renderModelWeatherVaneOffText,
	renderModelWeatherVaneRow,
} from "@oh-my-pi/pi-coding-agent/model-weather-vane/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: ModelWeatherVaneTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color token the renderer chose.
const taggedTheme: ModelWeatherVaneTheme = { fg: (color, text) => `${color}:${text}` };

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

/** Build a minimal `message_start` event for an assistant message with the given model/provider. */
function assistantMessageStart(modelId: string, provider = "anthropic"): MessageStartEvent {
	return {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider,
			model: modelId,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		},
	} as unknown as MessageStartEvent;
}

function toolResultMessageStart(): MessageStartEvent {
	return { type: "message_start", message: { role: "toolResult" } } as unknown as MessageStartEvent;
}

describe("model weather vane pure math", () => {
	it("modelDirectionIndex is deterministic and stays within DIRECTION_GLYPHS bounds", () => {
		const ids = ["claude-sonnet-5", "claude-opus-4-8", "gpt-5.1", "gemini-3-pro", ""];
		for (const id of ids) {
			const index = modelDirectionIndex(id);
			expect(index).toBe(modelDirectionIndex(id));
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(DIRECTION_GLYPHS.length);
		}
	});

	it("different model ids hash to different slots often enough to look distinct", () => {
		const ids = ["claude-sonnet-5", "claude-opus-4-8", "gpt-5.1", "gemini-3-pro", "grok-5", "deepseek-v4"];
		const indices = new Set(ids.map(modelDirectionIndex));
		expect(indices.size).toBeGreaterThan(1);
	});

	it("modelDirectionGlyph and modelColor are paired 1:1 via the same hash slot", () => {
		const id = "claude-sonnet-5";
		const index = modelDirectionIndex(id);
		expect(modelDirectionGlyph(id)).toBe(DIRECTION_GLYPHS[index]);
		expect(modelColor(id)).toBe(VANE_COLORS[index]);
	});

	it("spinProgress is 0 at/before the start, climbs linearly, and clamps to 1 at/after SPIN_DURATION_MS", () => {
		expect(spinProgress(0, 0)).toBe(0);
		expect(spinProgress(50, 100)).toBe(0); // before the spin started
		expect(spinProgress(SPIN_DURATION_MS / 2, 0)).toBeCloseTo(0.5, 5);
		expect(spinProgress(SPIN_DURATION_MS, 0)).toBe(1);
		expect(spinProgress(SPIN_DURATION_MS * 10, 0)).toBe(1);
	});

	it("spinDisplayIndex starts at fromIndex and lands exactly on toIndex at progress 1", () => {
		expect(spinDisplayIndex(2, 5, 0)).toBe(2);
		expect(spinDisplayIndex(2, 5, 1)).toBe(5);
		expect(spinDisplayIndex(5, 2, 1)).toBe(2);
		expect(spinDisplayIndex(0, 0, 1)).toBe(0); // same slot: still lands back on itself
	});

	it("spinDisplayIndex always sweeps through a visible intermediate step, even between identical slots", () => {
		const midway = spinDisplayIndex(3, 3, 0.5);
		expect(midway).not.toBe(3); // a same-slot spin still visibly moves before landing back
		expect(midway).toBeGreaterThanOrEqual(0);
		expect(midway).toBeLessThan(DIRECTION_GLYPHS.length);
	});

	it("spinDisplayIndex stays within bounds across the full progress range", () => {
		for (let from = 0; from < DIRECTION_GLYPHS.length; from++) {
			for (let to = 0; to < DIRECTION_GLYPHS.length; to++) {
				for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
					const index = spinDisplayIndex(from, to, progress);
					expect(index).toBeGreaterThanOrEqual(0);
					expect(index).toBeLessThan(DIRECTION_GLYPHS.length);
				}
			}
		}
	});

	it("truncateLabel leaves short ids untouched and truncates long ones with an ellipsis", () => {
		expect(truncateLabel("claude-sonnet-5")).toBe("claude-sonnet-5");
		const long = "a-very-long-hypothetical-model-identifier-string";
		const truncated = truncateLabel(long);
		expect(truncated.length).toBe(MAX_LABEL_LENGTH);
		expect(truncated.endsWith("…")).toBe(true);
	});
});

describe("model weather vane state", () => {
	it("the first assistant message initializes silently, without triggering a spin", () => {
		const state = new ModelWeatherVaneState();
		const switched = state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		expect(switched).toBe(false);
		const snapshot = state.snapshot();
		expect(snapshot.currentModelId).toBe("claude-sonnet-5");
		expect(snapshot.currentProvider).toBe("anthropic");
		expect(snapshot.previousModelId).toBeUndefined();
		expect(snapshot.spinStartAt).toBeUndefined();
		expect(snapshot.messageCount).toBe(1);
	});

	it("a repeated same-model message does not switch", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const switched = state.recordAssistantMessage("claude-sonnet-5", "anthropic", 100);
		expect(switched).toBe(false);
		expect(state.snapshot().spinStartAt).toBeUndefined();
		expect(state.snapshot().messageCount).toBe(2);
	});

	it("a genuine model change switches and stamps the previous model id + spin start", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const switched = state.recordAssistantMessage("gpt-5.1", "openai", 500);
		expect(switched).toBe(true);
		const snapshot = state.snapshot();
		expect(snapshot.currentModelId).toBe("gpt-5.1");
		expect(snapshot.currentProvider).toBe("openai");
		expect(snapshot.previousModelId).toBe("claude-sonnet-5");
		expect(snapshot.spinStartAt).toBe(500);
	});

	it("switching back to a previously seen model still counts as a fresh switch", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		state.recordAssistantMessage("gpt-5.1", "openai", 100);
		const switched = state.recordAssistantMessage("claude-sonnet-5", "anthropic", 200);
		expect(switched).toBe(true);
		expect(state.snapshot().previousModelId).toBe("gpt-5.1");
		expect(state.snapshot().spinStartAt).toBe(200);
	});

	it("an empty model id is ignored: no switch, no count, no mutation", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const switched = state.recordAssistantMessage("", "anthropic", 50);
		expect(switched).toBe(false);
		expect(state.snapshot().messageCount).toBe(1);
		expect(state.snapshot().currentModelId).toBe("claude-sonnet-5");
	});
});

describe("model weather vane rendering (byte-stable)", () => {
	it("renders 'no model yet' before any assistant message", () => {
		const state = new ModelWeatherVaneState();
		expect(renderModelWeatherVaneRow(state.snapshot(), 0, idTheme, "full")).toBe("no model yet");
		expect(renderModelWeatherVaneOffText(state.snapshot())).toBe("no model yet");
	});

	it("full tier shows the colored glyph, model id, and provider once settled", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const row = renderModelWeatherVaneRow(state.snapshot(), 0, idTheme, "full");
		expect(row).toContain("claude-sonnet-5");
		expect(row).toContain("(anthropic)");
	});

	it("subtle tier collapses to just the glyph and model id, no provider", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const row = renderModelWeatherVaneRow(state.snapshot(), 0, idTheme, "subtle");
		expect(row).toContain("claude-sonnet-5");
		expect(row).not.toContain("anthropic");
	});

	it("settled (non-spinning) rows are identical regardless of elapsedMs", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const early = renderModelWeatherVaneRow(state.snapshot(), 0, idTheme, "full");
		const later = renderModelWeatherVaneRow(state.snapshot(), 999_999, idTheme, "full");
		expect(early).toBe(later);
	});

	it("a fresh switch renders a mid-spin frame that differs from the settled target frame", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		state.recordAssistantMessage("gpt-5.1", "openai", 0); // switch stamped at clock 0

		const midSpin = renderModelWeatherVaneRow(state.snapshot(), SPIN_DURATION_MS / 2, taggedTheme, "full");
		const settled = renderModelWeatherVaneRow(state.snapshot(), SPIN_DURATION_MS * 10, taggedTheme, "full");
		expect(midSpin).not.toBe(settled);
		expect(settled).toContain("gpt-5.1"); // settles on the new model's label immediately (only the emblem spins)
	});

	it("renderModelWeatherVaneOffText matches the plain (non-ANSI) 'no model yet' / emblem-label form", () => {
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		expect(renderModelWeatherVaneOffText(state.snapshot())).toBe("🧭 claude-sonnet-5 (anthropic)");
	});
});

describe("ModelWeatherVaneWidget", () => {
	it("renders a frame, tracks the injected clock, and disposes with zero leaked subscriptions", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const widget = new ModelWeatherVaneWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		const initial = widget.render(80);
		state.recordAssistantMessage("gpt-5.1", "openai", 0);
		scheduler.advance(SPIN_DURATION_MS / 2);
		const next = widget.render(80);
		expect(next).not.toEqual(initial);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ModelWeatherVaneState();
		state.recordAssistantMessage("claude-sonnet-5", "anthropic", 0);
		const widget = new ModelWeatherVaneWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)[0]).not.toBe("");
	});
});

describe("model weather vane controller", () => {
	function recordingContext(overrides: Partial<ModelWeatherVaneContext> = {}): {
		ctx: ModelWeatherVaneContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: ModelWeatherVaneContext = {
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

	it("mounts an animated widget on the first assistant message_start and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new ModelWeatherVaneController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: ModelWeatherVaneTheme) => ModelWeatherVaneWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().messageCount).toBe(2);
	});

	it("ignores non-assistant messages entirely", () => {
		const controller = new ModelWeatherVaneController();
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(toolResultMessageStart(), ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().currentModelId).toBeUndefined();
	});

	it("renders and updates a static line for the off tier only when the model actually switches", () => {
		const scheduler = manualScheduler();
		const controller = new ModelWeatherVaneController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		expect((calls[0].content as string[])[0]).toBe("🧭 claude-sonnet-5 (anthropic)");

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		expect(calls).toHaveLength(1); // same model: no redundant redraw

		controller.onMessageStart(assistantMessageStart("gpt-5.1", "openai"), ctx);
		expect(calls).toHaveLength(2);
		expect((calls[calls.length - 1].content as string[])[0]).toBe("🧭 gpt-5.1 (openai)");
		expect(scheduler.running).toBe(false);
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new ModelWeatherVaneController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new ModelWeatherVaneController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new ModelWeatherVaneController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onMessageStart(assistantMessageStart("claude-sonnet-5"), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: ModelWeatherVaneTheme) => ModelWeatherVaneWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
