/** Immutable snapshot handed to the pure renderer each frame. */
export interface PromptChargeSnapshot {
	/** Character count of the editor's current live text, as of the last poll. */
	readonly typedChars: number;
	/** Clock reading (shared `FrameScheduler`) the most recent release burst started at; `undefined` before any submit this session, or once superseded by a later release. */
	readonly releaseStartAt: number | undefined;
	/** Charge fraction captured at the moment of the most recent release — the burst's starting intensity, decaying from here as the release progresses. */
	readonly chargeAtRelease: number;
}

/**
 * Mutable, session-scoped model of the caret's charge. There is no
 * per-keystroke `ExtensionEvent` anywhere in this codebase (confirmed by a
 * full sweep of the `ExtensionEvent` union) — `typedChars` is instead
 * *polled*, once per animation frame, from `ExtensionContext.ui.getEditorText()`
 * (see `widget.ts`'s `onFrame`), the shared `AnimationHost` frame clock
 * standing in for the missing keystroke event. A submit (the real `input`
 * event, which only fires at that moment) starts a release burst captured
 * at the charge level typed right before it; the burst's own decay is a pure
 * function of elapsed time (see `charge.ts`), so no explicit "settle" call
 * is needed — a fully-decayed burst simply evaluates to zero forever after.
 * All timestamps come from the caller's injected clock (never
 * `Date.now`/`performance.now` read directly here), so the whole state
 * machine is deterministic and snapshot-testable.
 */
export class PromptChargeState {
	#typedChars = 0;
	#releaseStartAt: number | undefined;
	#chargeAtRelease = 0;

	/** Record the editor's current character count, polled once per animation frame. Negative/NaN inputs clamp to `0`. */
	sampleEditorLength(chars: number): void {
		this.#typedChars = Number.isFinite(chars) && chars > 0 ? chars : 0;
	}

	/** Start a release burst from `chargeAtRelease` (the charge fraction captured at submit time), stamped at `now`. Supersedes any burst already in flight. */
	release(chargeAtRelease: number, now: number): void {
		this.#chargeAtRelease = chargeAtRelease;
		this.#releaseStartAt = now;
	}

	/** Immutable view for the pure renderer. */
	snapshot(): PromptChargeSnapshot {
		return {
			typedChars: this.#typedChars,
			releaseStartAt: this.#releaseStartAt,
			chargeAtRelease: this.#chargeAtRelease,
		};
	}
}
