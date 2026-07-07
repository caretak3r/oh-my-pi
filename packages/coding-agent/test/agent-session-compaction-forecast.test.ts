import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Extension-facing contract: `getContextUsage()` exposes the auto-compaction
 * forecast (`compactionThresholdTokens` / `tokensUntilCompaction`) so a plugin
 * reads the real threshold instead of approximating it from `percent`. The
 * values MUST come from the same `resolveThresholdTokens` the runtime uses — the
 * assertions are resolver-backed, never hard-coded numbers.
 */
describe("AgentSession context-usage compaction forecast", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let session: AgentSession | undefined;

	const PROMPT_INPUT_TOKENS = 10;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-compaction-forecast-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const candidate = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!candidate?.contextWindow) {
			throw new Error("Expected a bundled model with a context window");
		}
		model = candidate;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	function seededSession(settings: Settings): AgentSession {
		const userMessage: UserMessage = { role: "user", content: "Hello", timestamp: Date.now() };
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: PROMPT_INPUT_TOKENS,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: PROMPT_INPUT_TOKENS + 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [userMessage, assistantMessage] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
	}

	it("reports tokensUntilCompaction as resolveThresholdTokens(...) minus used tokens", () => {
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 8_000,
		});
		session = seededSession(settings);

		const usage = session.getContextUsage();
		if (!usage) throw new Error("Expected context usage");

		// Resolver-backed expectation: the same threshold the runtime would trigger on.
		const expectedThreshold = resolveThresholdTokens(usage.contextWindow, settings.getGroup("compaction"));
		expect(usage.compactionThresholdTokens).toBe(expectedThreshold);
		expect(usage.tokensUntilCompaction).toBe(expectedThreshold - usage.tokens);
	});

	it("omits the forecast when auto-compaction is disabled", () => {
		session = seededSession(Settings.isolated({ "compaction.enabled": false }));

		const usage = session.getContextUsage();
		if (!usage) throw new Error("Expected context usage");
		expect(usage.compactionThresholdTokens).toBeUndefined();
		expect(usage.tokensUntilCompaction).toBeUndefined();
	});

	it("omits the forecast when the compaction strategy is off", () => {
		session = seededSession(Settings.isolated({ "compaction.enabled": true, "compaction.strategy": "off" }));

		const usage = session.getContextUsage();
		if (!usage) throw new Error("Expected context usage");
		expect(usage.compactionThresholdTokens).toBeUndefined();
		expect(usage.tokensUntilCompaction).toBeUndefined();
	});
});
