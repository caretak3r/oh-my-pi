// Wave 2 integration/gallery test: mounts all 15 ambient-animation controllers
// together in one shared session (one shared `setWidget` spy), unlike the
// per-feature test files which each mount only their own controller in isolation.
import { describe, expect, test } from "bun:test";
import type { MotionSetting } from "@oh-my-pi/pi-animation";
import {
	type AgentFleetContext,
	AgentFleetController,
	type AgentFleetRegistrySource,
} from "@oh-my-pi/pi-coding-agent/agent-fleet/controller";
import type { AgentFleetRefSource, AgentFleetRegistryEventSource } from "@oh-my-pi/pi-coding-agent/agent-fleet/state";
import {
	type BreathingBorderContext,
	BreathingBorderController,
} from "@oh-my-pi/pi-coding-agent/breathing-border/controller";
import {
	type CadenceEqualizerContext,
	CadenceEqualizerController,
} from "@oh-my-pi/pi-coding-agent/cadence-equalizer/controller";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
	type ContextConstellationContext,
	ContextConstellationController,
} from "@oh-my-pi/pi-coding-agent/context-constellation/controller";
import type { ContextUsageReading } from "@oh-my-pi/pi-coding-agent/context-constellation/state";
import { type CostCandleContext, CostCandleController } from "@oh-my-pi/pi-coding-agent/cost-candle/controller";
import { type DiffBloomContext, DiffBloomController } from "@oh-my-pi/pi-coding-agent/diff-bloom/controller";
import type {
	AgentStartEvent,
	AutoCompactionEndEvent,
	EditToolResultEvent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	InputEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionTreeEvent,
	ToolCallEvent,
	ToolResultEvent,
	TtsrTriggeredEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { GoalUpdatedEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { type GoalHorizonContext, GoalHorizonController } from "@oh-my-pi/pi-coding-agent/goal-horizon/controller";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	type MemoryCrystalsContext,
	MemoryCrystalsController,
} from "@oh-my-pi/pi-coding-agent/memory-crystals/controller";
import {
	type ModelWeatherVaneContext,
	ModelWeatherVaneController,
} from "@oh-my-pi/pi-coding-agent/model-weather-vane/controller";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type PromptChargeContext, PromptChargeController } from "@oh-my-pi/pi-coding-agent/prompt-charge/controller";
import {
	type ReflectionRippleContext,
	ReflectionRippleController,
} from "@oh-my-pi/pi-coding-agent/reflection-ripple/controller";
import {
	type BonsaiSessionSource,
	type BonsaiTreeSourceNode,
	type SessionBonsaiContext,
	SessionBonsaiController,
} from "@oh-my-pi/pi-coding-agent/session-bonsai/controller";
import { type TodoMeteorsContext, TodoMeteorsController } from "@oh-my-pi/pi-coding-agent/todo-meteors/controller";
import { type TokenTideContext, TokenTideController } from "@oh-my-pi/pi-coding-agent/token-tide/controller";
import {
	type ToolConstellationContext,
	ToolConstellationController,
} from "@oh-my-pi/pi-coding-agent/tool-constellation/controller";

// Identity theme so assertions see plain text instead of ANSI escapes. All 15
// feature theme aliases are structurally `Pick<Theme, "fg">`, so one shared
// object satisfies every controller's `theme` field.
const idTheme: Pick<Theme, "fg"> = { fg: (_color, text) => text };

/** Every WIDGET_KEY -> documented placement, mirrors WAVE2_PROGRESS.md's 8/7 split. */
const EXPECTED_PLACEMENT: Record<string, "aboveEditor" | "belowEditor"> = {
	"tool-constellation": "belowEditor",
	"token-tide": "aboveEditor",
	"session-bonsai": "belowEditor",
	"todo-meteors": "aboveEditor",
	"breathing-border": "aboveEditor",
	"agent-fleet": "belowEditor",
	"cost-candle": "aboveEditor",
	"reflection-ripple": "aboveEditor",
	"memory-crystals": "belowEditor",
	"context-constellation": "belowEditor",
	"diff-bloom": "aboveEditor",
	"cadence-equalizer": "belowEditor",
	"goal-horizon": "aboveEditor",
	"model-weather-vane": "belowEditor",
	"prompt-charge": "aboveEditor",
};

