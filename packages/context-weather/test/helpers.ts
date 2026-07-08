import type { AnimatedWidgetHost, FrameScheduler } from "@oh-my-pi/pi-animation";
import type { ContextUsage, Theme } from "@oh-my-pi/pi-coding-agent";

/**
 * Deterministic clock/scheduler seam: timers fire only on explicit {@link step}/
 * {@link fire}, never on wall time, so every frame is driven by the test.
 */
export class FakeScheduler implements FrameScheduler {
	#now = 0;
	#tick: (() => void) | undefined;
	intervalMs = 0;
	startCount = 0;

	now(): number {
		return this.#now;
	}

	start(intervalMs: number, tick: () => void): () => void {
		this.intervalMs = intervalMs;
		this.#tick = tick;
		this.startCount++;
		return () => {
			this.#tick = undefined;
			this.intervalMs = 0;
		};
	}

	/** Advance the clock without emitting a frame. */
	advance(ms: number): void {
		this.#now += ms;
	}

	/** Emit a frame at the current clock without advancing. */
	fire(): void {
		this.#tick?.();
	}

	/** Advance by one active cadence and emit a frame (the common animation step). */
	step(): void {
		if (this.intervalMs > 0) {
			this.#now += this.intervalMs;
			this.#tick?.();
		}
	}
}

/** No-op scoped-repaint host for widget tests. */
export const noopHost: AnimatedWidgetHost = { requestComponentRender: () => {} };

/**
 * Minimal {@link Theme} stand-in. `fg` emits a real 24-bit (truecolor) escape so
 * the degrade test can assert its absence; only the members the renderer/widget
 * touch are implemented.
 */
export function fakeTheme(colorMode: "truecolor" | "256color" = "truecolor"): Theme {
	return {
		fg: (_color: string, text: string) => `\x1b[38;2;1;2;3m${text}\x1b[39m`,
		getColorMode: () => colorMode,
	} as unknown as Theme;
}

/** Build a `ContextUsage` fixture from percent + window (+ optional forecast). */
export function usageFixture(percent: number, contextWindow = 200_000, extra?: Partial<ContextUsage>): ContextUsage {
	return {
		tokens: Math.round((percent / 100) * contextWindow),
		contextWindow,
		percent,
		...extra,
	};
}
