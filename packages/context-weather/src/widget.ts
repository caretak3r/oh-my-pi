import { AnimatedWidget, type AnimatedWidgetOptions } from "@oh-my-pi/pi-animation";
import type { ContextUsage, Theme } from "@oh-my-pi/pi-coding-agent";
import { contextWeatherModel, type VisualState, visualStateEqual, type WeatherForecast } from "./model";
import { type BarometerCaps, type ContextWeatherStyle, DEFAULT_CAPS, renderBarometer } from "./renderer";

export interface ContextWeatherWidgetOptions extends AnimatedWidgetOptions {
	theme: Theme;
	style: ContextWeatherStyle;
	caps?: BarometerCaps;
	/** Fallback storm threshold (context %) when no forecast is available. */
	stormAtPercent: number;
	initialUsage?: ContextUsage;
	initialForecast?: WeatherForecast;
}

/**
 * Composes the pure {@link contextWeatherModel} + deterministic {@link renderBarometer}
 * onto the kit's {@link AnimatedWidget} base. The base owns the frame timer, the
 * diff-guarded repaint, and mount/dispose; this subclass only holds the cached
 * {@link VisualState} and draws it at the current phase (`this.elapsedMs`).
 *
 * Usage is refreshed via {@link setUsage} on a change boundary (a `ContextEvent`),
 * never polled per-frame.
 */
export class ContextWeatherWidget extends AnimatedWidget {
	#theme: Theme;
	#style: ContextWeatherStyle;
	#caps: BarometerCaps;
	#stormAtPercent: number;
	#state: VisualState;

	constructor(options: ContextWeatherWidgetOptions) {
		super(options);
		this.#theme = options.theme;
		this.#style = options.style;
		this.#caps = options.caps ?? DEFAULT_CAPS;
		this.#stormAtPercent = options.stormAtPercent;
		this.#state = contextWeatherModel(options.initialUsage, options.initialForecast, {
			stormAtPercent: this.#stormAtPercent,
		});
	}

	/** Current cached visual state. */
	get state(): VisualState {
		return this.#state;
	}

	/** Whether the widget is currently in a storm (imminent auto-compaction). */
	get imminent(): boolean {
		return this.#state.imminent;
	}

	/**
	 * Recompute the visual state from fresh usage/forecast. Returns whether it
	 * changed; on a change it also invalidates the render cache so an event-driven
	 * (or `off`-tier static) repaint reflects the new state.
	 */
	setUsage(usage: ContextUsage | undefined, forecast?: WeatherForecast): boolean {
		const next = contextWeatherModel(usage, forecast, { stormAtPercent: this.#stormAtPercent });
		if (visualStateEqual(next, this.#state)) return false;
		this.#state = next;
		this.markDirty();
		return true;
	}

	renderFrame(width: number): readonly string[] {
		return [
			renderBarometer(this.#state, this.elapsedMs, this.#theme, width, {
				style: this.#style,
				caps: this.#caps,
			}),
		];
	}
}
