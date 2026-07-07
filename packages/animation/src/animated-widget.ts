import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { AnimationHost } from "./animation-host";
import type { MotionPolicy } from "./motion-policy";

/** The slice of `TUI` an {@link AnimatedWidget} needs: scoped repaint only. */
export type AnimatedWidgetHost = Pick<TUI, "requestComponentRender">;

export interface AnimatedWidgetOptions {
	/**
	 * The `tui` handed to the widget factory. Held for scoped repaints via
	 * `tui.requestComponentRender(this)` (TUI method, not `ctx.ui`).
	 */
	tui: AnimatedWidgetHost;
	/** Shared frame clock this widget subscribes to while mounted. */
	host: AnimationHost;
	/** Motion policy; tier `off` means render one static frame and never subscribe. */
	policy: MotionPolicy;
}

/** Compare two row arrays for byte-identical content. */
function rowsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Base `Component` for ambient animated widgets. It owns the shared lifecycle so
 * each concrete widget is just "a pure model + a renderer":
 *
 * - On construction it subscribes to the {@link AnimationHost} (unless the
 *   {@link MotionPolicy} tier is `off`, in which case it renders one static frame
 *   and never subscribes).
 * - Each frame it advances `elapsedMs`, calls the overridable {@link onFrame}
 *   hook, then re-renders at the last known width and — only if the rendered rows
 *   changed — requests a component-scoped repaint via
 *   `tui.requestComponentRender(this)`.
 * - `dispose()` unsubscribes and is idempotent (no leaked subscriber).
 *
 * Subclasses implement {@link renderFrame} to produce rows from their state and
 * the current phase (`this.elapsedMs`).
 */
export abstract class AnimatedWidget implements Component {
	#tui: AnimatedWidgetHost;
	#host: AnimationHost;
	#unsubscribe: (() => void) | undefined;
	#disposed = false;
	#elapsedMs = 0;
	#lastWidth: number | undefined;
	#lastRows: readonly string[] = [];

	constructor(options: AnimatedWidgetOptions) {
		this.#tui = options.tui;
		this.#host = options.host;
		if (options.policy.tier !== "off") {
			this.#unsubscribe = this.#host.subscribe((_frame, elapsedMs) => this.#handleFrame(elapsedMs));
		}
	}

	/** Milliseconds elapsed since the host started — the animation phase. */
	get elapsedMs(): number {
		return this.#elapsedMs;
	}

	/** Whether this widget is subscribed to the frame clock. */
	get animating(): boolean {
		return this.#unsubscribe !== undefined;
	}

	/**
	 * Render the widget's rows at `width` for the current phase (`this.elapsedMs`).
	 * Must be a pure function of the widget's state and phase. Called both by the
	 * TUI and internally by the frame loop, so it must not mutate lifecycle state.
	 */
	abstract renderFrame(width: number): readonly string[];

	/**
	 * Overridable per-frame hook, called before the re-render/diff. Advance model
	 * state here; leave the actual drawing to {@link renderFrame}. Default no-op.
	 */
	onFrame(_elapsedMs: number): void {}

	/** {@link Component} entrypoint. Caches rows per width so the frame loop can diff cheaply. */
	render(width: number): readonly string[] {
		if (width === this.#lastWidth) return this.#lastRows;
		this.#lastWidth = width;
		this.#lastRows = this.renderFrame(width);
		return this.#lastRows;
	}

	/**
	 * Invalidate the width-keyed render cache so the next {@link render} recomputes
	 * from current state. Call after the widget's state changes *between* frames —
	 * e.g. an event-driven refresh, or any change while the `off` tier is active and
	 * the frame loop is not running. Without it, {@link render} would return the
	 * cached rows for the last width and the external change would not be drawn.
	 * (The frame loop already re-renders each tick, so animating tiers do not need
	 * this; it is the seam that lets a non-timer, off-tier-static widget update.)
	 */
	markDirty(): void {
		this.#lastWidth = undefined;
	}

	/** Lifecycle teardown: unsubscribe from the frame clock. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	#handleFrame(elapsedMs: number): void {
		if (this.#disposed) return;
		this.#elapsedMs = elapsedMs;
		this.onFrame(elapsedMs);
		const width = this.#lastWidth;
		if (width === undefined) {
			// Not laid out yet: request an initial paint; render() will produce rows.
			this.#tui.requestComponentRender(this);
			return;
		}
		const next = this.renderFrame(width);
		if (rowsEqual(next, this.#lastRows)) return;
		this.#lastRows = next;
		this.#tui.requestComponentRender(this);
	}
}
