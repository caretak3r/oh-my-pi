import { beforeAll, describe, expect, it } from "bun:test";
import { AnimationHost, type BackpressureSignal, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	type CompactionAction,
	CompactionVacuumWidget,
	compactionKeptCaption,
	formatCompactionSettle,
	formatTokensCompact,
} from "../src/modes/components/compaction-vacuum";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	// The widget colors rows via the global theme singleton, unassigned until init.
	await initTheme();
});

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

/** Deterministic scheduler seam so frames advance on explicit `advance` calls. */
class FakeScheduler implements FrameScheduler {
	#now = 0;
	#timers = new Map<number, { intervalMs: number; tick: () => void; nextAt: number }>();
	#nextId = 0;

	now(): number {
		return this.#now;
	}

	start(intervalMs: number, tick: () => void): () => void {
		const id = this.#nextId++;
		this.#timers.set(id, { intervalMs, tick, nextAt: this.#now + intervalMs });
		return () => {
			this.#timers.delete(id);
		};
	}

	advance(ms: number): void {
		const target = this.#now + ms;
		let guard = 0;
		while (true) {
			let due: { intervalMs: number; tick: () => void; nextAt: number } | undefined;
			for (const t of this.#timers.values()) {
				if (t.nextAt <= target && (due === undefined || t.nextAt < due.nextAt)) due = t;
			}
			if (due === undefined) break;
			this.#now = due.nextAt;
			due.nextAt += due.intervalMs;
			due.tick();
			if (++guard > 1_000_000) throw new Error("runaway scheduler advance");
		}
		this.#now = target;
	}
}

const NO_PRESSURE: BackpressureSignal = { underPressure: false };

function policy(tier: "full" | "subtle" | "off"): MotionPolicy {
	return new MotionPolicy({ hasUI: true, isTTY: true, env: {}, backpressure: NO_PRESSURE }, tier);
}

/** Counts scoped repaints so the "repaints on frame change" contract is observable. */
class RepaintSpy {
	count = 0;
	requestComponentRender(_component: Component): void {
		this.count++;
	}
}

function makeWidget(opts: { tier: "full" | "subtle" | "off"; action?: CompactionAction; beforeTokens?: number }): {
	widget: CompactionVacuumWidget;
	host: AnimationHost;
	scheduler: FakeScheduler;
	tui: RepaintSpy;
} {
	const scheduler = new FakeScheduler();
	const pol = policy(opts.tier);
	const host = new AnimationHost({ policy: pol, scheduler });
	const tui = new RepaintSpy();
	const widget = new CompactionVacuumWidget({
		tui,
		host,
		policy: pol,
		action: opts.action ?? "context-full",
		beforeTokens: opts.beforeTokens ?? 142_000,
		reasonText: "Context overflow detected, ",
		escHint: " (esc to cancel)",
	});
	return { widget, host, scheduler, tui };
}

describe("formatTokensCompact", () => {
	it("renders compact k-forms and clamps negatives", () => {
		expect(formatTokensCompact(142_000)).toBe("142k");
		expect(formatTokensCompact(38_000)).toBe("38k");
		expect(formatTokensCompact(1_000)).toBe("1k");
		expect(formatTokensCompact(1_250)).toBe("1.3k");
		expect(formatTokensCompact(999)).toBe("999");
		expect(formatTokensCompact(-5)).toBe("0");
	});
});

describe("formatCompactionSettle", () => {
	it("reports before→after with reclaimed count and the strategy's kept caption", () => {
		const line = formatCompactionSettle({ action: "context-full", beforeTokens: 142_000, afterTokens: 38_000 });
		expect(line).toBe("Auto context-full · 142k → 38k (−104k, kept goals, open files, TODOs)");
	});

	it("uses the honest kept caption per strategy", () => {
		expect(formatCompactionSettle({ action: "shake", beforeTokens: 100_000, afterTokens: 60_000 })).toContain(
			"trimmed tool output",
		);
		expect(formatCompactionSettle({ action: "handoff", beforeTokens: 100_000, afterTokens: 5_000 })).toContain(
			"handed off to fresh context",
		);
	});

	it("never claims a reclaim when there is none (no false or negative reclaimed)", () => {
		// after >= before: nothing reclaimed.
		expect(
			formatCompactionSettle({ action: "context-full", beforeTokens: 40_000, afterTokens: 40_000 }),
		).toBeUndefined();
		expect(
			formatCompactionSettle({ action: "context-full", beforeTokens: 40_000, afterTokens: 55_000 }),
		).toBeUndefined();
		// after unknown/zero (aborted/skipped path feeds 0): no honest after count.
		expect(formatCompactionSettle({ action: "context-full", beforeTokens: 142_000, afterTokens: 0 })).toBeUndefined();
		// before unknown: nothing to compare against.
		expect(formatCompactionSettle({ action: "context-full", beforeTokens: 0, afterTokens: 0 })).toBeUndefined();
	});
});

describe("compactionKeptCaption", () => {
	it("distinguishes summarizing strategies from trimming/handoff", () => {
		expect(compactionKeptCaption("context-full")).toBe("kept goals, open files, TODOs");
		expect(compactionKeptCaption("snapcompact")).toBe("kept goals, open files, TODOs");
		expect(compactionKeptCaption("shake")).toBe("trimmed tool output");
		expect(compactionKeptCaption("handoff")).toBe("handed off to fresh context");
	});
});

describe("CompactionVacuumWidget animation", () => {
	it("subscribes to the shared clock and animates (frame changes over time)", () => {
		const { widget, host, scheduler } = makeWidget({ tier: "full" });
		expect(host.subscriberCount).toBe(1);

		const first = strip(widget.renderFrame(80)[0]!);
		scheduler.advance(300);
		const later = strip(widget.renderFrame(80)[0]!);
		expect(later).not.toBe(first);
		// The before-token figure stays visible throughout the condense phase.
		expect(first).toContain("142k");
		expect(later).toContain("142k");
		// It reads as a condense/"working" state, not a stalled freeze.
		expect(first).toContain("condensing");
	});

	it("requests a scoped repaint when an advanced frame changes the rows", () => {
		const { widget, scheduler, tui } = makeWidget({ tier: "full" });
		// Simulate initial layout so the widget has a known width to diff against.
		widget.render(80);
		const before = tui.count;
		scheduler.advance(300);
		expect(tui.count).toBeGreaterThan(before);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const { widget, host, scheduler, tui } = makeWidget({ tier: "off" });
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);

		const frame = strip(widget.renderFrame(80)[0]!);
		widget.render(80);
		scheduler.advance(1_000);
		// No clock subscription → no repaints and a frozen frame.
		expect(tui.count).toBe(0);
		expect(strip(widget.renderFrame(80)[0]!)).toBe(frame);
	});

	it("truncates to the available width", () => {
		const { widget } = makeWidget({ tier: "full" });
		const row = widget.renderFrame(20)[0]!;
		expect(Bun.stringWidth(row, { countAnsiEscapeCodes: false })).toBeLessThanOrEqual(20);
	});

	it("dispose unsubscribes from the shared clock and is idempotent", () => {
		const { widget, host, scheduler, tui } = makeWidget({ tier: "full" });
		expect(host.subscriberCount).toBe(1);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);

		const afterDispose = tui.count;
		scheduler.advance(1_000);
		expect(tui.count).toBe(afterDispose); // no frames after teardown

		// Idempotent: a second dispose is a no-op.
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});
});
