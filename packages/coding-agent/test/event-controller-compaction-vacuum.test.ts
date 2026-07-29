import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { CompactionVacuumWidget } from "@oh-my-pi/pi-coding-agent/modes/components/compaction-vacuum";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Container } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";

const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const savedEnv = { CI: Bun.env.CI, NO_COLOR: Bun.env.NO_COLOR, TERM: Bun.env.TERM };

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete Bun.env.CI;
	delete Bun.env.NO_COLOR;
	Bun.env.TERM = "xterm-256color";
});

afterEach(() => {
	if (savedIsTTY) Object.defineProperty(process.stdout, "isTTY", savedIsTTY);
	else delete (process.stdout as { isTTY?: boolean }).isTTY;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	vi.restoreAllMocks();
});

function createContext(getSetting: (key: string) => unknown = key => (key === "display.animations" ? "full" : false)) {
	const statusContainer = new Container();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			renderUnderPressure: false,
			terminal: { setProgress: vi.fn() },
		},
		settings: { get: vi.fn(getSetting) },
		statusContainer,
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools: new Map(),
		viewSession: { isStreaming: false, getContextUsage: () => ({ tokens: 142_000 }) },
		focusedAgentId: undefined,
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, statusContainer };
}

const startEvent = {
	type: "auto_compaction_start",
	reason: "threshold",
	action: "context-full",
} as Extract<AgentSessionEvent, { type: "auto_compaction_start" }>;

describe("EventController compaction vacuum lifecycle", () => {
	it("disposes the prior vacuum on a re-entrant compaction start", async () => {
		const { ctx, statusContainer } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(startEvent);
		expect(statusContainer.children).toHaveLength(1);
		const first = statusContainer.children[0] as CompactionVacuumWidget;
		expect(first.animating).toBe(true);

		await controller.handleEvent(startEvent);

		expect(first.animating).toBe(false);
		expect(statusContainer.children).toHaveLength(1);
		const second = statusContainer.children[0] as CompactionVacuumWidget;
		expect(second).not.toBe(first);
		expect(second.animating).toBe(true);

		controller.dispose();
	});

	it("falls back to the plain loader when animation construction throws", async () => {
		vi.spyOn(logger, "error").mockImplementation(() => {});
		const { ctx, statusContainer } = createContext();
		// The controller builds its animation through `sessionAnimation(ctx.ui)`,
		// which resolves the motion tier from the TUI's backpressure signal. Make
		// that read throw so the failure lands inside the guard, before the widget
		// is ever added to the status container. (Injecting via `settings.get` no
		// longer works: the shared session animation does not read `ctx.settings`.)
		Object.defineProperty(ctx.ui, "renderUnderPressure", {
			get: () => {
				throw new Error("boom");
			},
			configurable: true,
		});
		const controller = new EventController(ctx);

		await expect(controller.handleEvent(startEvent)).resolves.toBeUndefined();

		expect(ctx.autoCompactionLoader).toBeDefined();
		expect(statusContainer.children).toHaveLength(1);
		expect(statusContainer.children[0]).toBe(ctx.autoCompactionLoader!);

		ctx.autoCompactionLoader?.stop();
		controller.dispose();
	});
});