/** sdk.ts's `createAgentSession` inline-extension registration order (see `sdk.ts` around line 1844-1858). */
const REGISTRATION_ORDER = Object.keys(EXPECTED_PLACEMENT).sort(
	(a, b) => Object.keys(EXPECTED_PLACEMENT).indexOf(a) - Object.keys(EXPECTED_PLACEMENT).indexOf(b),
);

interface CapturedWidgetCall {
	feature: string;
	key: string;
	options: ExtensionWidgetOptions | undefined;
	content: ExtensionWidgetContent;
}

/** Build a minimal assistant `AgentMessage`, reused by every message_start/update/end-driven feature. */
function assistantMessage(
	opts: {
		timestamp?: number;
		output?: number;
		duration?: number;
		costUsd?: number;
		model?: string;
		provider?: string;
	} = {},
): MessageStartEvent["message"] {
	const { timestamp = 0, output = 0, duration, costUsd = 0, model = "test-model", provider = "test" } = opts;
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			output,
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
		},
		stopReason: "stop",
		timestamp,
		duration,
	} as unknown as MessageStartEvent["message"];
}

function messageStartEvent(message: MessageStartEvent["message"]): MessageStartEvent {
	return { type: "message_start", message };
}
function messageUpdateEvent(message: MessageStartEvent["message"]): MessageUpdateEvent {
	return { type: "message_update", message, assistantMessageEvent: {} } as unknown as MessageUpdateEvent;
}
function messageEndEvent(message: MessageStartEvent["message"]): MessageEndEvent {
	return { type: "message_end", message };
}

/** root -A- B(branch) -> C(leaf), -> D -E- (leaf), in the real `{ entry: { id }, children }` shape. */
function branchingSourceTree(): BonsaiTreeSourceNode[] {
	return [
		{
			entry: { id: "A" },
			children: [
				{
					entry: { id: "B" },
					children: [
						{ entry: { id: "C" }, children: [] },
						{ entry: { id: "D" }, children: [{ entry: { id: "E" }, children: [] }] },
					],
				},
			],
		},
	];
}

function fixedSessionSource(roots: BonsaiTreeSourceNode[], leafId: string | null): BonsaiSessionSource {
	return { getTree: () => roots, getLeafId: () => leafId };
}

function todoToolResult(details: unknown): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-1",
		toolName: "todo",
		input: {},
		content: [],
		isError: false,
		details,
	} as ToolResultEvent;
}

function fakeRegistry(): AgentFleetRegistrySource & { emit(evt: AgentFleetRegistryEventSource): void } {
	const listeners = new Set<(evt: AgentFleetRegistryEventSource) => void>();
	return {
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(evt) {
			for (const listener of [...listeners]) listener(evt);
		},
	};
}

function ref(id: string, overrides: Partial<AgentFleetRefSource> = {}): AgentFleetRefSource {
	return { id, displayName: id, kind: "sub", status: "running", ...overrides };
}

function rule(name: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: "",
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

function successfulCompactionEnd(tokensBefore: number): AutoCompactionEndEvent {
	return {
		type: "auto_compaction_end",
		action: "context-full",
		aborted: false,
		willRetry: false,
		result: { summary: "compacted the session", tokensBefore, firstKeptEntryId: "entry-1" },
	} as AutoCompactionEndEvent;
}

function usageReading(percent: number, contextWindow = 100_000): ContextUsageReading {
	return { percent, contextWindow, tokens: Math.round((percent / 100) * contextWindow) };
}

const sampleDiff = ["+1|line one", "+2|line two", "-1|old line"].join("\n");

function editResult(diff: string, path = "src/foo.ts"): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path },
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: { diff, path },
	};
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "ship the thing",
		status: "active",
		tokenBudget: 1000,
		tokensUsed: 400,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function inputEvent(text: string): InputEvent {
	return { type: "input", text, source: "interactive" };
}

interface MountedGallery {
	calls: CapturedWidgetCall[];
	disposers: Array<{ feature: string; dispose: () => void }>;
}

/**
 * Constructs all 15 Wave 2 controllers, each wired to its own feature-shaped
 * fake context, but all sharing ONE `setWidget` spy — then drives each
 * through its representative "active" event (mirroring the driving call
 * each feature's own test file already uses). `motionSetting: "off"` forces
 * every controller's `MotionPolicy` to the `off` tier (see
 * `resolveMotionTier`), so every `setWidget` call carries a plain `string[]`
 * instead of an animated-widget factory — no fake `TUI` needed.
 */
