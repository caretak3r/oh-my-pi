import { UNFURL_DURATION_MS } from "./growth";
import { type BonsaiNode, buildBonsaiTree, type RawTreeNode } from "./tree";

/** Immutable snapshot handed to the pure renderer each frame. */
export interface BonsaiSnapshot {
	readonly tree: readonly BonsaiNode[];
	readonly activeLeafId: string | null;
	readonly spawnAt: ReadonlyMap<string, number>;
}

/**
 * Mutable, session-scoped model of the compact branch tree. `update`
 * re-derives the tree from a fresh raw snapshot — taken on every
 * `session_branch`/`session_tree` event, since neither event payload carries
 * the tree itself — and records a spawn timestamp the first time any node id
 * is observed, so a newly-created limb unfurls from the moment it appears
 * rather than from session start.
 *
 * The very first `update` call establishes a baseline instead of an unfurl:
 * every node observed then is stamped `UNFURL_DURATION_MS` in the past (i.e.
 * already fully grown), so resuming a session that already has branches
 * doesn't replay their growth on mount.
 */
export class BonsaiState {
	#spawnAt = new Map<string, number>();
	#tree: readonly BonsaiNode[] = [];
	#activeLeafId: string | null = null;
	#seeded = false;

	/** Re-derive the tree from a fresh raw snapshot at `elapsedMs` (the shared clock). Returns whether the visible tree or active leaf changed. */
	update(roots: readonly RawTreeNode[], activeLeafId: string | null, elapsedMs: number): boolean {
		const nextTree = buildBonsaiTree(roots, activeLeafId);
		const isBaseline = !this.#seeded;
		this.#seeded = true;

		let changed = activeLeafId !== this.#activeLeafId;
		const visit = (nodes: readonly BonsaiNode[]): void => {
			for (const node of nodes) {
				if (!this.#spawnAt.has(node.id)) {
					this.#spawnAt.set(node.id, isBaseline ? elapsedMs - UNFURL_DURATION_MS : elapsedMs);
					changed = true;
				}
				visit(node.children);
			}
		};
		visit(nextTree);

		this.#tree = nextTree;
		this.#activeLeafId = activeLeafId;
		return changed;
	}

	/** Immutable view for the pure renderer. */
	snapshot(): BonsaiSnapshot {
		return { tree: this.#tree, activeLeafId: this.#activeLeafId, spawnAt: this.#spawnAt };
	}
}
