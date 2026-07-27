import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AnimationHost, MotionPolicy } from "@oh-my-pi/pi-animation";
import { createAgentFleetExtension } from "@oh-my-pi/pi-coding-agent/agent-fleet";
import { createBreathingBorderExtension } from "@oh-my-pi/pi-coding-agent/breathing-border";
import { createCadenceEqualizerExtension } from "@oh-my-pi/pi-coding-agent/cadence-equalizer";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { createContextConstellationExtension } from "@oh-my-pi/pi-coding-agent/context-constellation";
import { createCostCandleExtension } from "@oh-my-pi/pi-coding-agent/cost-candle";
import { createDiffBloomExtension } from "@oh-my-pi/pi-coding-agent/diff-bloom";
import type { AnimatedFeatureLifecycleAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/animated-feature";
import type {
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoRetryStartEvent,
	EditToolResultEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
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
import type {
	GoalUpdatedEvent,
	SessionShutdownEvent,
	SessionSwitchEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { createGoalHorizonExtension } from "@oh-my-pi/pi-coding-agent/goal-horizon";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import { createMemoryCrystalsExtension } from "@oh-my-pi/pi-coding-agent/memory-crystals";
import { createModelWeatherVaneExtension } from "@oh-my-pi/pi-coding-agent/model-weather-vane";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createPromptChargeExtension } from "@oh-my-pi/pi-coding-agent/prompt-charge";
import { createReflectionRippleExtension } from "@oh-my-pi/pi-coding-agent/reflection-ripple";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createRetryRadarExtension } from "@oh-my-pi/pi-coding-agent/retry-radar";
import { createSessionBonsaiExtension } from "@oh-my-pi/pi-coding-agent/session-bonsai";
import { createTodoMeteorsExtension } from "@oh-my-pi/pi-coding-agent/todo-meteors";
import { createTokenTideExtension } from "@oh-my-pi/pi-coding-agent/token-tide";
import { createToolConstellationExtension } from "@oh-my-pi/pi-coding-agent/tool-constellation";

type RecordedHandler = (event: unknown, ctx: ExtensionContext) => unknown;

class FakeExtensionApi implements AnimatedFeatureLifecycleAPI {
	readonly #handlers = new Map<string, RecordedHandler[]>();

	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: string, handler: unknown): void {
		const handlers = this.#handlers.get(event) ?? [];
		handlers.push(handler as RecordedHandler);
		this.#handlers.set(event, handlers);
	}

	async emit(event: string, ctx: ExtensionContext, payload: unknown = { type: event }): Promise<void> {
		for (const handler of this.#handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

interface CapturedWidgetCall {
	key: string;
	content: ExtensionWidgetContent;
	options: ExtensionWidgetOptions | undefined;
}

interface FeatureCase {
	name: string;
	key: string;
	factory: ExtensionFactory;
	activate(api: FakeExtensionApi, ctx: ExtensionContext, sequence: number): Promise<void> | void;
}

interface FeatureHarness {
	api: FakeExtensionApi;
	ctx: ExtensionContext;
	calls: CapturedWidgetCall[];
}

const idTheme: Pick<Theme, "fg"> = { fg: (_color, text) => text };

function createExtensionContext(calls: CapturedWidgetCall[]): ExtensionContext {
	const policy = new MotionPolicy({ hasUI: true, isTTY: true, env: {} }, "full");
	const animation = { host: new AnimationHost({ policy }), policy };
	const sessionManager = {
		getTree: () => [
			{
				entry: { id: "A" },
				children: [{ entry: { id: "B" }, children: [{ entry: { id: "C" }, children: [] }] }],
			},
		],
		getLeafId: () => "C",
	};
	return {
		hasUI: true,
		ui: {
			theme: idTheme as Theme,
			animation: () => animation,
			getEditorText: () => "",
			getEditorTextLength: () => 0,
			setWidget: (key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions) =>
				calls.push({ key, content, options }),
		},
		sessionManager,
		getContextUsage: () => ({ percent: 70, contextWindow: 100_000, tokens: 70_000 }),
	} as unknown as ExtensionContext;
}

function assistantMessage(
	options: { output?: number; duration?: number; costUsd?: number; model?: string; provider?: string } = {},
): MessageStartEvent["message"] {
	const { output = 0, duration, costUsd = 0, model = "test-model", provider = "test" } = options;
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
		timestamp: 0,
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

function todoToolResult(sequence: number): ToolResultEvent {
	const content = `task-${sequence}`;
	return {
		type: "tool_result",
		toolCallId: `todo-${sequence}`,
		toolName: "todo",
		input: {},
		content: [],
		isError: false,
		details: {
			phases: [{ name: "Phase 1", tasks: [{ content, status: "completed" }] }],
			completedTasks: [{ phase: "Phase 1", content }],
		},
	} as ToolResultEvent;
}

function rule(name: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: "",
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

function successfulCompactionEnd(sequence: number): AutoCompactionEndEvent {
	return {
		type: "auto_compaction_end",
		action: "context-full",
		aborted: false,
		willRetry: false,
		result: {
			summary: `compacted session ${sequence}`,
			tokensBefore: 20_000 + sequence,
			firstKeptEntryId: `entry-${sequence}`,
		},
	} as AutoCompactionEndEvent;
}

const sampleDiff = ["+1|line one", "+2|line two", "-1|old line"].join("\n");

function editResult(sequence: number): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: `edit-${sequence}`,
		input: { path: `src/file-${sequence}.ts` },
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: { diff: sampleDiff, path: `src/file-${sequence}.ts` },
	};
}

function goal(sequence: number): Goal {
	return {
		id: "goal-1",
		objective: "ship the thing",
		status: "active",
		tokenBudget: 1000,
		tokensUsed: 400 + sequence,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: sequence,
	};
}

const FEATURES: readonly FeatureCase[] = [
	{
		name: "Tool Constellation",
		key: "tool-constellation",
		factory: createToolConstellationExtension,
		activate: (api, ctx, sequence) =>
			api.emit("tool_call", ctx, {
				type: "tool_call",
				toolCallId: `tool-${sequence}`,
				toolName: "bash",
				input: {},
			} as ToolCallEvent),
	},
	{
		name: "Token Tide",
		key: "token-tide",
		factory: createTokenTideExtension,
		activate: async (api, ctx, sequence) => {
			await api.emit("message_start", ctx, messageStartEvent(assistantMessage()));
			await api.emit(
				"message_update",
				ctx,
				messageUpdateEvent(assistantMessage({ output: 100 + sequence, duration: 500 })),
			);
		},
	},
	{
		name: "Session Bonsai",
		key: "session-bonsai",
		factory: createSessionBonsaiExtension,
		activate: (api, ctx) =>
			api.emit("session_tree", ctx, {
				type: "session_tree",
				newLeafId: "C",
				oldLeafId: null,
			} as SessionTreeEvent),
	},
	{
		name: "Todo Meteors",
		key: "todo-meteors",
		factory: createTodoMeteorsExtension,
		activate: (api, ctx, sequence) => api.emit("tool_result", ctx, todoToolResult(sequence)),
	},
	{
		name: "Breathing Border",
		key: "breathing-border",
		factory: createBreathingBorderExtension,
		activate: (api, ctx) => api.emit("agent_start", ctx, { type: "agent_start" } as AgentStartEvent),
	},
	{
		name: "Agent Fleet",
		key: "agent-fleet",
		factory: createAgentFleetExtension,
		activate: (_api, _ctx, sequence) => {
			AgentRegistry.global().register({
				id: `sub-${sequence}`,
				displayName: `sub-${sequence}`,
				kind: "sub",
				status: "running",
				session: null,
			});
		},
	},
	{
		name: "Cost Candle",
		key: "cost-candle",
		factory: createCostCandleExtension,
		activate: (api, ctx, sequence) =>
			api.emit("message_end", ctx, messageEndEvent(assistantMessage({ costUsd: 0.05 + sequence / 1000 }))),
	},
	{
		name: "Reflection Ripple",
		key: "reflection-ripple",
		factory: createReflectionRippleExtension,
		activate: (api, ctx, sequence) =>
			api.emit("ttsr_triggered", ctx, {
				type: "ttsr_triggered",
				rules: [rule(`rule-${sequence}`)],
			} as TtsrTriggeredEvent),
	},
	{
		name: "Memory Crystals",
		key: "memory-crystals",
		factory: createMemoryCrystalsExtension,
		activate: (api, ctx, sequence) => api.emit("auto_compaction_end", ctx, successfulCompactionEnd(sequence)),
	},
	{
		name: "Context Constellation",
		key: "context-constellation",
		factory: createContextConstellationExtension,
		activate: (api, ctx) => api.emit("context", ctx),
	},
	{
		name: "Diff Bloom",
		key: "diff-bloom",
		factory: createDiffBloomExtension,
		activate: (api, ctx, sequence) => api.emit("tool_result", ctx, editResult(sequence)),
	},
	{
		name: "Cadence Equalizer",
		key: "cadence-equalizer",
		factory: createCadenceEqualizerExtension,
		activate: async (api, ctx, sequence) => {
			await api.emit("message_start", ctx, messageStartEvent(assistantMessage()));
			await api.emit(
				"message_update",
				ctx,
				messageUpdateEvent(assistantMessage({ output: 100 + sequence, duration: 500 })),
			);
		},
	},
	{
		name: "Goal Horizon",
		key: "goal-horizon",
		factory: createGoalHorizonExtension,
		activate: (api, ctx, sequence) =>
			api.emit("goal_updated", ctx, { type: "goal_updated", goal: goal(sequence) } as GoalUpdatedEvent),
	},
	{
		name: "Model Weather Vane",
		key: "model-weather-vane",
		factory: createModelWeatherVaneExtension,
		activate: (api, ctx, sequence) =>
			api.emit(
				"message_start",
				ctx,
				messageStartEvent(assistantMessage({ model: `model-${sequence}`, provider: "test" })),
			),
	},
	{
		name: "Prompt Charge",
		key: "prompt-charge",
		factory: createPromptChargeExtension,
		activate: (api, ctx, sequence) =>
			api.emit("input", ctx, {
				type: "input",
				text: "x".repeat(80 + sequence),
				source: "interactive",
			} as InputEvent),
	},
	{
		name: "Retry Radar",
		key: "retry-radar",
		factory: createRetryRadarExtension,
		activate: (api, ctx, sequence) =>
			api.emit("auto_retry_start", ctx, {
				type: "auto_retry_start",
				attempt: sequence,
				maxAttempts: 5,
				delayMs: 8000,
				errorMessage: "429 Too Many Requests",
			} as AutoRetryStartEvent),
	},
];

const sessionSwitch: SessionSwitchEvent = {
	type: "session_switch",
	reason: "resume",
	previousSessionFile: "/tmp/previous-session.jsonl",
};
const sessionShutdown: SessionShutdownEvent = { type: "session_shutdown" };

async function mountFeature(feature: FeatureCase): Promise<FeatureHarness> {
	const calls: CapturedWidgetCall[] = [];
	const api = new FakeExtensionApi();
	const ctx = createExtensionContext(calls);
	await feature.factory(api as unknown as ExtensionAPI);
	await api.emit("session_start", ctx);
	await feature.activate(api, ctx, 1);
	return { api, ctx, calls };
}

function lastFeatureCall(calls: readonly CapturedWidgetCall[], key: string): CapturedWidgetCall | undefined {
	return calls.filter(call => call.key === key).at(-1);
}

beforeEach(() => AgentRegistry.resetGlobalForTests());
afterEach(() => AgentRegistry.resetGlobalForTests());

describe("session switch tears down animated feature mounts", () => {
	for (const feature of FEATURES) {
		test(feature.name, async () => {
			const { api, ctx, calls } = await mountFeature(feature);
			expect(lastFeatureCall(calls, feature.key)?.content).toBeDefined();

			const beforeSwitch = calls.length;
			await api.emit("session_switch", ctx, sessionSwitch);
			const switchCalls = calls.slice(beforeSwitch).filter(call => call.key === feature.key);

			expect(switchCalls.some(call => call.content === undefined)).toBe(true);
			if (feature.key !== "prompt-charge") {
				expect(lastFeatureCall(calls, feature.key)?.content).toBeUndefined();
			}
		});
	}
});

describe("session switch allows the next feature event to remount", () => {
	for (const feature of FEATURES) {
		test(feature.name, async () => {
			const { api, ctx, calls } = await mountFeature(feature);
			const beforeSwitch = calls.length;
			await api.emit("session_switch", ctx, sessionSwitch);

			const beforeRemount = calls.length;
			await feature.activate(api, ctx, 2);
			const remountStart = feature.key === "prompt-charge" ? beforeSwitch : beforeRemount;
			const remountCalls = calls.slice(remountStart).filter(call => call.key === feature.key);

			expect(remountCalls.some(call => call.content !== undefined)).toBe(true);
		});
	}
});

describe("session shutdown tears down animated feature mounts", () => {
	for (const feature of FEATURES) {
		test(feature.name, async () => {
			const { api, ctx, calls } = await mountFeature(feature);
			await api.emit("session_shutdown", ctx, sessionShutdown);

			expect(lastFeatureCall(calls, feature.key)?.content).toBeUndefined();
		});
	}
});

describe("repeated session switch teardown is idempotent", () => {
	for (const feature of FEATURES) {
		test(feature.name, async () => {
			const { api, ctx } = await mountFeature(feature);
			await api.emit("session_switch", ctx, sessionSwitch);

			await expect(api.emit("session_switch", ctx, sessionSwitch)).resolves.toBeUndefined();
		});
	}
});

describe("Prompt Charge remounts immediately after session switch", () => {
	test("teardown is followed by a fresh widget without another input event", async () => {
		const feature = FEATURES.find(candidate => candidate.key === "prompt-charge");
		expect(feature).toBeDefined();
		if (!feature) return;
		const { api, ctx, calls } = await mountFeature(feature);

		const beforeSwitch = calls.length;
		await api.emit("session_switch", ctx, sessionSwitch);
		const switchCalls = calls.slice(beforeSwitch).filter(call => call.key === feature.key);

		expect(switchCalls[0]?.content).toBeUndefined();
		expect(switchCalls.at(-1)?.content).toBeDefined();
	});
});
