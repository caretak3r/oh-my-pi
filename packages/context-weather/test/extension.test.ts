import { describe, expect, it } from "bun:test";
import type { MotionEnvironment } from "@oh-my-pi/pi-animation";
import type { ContextUsage, ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";
import { type ContextWeatherExtensionOptions, createContextWeatherExtension } from "../src/extension";
import type { ContextWeatherWidget } from "../src/widget";
import { FakeScheduler, fakeTheme, usageFixture } from "./helpers";

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown;

class ExtensionHarness {
	handlers = new Map<string, ExtensionHandler>();
	stored: Record<string, unknown>;
	usage: ContextUsage | undefined;
	notifications: string[] = [];
	placement: string | undefined;
	widget: ContextWeatherWidget | undefined;
	widgetCalls: Array<{ content: unknown }> = [];
	renderRequests = 0;

	#scheduler = new FakeScheduler();
	#ctx: ExtensionContext;

	constructor(
		stored: Record<string, unknown> = {},
		env: Record<string, string | undefined> = {},
		readPluginSettings?: (cwd: string) => Promise<Record<string, unknown>>,
		motionEnvironment?: (tui: TUI) => MotionEnvironment,
	) {
		this.stored = stored;

		const tui = {
			requestComponentRender: () => {
				this.renderRequests++;
			},
			synchronizedOutput: false,
			renderUnderPressure: false,
		} as unknown as TUI;

		this.#ctx = {
			hasUI: true,
			cwd: "/fake",
			getContextUsage: () => this.usage,
			ui: {
				setWidget: (_key: string, content: unknown, options?: { placement?: string }) => {
					this.widgetCalls.push({ content });
					if (options?.placement !== undefined) this.placement = options.placement;
					if (typeof content === "function") {
						this.widget = (content as (tui: TUI, theme: Theme) => ContextWeatherWidget)(tui, fakeTheme());
					} else if (content === undefined) {
						this.widget = undefined;
					}
				},
				notify: (message: string) => {
					this.notifications.push(message);
				},
			},
		} as unknown as ExtensionContext;

		const options: ContextWeatherExtensionOptions = {
			readPluginSettings: readPluginSettings ?? (async () => this.stored),
			env,
			motionEnvironment: motionEnvironment ?? (() => ({ hasUI: true, isTTY: true, env: {} })),
			scheduler: this.#scheduler,
		};
		const extension = createContextWeatherExtension(options);
		extension({
			setLabel: () => {},
			logger: {
				warn: () => {},
				error: () => {},
				info: () => {},
				debug: () => {},
			},
			on: (event: string, handler: ExtensionHandler) => {
				this.handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI);
	}

	get ctx(): ExtensionContext {
		return this.#ctx;
	}

	async emit(name: string): Promise<void> {
		await this.handlers.get(name)?.({}, this.ctx);
	}

	async shutdown(): Promise<void> {
		await this.emit("session_shutdown");
	}
}

describe("context weather extension settings wiring", () => {
	it("applies manifest-stored settings at mount", async () => {
		const harness = new ExtensionHarness({
			animations: "full",
			contextWeatherPlacement: "belowEditor",
			contextWeatherStormAtPercent: 50,
		});
		try {
			harness.usage = usageFixture(60);
			await harness.emit("session_start");

			expect(harness.placement).toBe("belowEditor");
			expect(harness.widget?.animating).toBe(true);
			expect(harness.widget?.imminent).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	it("re-reads the store and re-resolves the tier without a remount on refresh", async () => {
		const harness = new ExtensionHarness({ animations: "off" });
		try {
			harness.usage = usageFixture(20);
			await harness.emit("session_start");
			const widget = harness.widget;
			expect(widget?.animating).toBe(false);

			harness.stored.animations = "full";
			harness.usage = usageFixture(40);
			await harness.emit("context");
			expect(harness.widget).toBe(widget);
			expect(harness.widget?.animating).toBe(true);

			harness.stored.animations = "off";
			await harness.emit("context");
			expect(harness.widget).toBe(widget);
			expect(harness.widget?.animating).toBe(false);
		} finally {
			await harness.shutdown();
		}
	});

	it("recovers from cleared render pressure when a context refresh keeps the same setting", async () => {
		let underPressure = true;
		const harness = new ExtensionHarness({ animations: "full" }, {}, undefined, () => ({
			hasUI: true,
			isTTY: true,
			env: {},
			backpressure: {
				get underPressure() {
					return underPressure;
				},
			},
		}));
		try {
			await harness.emit("session_start");
			const widget = harness.widget;
			expect(widget?.animating).toBe(false);

			underPressure = false;
			await harness.emit("context");

			expect(harness.widget).toBe(widget);
			expect(harness.widget?.animating).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	it("uses env fallback when the store is empty and lets the store win when both are set", async () => {
		const env = { OMP_CONTEXT_WEATHER_ANIMATIONS: "full" };
		const envHarness = new ExtensionHarness({}, env);
		try {
			await envHarness.emit("session_start");
			expect(envHarness.widget?.animating).toBe(true);
		} finally {
			await envHarness.shutdown();
		}

		const storedHarness = new ExtensionHarness({ animations: "off" }, env);
		try {
			await storedHarness.emit("session_start");
			expect(storedHarness.widget?.animating).toBe(false);
		} finally {
			await storedHarness.shutdown();
		}
	});

	it("remounts with new settings when placement changes on refresh", async () => {
		const harness = new ExtensionHarness();
		try {
			await harness.emit("session_start");
			const first = harness.widget;

			harness.stored.contextWeatherPlacement = "belowEditor";
			await harness.emit("context");

			expect(harness.widget).not.toBe(first);
			expect(harness.placement).toBe("belowEditor");
		} finally {
			await harness.shutdown();
		}
	});

	it("gates the one-shot imminent notification from stored settings", async () => {
		const harness = new ExtensionHarness({
			contextWeatherNotifyOnImminent: false,
			contextWeatherStormAtPercent: 50,
		});
		try {
			harness.usage = usageFixture(30);
			await harness.emit("session_start");

			harness.usage = usageFixture(90);
			await harness.emit("context");
			expect(harness.notifications).toHaveLength(0);

			harness.stored.contextWeatherNotifyOnImminent = true;
			harness.usage = usageFixture(30);
			await harness.emit("context");
			harness.usage = usageFixture(90);
			await harness.emit("context");
			harness.usage = usageFixture(95);
			await harness.emit("context");

			expect(harness.notifications).toHaveLength(1);
		} finally {
			await harness.shutdown();
		}
	});

	it("does not install a widget when shutdown overtakes a pending settings read", async () => {
		const settings = Promise.withResolvers<Record<string, unknown>>();
		const harness = new ExtensionHarness({}, {}, async () => settings.promise);
		const mounting = harness.emit("session_start");

		await harness.emit("session_shutdown");
		const callsAtShutdown = harness.widgetCalls.length;
		settings.resolve({ animations: "full" });
		await mounting;

		expect(harness.widgetCalls.slice(callsAtShutdown).some(call => call.content !== undefined)).toBe(false);
		expect(harness.widget).toBeUndefined();
	});
});
