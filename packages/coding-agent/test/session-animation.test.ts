import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeSessionAnimation, sessionAnimation } from "@oh-my-pi/pi-coding-agent/modes/session-animation";
import type { TUI } from "@oh-my-pi/pi-tui";

class FakeScheduler implements FrameScheduler {
	#now = 0;
	#nextId = 0;
	#timers = new Map<number, { intervalMs: number; tick: () => void; nextAt: number }>();
	startCount = 0;

	now(): number {
		return this.#now;
	}

	start(intervalMs: number, tick: () => void): () => void {
		const id = this.#nextId++;
		this.startCount++;
		this.#timers.set(id, { intervalMs, tick, nextAt: this.#now + intervalMs });
		return () => {
			this.#timers.delete(id);
		};
	}

	get activeTimers(): number {
		return this.#timers.size;
	}
}

const createdTuis: TUI[] = [];

function fakeTui(): TUI {
	const tui = { renderUnderPressure: false } as unknown as TUI;
	createdTuis.push(tui);
	return tui;
}

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	for (const tui of createdTuis.splice(0)) disposeSessionAnimation(tui);
	resetSettingsForTest();
});

describe("sessionAnimation", () => {
	it("returns the same host for repeated access with one TUI", () => {
		const tui = fakeTui();

		const first = sessionAnimation(tui, undefined, { isTTY: true, env: {} });
		const second = sessionAnimation(tui, undefined, { isTTY: true, env: {} });

		expect(second.host).toBe(first.host);
	});

	it("isolates hosts belonging to different TUI sessions", () => {
		const first = sessionAnimation(fakeTui(), undefined, { isTTY: true, env: {} });
		const second = sessionAnimation(fakeTui(), undefined, { isTTY: true, env: {} });

		expect(second.host).not.toBe(first.host);
	});

	it("creates a fresh host after idempotent disposal", () => {
		const tui = fakeTui();
		const first = sessionAnimation(tui, undefined, { isTTY: true, env: {} });

		disposeSessionAnimation(tui);
		disposeSessionAnimation(tui);
		const second = sessionAnimation(tui, undefined, { isTTY: true, env: {} });

		expect(second.host).not.toBe(first.host);
	});

	it("shares one scheduler timer across two subscribers", () => {
		const tui = fakeTui();
		const scheduler = new FakeScheduler();
		const { host, policy } = sessionAnimation(tui, scheduler, { isTTY: true, env: {} });

		host.subscribe(() => {});
		host.subscribe(() => {});

		expect(policy.tier).toBe("full");
		expect(scheduler.startCount).toBe(1);
		expect(scheduler.activeTimers).toBe(1);
	});

	it("re-syncs the cached policy from live backpressure on repeated access", async () => {
		await Settings.init({ inMemory: true });
		const pressure = { underPressure: true };
		const tui = {
			get renderUnderPressure() {
				return pressure.underPressure;
			},
		} as unknown as TUI;
		createdTuis.push(tui);
		const first = sessionAnimation(tui, undefined, { isTTY: true, env: {} });
		expect(first.policy.tier).toBe("off");

		pressure.underPressure = false;
		const second = sessionAnimation(tui, undefined, { isTTY: true, env: {} });

		expect(second).toBe(first);
		expect(second.policy.tier).toBe("full");
	});

	it("follows display.animations changes live without remounting", async () => {
		await Settings.init({ inMemory: true });
		const tui = fakeTui();
		const animation = sessionAnimation(tui, undefined, { isTTY: true, env: {} });
		const host = animation.host;
		expect(animation.policy.tier).toBe("full");

		settings.set("display.animations", "off");

		expect(animation.host).toBe(host);
		expect(animation.policy.tier).toBe("off");
	});
});
