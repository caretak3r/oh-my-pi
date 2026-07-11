import { BAND_ALPHAS, BAND_COUNT, PEAK_DECAY_PER_FRAME, stepBands } from "./bars";

/**
 * Mutable, session-scoped model of the equalizer's bands and their
 * peak-hold markers. Fixed length ({@link BAND_COUNT}) for the state's
 * lifetime, zero-initialized. Mutation happens only in {@link pushSample},
 * driven by the widget's per-frame sampling; rendering reads immutable
 * snapshots.
 */
export class CadenceEqualizerState {
	#bands: number[];
	#peaks: number[];
	#alphas: readonly number[];
	#peakDecayPerFrame: number;

	constructor(options: { alphas?: readonly number[]; peakDecayPerFrame?: number } = {}) {
		this.#alphas = options.alphas ?? BAND_ALPHAS;
		this.#peakDecayPerFrame = options.peakDecayPerFrame ?? PEAK_DECAY_PER_FRAME;
		this.#bands = new Array(this.#alphas.length).fill(0);
		this.#peaks = new Array(this.#alphas.length).fill(0);
	}

	/** Number of bands (fixed for the state's lifetime). */
	get bandCount(): number {
		return this.#alphas.length;
	}

	/** Step every band/peak one frame toward a normalized `[0, 1]` amplitude reading. Non-finite/negative coerces to `0` (idle). */
	pushSample(targetAmplitude: number): void {
		const target = Number.isFinite(targetAmplitude) && targetAmplitude > 0 ? targetAmplitude : 0;
		const { bands, peaks } = stepBands(this.#bands, this.#peaks, target, this.#alphas, this.#peakDecayPerFrame);
		this.#bands = bands;
		this.#peaks = peaks;
	}

	/** Immutable snapshot of current band amplitudes, `[0, 1]` each. */
	snapshotBands(): readonly number[] {
		return [...this.#bands];
	}

	/** Immutable snapshot of current peak-hold markers, `[0, 1]` each. */
	snapshotPeaks(): readonly number[] {
		return [...this.#peaks];
	}
}
