import { type FireflyStatus, isPrunable } from "./firefly";

/** The subset of `AgentRef` this feature reads. Decoupled from `AgentRegistry`'s own type so state stays unit-testable with plain literal objects. */
export interface AgentFleetRefSource {
	readonly id: string;
	readonly displayName: string;
	readonly kind: "main" | "sub" | "advisor";
	readonly status: "running" | "idle" | "parked" | "aborted";
}

/** The subset of `RegistryEvent` this feature reads. */
export interface AgentFleetRegistryEventSource {
	readonly type: "registered" | "status_changed" | "removed";
	readonly ref: AgentFleetRefSource;
}

interface FireflyRecord {
	id: string;
	displayName: string;
	status: FireflyStatus;
	spawnedAt: number;
	statusChangedAt: number;
}

/** One firefly rendered for the current frame. */
export interface FireflySnapshot {
	readonly id: string;
	readonly displayName: string;
	readonly status: FireflyStatus;
	readonly spawnedAt: number;
	readonly statusChangedAt: number;
}

/** Immutable snapshot handed to the pure renderer each frame. */
export interface AgentFleetSnapshot {
	readonly fireflies: readonly FireflySnapshot[];
	readonly workingCount: number;
	readonly doneCount: number;
	readonly failedCount: number;
}

/** Map a registry `AgentStatus` onto this feature's three-state firefly visual. `idle` and `parked` both read as `done` — both mean "not currently running", and the distinction (revivable vs not) has no visual analog here. Pure. */
function toFireflyStatus(status: AgentFleetRefSource["status"]): FireflyStatus {
	if (status === "running") return "working";
	if (status === "aborted") return "failed";
	return "done";
}

/**
 * Mutable, process-scoped model of the subagent fleet. Derived entirely from
 * `AgentRegistry.onChange` events — filtered to `kind === "sub"` (the main
 * session and advisor transcripts are never fireflies, mirroring the
 * precedent set by `countRunningSubagentBadgeAgents` in
 * `modes/running-subagent-badge.ts`, which uses the same `kind === "sub"`
 * filter for the existing subagent-count badge). A `status_changed` (or even
 * `registered`) event for an id not yet tracked is treated as an implicit
 * upsert, so a controller that starts watching mid-flight (or missed an
 * earlier event) still converges to the correct state on the next event
 * rather than staying silently wrong.
 */
export class AgentFleetState {
	#fireflies = new Map<string, FireflyRecord>();
	#order: string[] = [];

	/** Apply one registry event, stamping any new record or status transition with `elapsedMs` (the shared clock). Returns whether anything visible changed. Non-`sub` refs are ignored entirely. */
	applyRegistryEvent(event: AgentFleetRegistryEventSource, elapsedMs: number): boolean {
		if (event.ref.kind !== "sub") return false;

		if (event.type === "removed") {
			if (!this.#fireflies.delete(event.ref.id)) return false;
			this.#order = this.#order.filter(id => id !== event.ref.id);
			return true;
		}

		const status = toFireflyStatus(event.ref.status);
		const existing = this.#fireflies.get(event.ref.id);
		if (!existing) {
			this.#fireflies.set(event.ref.id, {
				id: event.ref.id,
				displayName: event.ref.displayName,
				status,
				spawnedAt: elapsedMs,
				statusChangedAt: elapsedMs,
			});
			this.#order.push(event.ref.id);
			return true;
		}

		let changed = false;
		if (existing.displayName !== event.ref.displayName) {
			existing.displayName = event.ref.displayName;
			changed = true;
		}
		if (existing.status !== status) {
			existing.status = status;
			existing.statusChangedAt = elapsedMs;
			changed = true;
		}
		return changed;
	}

	/** Remove fireflies whose fade/blink-out has finished by `elapsedMs`. Call on every event (so the static/off tier — with no frame clock — still cleans up) and every animated frame. Returns whether anything was pruned. */
	pruneFireflies(elapsedMs: number): boolean {
		let pruned = false;
		for (const id of [...this.#order]) {
			const record = this.#fireflies.get(id);
			if (!record) continue;
			if (isPrunable(record.status, elapsedMs - record.statusChangedAt)) {
				this.#fireflies.delete(id);
				this.#order = this.#order.filter(x => x !== id);
				pruned = true;
			}
		}
		return pruned;
	}

	/** Immutable view for the pure renderer. */
	snapshot(): AgentFleetSnapshot {
		const fireflies = this.#order
			.map(id => this.#fireflies.get(id))
			.filter((f): f is FireflyRecord => f !== undefined);
		let workingCount = 0;
		let doneCount = 0;
		let failedCount = 0;
		for (const firefly of fireflies) {
			if (firefly.status === "working") workingCount++;
			else if (firefly.status === "done") doneCount++;
			else failedCount++;
		}
		return {
			fireflies: fireflies.map(f => ({ ...f })),
			workingCount,
			doneCount,
			failedCount,
		};
	}
}
