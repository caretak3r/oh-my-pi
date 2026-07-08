/** Immutable snapshot handed to the pure renderer each frame. */
export interface ModelWeatherVaneSnapshot {
	/** The active model's wire id (`AssistantMessage.model`), or `undefined` before the first assistant message. */
	readonly currentModelId: string | undefined;
	/** The active model's provider (`AssistantMessage.provider`), or `undefined` before the first assistant message. */
	readonly currentProvider: string | undefined;
	/** The previously active model's id, kept only to anchor an in-flight spin's start direction; `undefined` once the spin settles. */
	readonly previousModelId: string | undefined;
	/** Clock reading (shared `FrameScheduler`) the current spin started at; `undefined` when no spin is in flight. */
	readonly spinStartAt: number | undefined;
	/** Count of assistant messages observed this session. */
	readonly messageCount: number;
}

/**
 * Mutable, session-scoped model of the active model identity. All timestamps
 * come from the caller's injected clock (never `Date.now`/`performance.now`
 * read directly here), so the whole state machine is deterministic and
 * snapshot-testable. The very first assistant message this session observes
 * initializes the emblem silently — only a change on a *later* message
 * (a genuine mid-session switch) starts a spin, matching Goal Horizon's
 * "no retroactive flare on fresh state" precedent.
 */
export class ModelWeatherVaneState {
	#currentModelId: string | undefined;
	#currentProvider: string | undefined;
	#previousModelId: string | undefined;
	#spinStartAt: number | undefined;
	#messageCount = 0;

	/**
	 * Record one assistant message's already-resolved model/provider, stamped
	 * at `now` (the shared clock). Empty/blank model ids are ignored (no such
	 * message should exist — `AssistantMessage.model` is a required field —
	 * but this keeps the state machine well-defined). Returns whether this
	 * message started a new spin (a genuine switch from a previously seen
	 * model, not the session's first sighting).
	 */
	recordAssistantMessage(modelId: string, provider: string, now: number): boolean {
		if (modelId.length === 0) return false;
		this.#messageCount += 1;

		const isFirstSighting = this.#currentModelId === undefined;
		const isSwitch = !isFirstSighting && modelId !== this.#currentModelId;
		if (isSwitch) {
			this.#previousModelId = this.#currentModelId;
			this.#spinStartAt = now;
		}
		this.#currentModelId = modelId;
		this.#currentProvider = provider;
		return isSwitch;
	}

	/** Immutable view for the pure renderer. */
	snapshot(): ModelWeatherVaneSnapshot {
		return {
			currentModelId: this.#currentModelId,
			currentProvider: this.#currentProvider,
			previousModelId: this.#previousModelId,
			spinStartAt: this.#spinStartAt,
			messageCount: this.#messageCount,
		};
	}
}