function mountGallery(): MountedGallery {
	const calls: CapturedWidgetCall[] = [];
	const disposers: Array<{ feature: string; dispose: () => void }> = [];
	const base = {
		hasUI: true,
		isTTY: true,
		env: {} as Record<string, string | undefined>,
		motionSetting: "off" as MotionSetting,
		theme: idTheme,
	};
	function widget(feature: string) {
		return (key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions) => {
			calls.push({ feature, key, options, content });
		};
	}

	{
		const ctx: ToolConstellationContext = { ...base, setWidget: widget("tool-constellation") };
		const controller = new ToolConstellationController();
		controller.onToolCall(
			{ type: "tool_call", toolCallId: "tc-1", toolName: "bash", input: {} } as ToolCallEvent,
			ctx,
		);
		disposers.push({ feature: "tool-constellation", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: TokenTideContext = { ...base, setWidget: widget("token-tide") };
		const controller = new TokenTideController();
		controller.onMessageStart(messageStartEvent(assistantMessage({ output: 0 })), ctx);
		controller.onMessageUpdate(messageUpdateEvent(assistantMessage({ output: 100, duration: 500 })), ctx);
		disposers.push({ feature: "token-tide", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: SessionBonsaiContext = {
			...base,
			sessionManager: fixedSessionSource(branchingSourceTree(), "C"),
			setWidget: widget("session-bonsai"),
		};
		const controller = new SessionBonsaiController();
		controller.onSessionTree({ type: "session_tree", newLeafId: "C", oldLeafId: null } as SessionTreeEvent, ctx);
		disposers.push({ feature: "session-bonsai", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: TodoMeteorsContext = { ...base, setWidget: widget("todo-meteors") };
		const controller = new TodoMeteorsController();
		controller.onToolResult(
			todoToolResult({
				phases: [{ name: "Phase 1", tasks: [{ content: "a", status: "completed" }] }],
				completedTasks: [{ phase: "Phase 1", content: "a" }],
			}),
			ctx,
		);
		disposers.push({ feature: "todo-meteors", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: BreathingBorderContext = { ...base, setWidget: widget("breathing-border") };
		const controller = new BreathingBorderController();
		controller.onAgentStart({ type: "agent_start" } as AgentStartEvent, ctx);
		disposers.push({ feature: "breathing-border", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: AgentFleetContext = { ...base, setWidget: widget("agent-fleet") };
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry });
		controller.watch(ctx);
		registry.emit({ type: "registered", ref: ref("sub-1") });
		disposers.push({ feature: "agent-fleet", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: CostCandleContext = { ...base, setWidget: widget("cost-candle") };
		const controller = new CostCandleController();
		controller.onMessageEnd(messageEndEvent(assistantMessage({ costUsd: 0.05 })), ctx);
		disposers.push({ feature: "cost-candle", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: ReflectionRippleContext = { ...base, setWidget: widget("reflection-ripple") };
		const controller = new ReflectionRippleController();
		controller.onTtsrTriggered(
			{ type: "ttsr_triggered", rules: [rule("no-console-log")] } as TtsrTriggeredEvent,
			ctx,
		);
		disposers.push({ feature: "reflection-ripple", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: MemoryCrystalsContext = { ...base, setWidget: widget("memory-crystals") };
		const controller = new MemoryCrystalsController();
		controller.onAutoCompactionEnd(successfulCompactionEnd(20_000), ctx);
		disposers.push({ feature: "memory-crystals", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: ContextConstellationContext = {
			...base,
			getContextUsage: () => usageReading(70),
			setWidget: widget("context-constellation"),
		};
		const controller = new ContextConstellationController();
		controller.onContext(ctx);
		disposers.push({ feature: "context-constellation", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: DiffBloomContext = { ...base, setWidget: widget("diff-bloom") };
		const controller = new DiffBloomController();
		controller.onToolResult(editResult(sampleDiff), ctx);
		disposers.push({ feature: "diff-bloom", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: CadenceEqualizerContext = { ...base, setWidget: widget("cadence-equalizer") };
		const controller = new CadenceEqualizerController();
		controller.onMessageStart(messageStartEvent(assistantMessage({ output: 0 })), ctx);
		controller.onMessageUpdate(messageUpdateEvent(assistantMessage({ output: 100, duration: 500 })), ctx);
		disposers.push({ feature: "cadence-equalizer", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: GoalHorizonContext = { ...base, setWidget: widget("goal-horizon") };
		const controller = new GoalHorizonController();
		controller.onGoalUpdated({ type: "goal_updated", goal: makeGoal() } as GoalUpdatedEvent, ctx);
		disposers.push({ feature: "goal-horizon", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: ModelWeatherVaneContext = { ...base, setWidget: widget("model-weather-vane") };
		const controller = new ModelWeatherVaneController();
		controller.onMessageStart(
			messageStartEvent(assistantMessage({ model: "claude-sonnet-5", provider: "anthropic" })),
			ctx,
		);
		disposers.push({ feature: "model-weather-vane", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: PromptChargeContext = { ...base, getEditorText: () => "", setWidget: widget("prompt-charge") };
		const controller = new PromptChargeController();
		controller.mount(ctx);
		controller.onInput(inputEvent("x".repeat(80)), ctx);
		disposers.push({ feature: "prompt-charge", dispose: () => controller.dispose(ctx) });
	}

	return { calls, disposers };
}

/** Collapses repeated `setWidget` calls (mount, then a later repaint) to the last one per feature key. */
function lastCallPerKey(calls: readonly CapturedWidgetCall[]): CapturedWidgetCall[] {
	const byKey = new Map<string, CapturedWidgetCall>();
	for (const call of calls) byKey.set(call.key, call);
	return [...byKey.values()];
}

/** Formats the 15 captured widgets into a labeled, human-readable "gallery" of the whole Wave 2 suite. */
function renderGallery(calls: readonly CapturedWidgetCall[]): string {
	const section = (label: string, placement: "aboveEditor" | "belowEditor"): string[] => {
		const lines = [`${label}:`];
		for (const call of calls) {
			if (call.options?.placement !== placement) continue;
			lines.push(`  ${call.key}`);
			if (Array.isArray(call.content)) {
				for (const row of call.content) lines.push(`    ${row}`);
			}
		}
		return lines;
	};
	return [...section("Above editor", "aboveEditor"), ...section("Below editor", "belowEditor")].join("\n");
}

describe("wave2 gallery integration", () => {
	test("mounting all 15 controllers together produces one non-idle setWidget call each, matching the documented 8/7 placement split", () => {
		const { calls } = mountGallery();
		const withContent = lastCallPerKey(calls).filter(call => call.content !== undefined);

		expect(withContent).toHaveLength(15);
		expect(new Set(withContent.map(call => call.key))).toEqual(new Set(Object.keys(EXPECTED_PLACEMENT)));

		const aboveCount = withContent.filter(call => call.options?.placement === "aboveEditor").length;
		const belowCount = withContent.filter(call => call.options?.placement === "belowEditor").length;
		expect(aboveCount).toBe(8);
		expect(belowCount).toBe(7);

		for (const call of withContent) {
			expect(call.options?.placement).toBe(EXPECTED_PLACEMENT[call.key]);
			expect(Array.isArray(call.content)).toBe(true);
			const lines = call.content as string[];
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(line).not.toContain("undefined");
				expect(line).not.toContain("NaN");
			}
		}
	});

	test("renderGallery composes a labeled above/below gallery snapshot of all 15 widgets", () => {
		const { calls } = mountGallery();
		const withContent = lastCallPerKey(calls).filter(call => call.content !== undefined);
		const gallery = renderGallery(withContent);

		expect(gallery.startsWith("Above editor")).toBe(true);
		expect(gallery).toContain("Below editor");
		for (const key of Object.keys(EXPECTED_PLACEMENT)) {
			expect(gallery).toContain(key);
		}

		const [aboveSection, belowSection] = gallery.split("Below editor");
		const countBlocks = (section: string) => (section.match(/^ {2}\S/gm) ?? []).length;
		expect(countBlocks(aboveSection)).toBe(8);
		expect(countBlocks(belowSection)).toBe(7);
	});

	test("disposing all 15 controllers in sdk.ts's registration order never throws (full session_shutdown cascade)", () => {
		const { disposers } = mountGallery();
		expect(disposers.map(d => d.feature)).toEqual(REGISTRATION_ORDER);
		for (const { dispose } of disposers) {
			expect(() => dispose()).not.toThrow();
		}
	});
});
