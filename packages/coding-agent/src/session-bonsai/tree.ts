/**
 * Minimal tree shape the pure collapsing/pruning functions operate on —
 * deliberately decoupled from the real `SessionTreeNode` (entry-level, one
 * node per message) so this module stays independently testable with plain
 * literal objects.
 */
export interface RawTreeNode {
	readonly id: string;
	readonly children: readonly RawTreeNode[];
}

/** A node in the compact "branch tree": only real branch points and leaves survive collapsing linear (single-child) runs. */
export interface BonsaiNode {
	readonly id: string;
	readonly children: readonly BonsaiNode[];
	readonly isLeaf: boolean;
	readonly isActive: boolean;
}

/** Collapse a single-child chain down to its next branch point or leaf. Pure. */
function collapseChain(node: RawTreeNode, activeIds: ReadonlySet<string>): BonsaiNode {
	let current = node;
	while (current.children.length === 1) {
		current = current.children[0];
	}
	return {
		id: current.id,
		children: current.children.map(child => collapseChain(child, activeIds)),
		isLeaf: current.children.length === 0,
		isActive: activeIds.has(current.id),
	};
}

/** Collect the set of raw ids on the root-to-`targetId` path (inclusive), or an empty set if `targetId` is null/not found. Pure. */
function activePathIds(roots: readonly RawTreeNode[], targetId: string | null): ReadonlySet<string> {
	if (targetId === null) return new Set();
	const path: string[] = [];
	function visit(node: RawTreeNode): boolean {
		path.push(node.id);
		if (node.id === targetId) return true;
		for (const child of node.children) {
			if (visit(child)) return true;
		}
		path.pop();
		return false;
	}
	for (const root of roots) {
		if (visit(root)) return new Set(path);
	}
	return new Set();
}

/**
 * Build the compact branch tree from the raw entry tree: collapses every
 * linear run of single-child entries into an edge, so surviving nodes are
 * exactly the session's real branch points and leaves. Pure given `roots`
 * and `activeLeafId` — no clock reads, no mutation.
 */
export function buildBonsaiTree(roots: readonly RawTreeNode[], activeLeafId: string | null): readonly BonsaiNode[] {
	const activeIds = activePathIds(roots, activeLeafId);
	return roots.map(root => collapseChain(root, activeIds));
}

/** Pre-order list of leaf ids across `nodes`, left to right. Pure. */
export function collectLeafIds(nodes: readonly BonsaiNode[]): readonly string[] {
	const ids: string[] = [];
	function visit(node: BonsaiNode): void {
		if (node.isLeaf) {
			ids.push(node.id);
			return;
		}
		for (const child of node.children) visit(child);
	}
	for (const node of nodes) visit(node);
	return ids;
}

/** 1-based rank of `activeLeafId` among {@link collectLeafIds}'s order, or `0` if it isn't a leaf in this tree (e.g. no active leaf yet). Pure. */
export function activeLeafRank(nodes: readonly BonsaiNode[], activeLeafId: string | null): number {
	if (activeLeafId === null) return 0;
	const index = collectLeafIds(nodes).indexOf(activeLeafId);
	return index === -1 ? 0 : index + 1;
}

/** Branch (leaf) count past which display pruning kicks in — matches the bead's "graceful past ~5 branches" acceptance. */
export const MAX_DISPLAYED_LEAVES = 5;

/** Keep only nodes whose subtree contains a kept leaf id. `undefined` when the node has no kept descendants. Pure. */
function filterToLeaves(node: BonsaiNode, keep: ReadonlySet<string>): BonsaiNode | undefined {
	const children = node.children
		.map(child => filterToLeaves(child, keep))
		.filter((child): child is BonsaiNode => child !== undefined);
	if (node.isLeaf) {
		return keep.has(node.id) ? { ...node, children } : undefined;
	}
	return children.length > 0 ? { ...node, children } : undefined;
}

/**
 * Prune the compact tree for display once its leaf count exceeds
 * {@link MAX_DISPLAYED_LEAVES}: always keeps the active leaf, then fills the
 * remaining budget with the most-recently-spawned other leaves (per
 * `spawnAt`), preserving every kept leaf's ancestors so the tree shape stays
 * legible. Pure given a fixed `spawnAt` snapshot; ties fall back to the
 * original left-to-right leaf order so pruning stays deterministic.
 */
export function pruneForDisplay(
	nodes: readonly BonsaiNode[],
	activeLeafId: string | null,
	spawnAt: ReadonlyMap<string, number>,
): { nodes: readonly BonsaiNode[]; hiddenLeaves: number } {
	const allLeafIds = collectLeafIds(nodes);
	if (allLeafIds.length <= MAX_DISPLAYED_LEAVES) return { nodes, hiddenLeaves: 0 };

	const keep = new Set<string>();
	if (activeLeafId !== null && allLeafIds.includes(activeLeafId)) keep.add(activeLeafId);
	const bySpawnDesc = allLeafIds
		.map((id, index) => ({ id, index, spawn: spawnAt.get(id) ?? Number.NEGATIVE_INFINITY }))
		.sort((a, b) => b.spawn - a.spawn || a.index - b.index);
	for (const { id } of bySpawnDesc) {
		if (keep.size >= MAX_DISPLAYED_LEAVES) break;
		keep.add(id);
	}
	const pruned = nodes
		.map(node => filterToLeaves(node, keep))
		.filter((node): node is BonsaiNode => node !== undefined);
	return { nodes: pruned, hiddenLeaves: allLeafIds.length - keep.size };
}
