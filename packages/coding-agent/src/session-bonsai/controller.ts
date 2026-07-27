import type { FrameScheduler } from "@oh-my-pi/pi-animation";
import { type AnimationHost, DEFAULT_FRAME_SCHEDULER } from "@oh-my-pi/pi-animation";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "../extensibility/extensions";
import type { SessionBranchEvent, SessionTreeEvent } from "../extensibility/extensions/types";
import type { SessionAnimationHandle } from "../modes/session-animation";
import { BonsaiState } from "./state";
import type { RawTreeNode } from "./tree";
import { type BonsaiTheme, renderBonsaiOffText, SessionBonsaiWidget } from "./widget";

const WIDGET_KEY = "session-bonsai";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "belowEditor" };

/** The subset of a `SessionTreeNode` this controller reads: an entry id + children (recursively). Decoupled from the real session-entry union so the controller stays unit-testable with plain literal objects. */
export interface BonsaiTreeSourceNode {
	readonly entry: { readonly id: string };
	readonly children: readonly BonsaiTreeSourceNode[];
}

/** Minimal slice of `ReadonlySessionManager` this controller needs. */
export interface BonsaiSessionSource {
	getTree(): readonly BonsaiTreeSourceNode[];
	getLeafId(): string | null;
}

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface SessionBonsaiContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Session-shared clock+policy; when absent the widget renders static. */
	animation?: SessionAnimationHandle;
	theme: BonsaiTheme;
	sessionManager: BonsaiSessionSource;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost; owned: false } | { mode: "static" };

function toRawTree(nodes: readonly BonsaiTreeSourceNode[]): RawTreeNode[] {
	return nodes.map(node => ({ id: node.entry.id, children: toRawTree(node.children) }));
}

/**
 * Drives Session Bonsai: re-derives the compact branch tree from
 * `ctx.sessionManager.getTree()` / `getLeafId()` on every `session_branch` /
 * `session_tree` event — neither event payload carries the tree itself, only
 * a signal that it (or the active leaf) changed — and mounts on the first
 * such event seen this session. Motion gating goes through the kit's
 * {@link MotionPolicy}; a resolved tier of `off` renders the bead's
 * `branch X of Y` static line instead of an animated widget, repainted
 * directly on each event since there is no frame clock in that mode.
 *
 * Spawn timestamps (for the unfurl animation) and the widget's render clock
 * both read the same injected {@link FrameScheduler}, not the
 * {@link AnimationHost}'s internal relative clock — the host only drives
 * repaint cadence here, so growth math stays correct regardless of exactly
 * when the UI layer invokes the widget factory after `setWidget()`.
 */
export class SessionBonsaiController {
	#scheduler: FrameScheduler;
	#state = new BonsaiState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): BonsaiState {
		return this.#state;
	}

	onSessionBranch(_event: SessionBranchEvent, ctx: SessionBonsaiContext): void {
		this.#handleEvent(ctx);
	}

	onSessionTree(_event: SessionTreeEvent, ctx: SessionBonsaiContext): void {
		this.#handleEvent(ctx);
	}

	/** Clear the live widget without disposing the session-owned host. Idempotent. */
	dispose(ctx: Pick<SessionBonsaiContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated" && this.#mount.owned) this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#handleEvent(ctx: SessionBonsaiContext): void {
		if (!ctx.hasUI) return;
		const roots = toRawTree(ctx.sessionManager.getTree());
		const changed = this.#state.update(roots, ctx.sessionManager.getLeafId(), this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static" && changed) {
			ctx.setWidget(WIDGET_KEY, [renderBonsaiOffText(this.#state.snapshot())], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	#mountWidget(ctx: SessionBonsaiContext): Mount {
		const shared = ctx.animation;
		if (!shared || shared.policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderBonsaiOffText(this.#state.snapshot())], WIDGET_OPTIONS);
			return { mode: "static" };
		}

		const { host, policy } = shared;
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => new SessionBonsaiWidget({ tui, host, policy, state, theme, clock }),
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host, owned: false };
	}
}
