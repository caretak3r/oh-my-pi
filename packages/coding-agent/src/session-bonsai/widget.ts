import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import { AnimatedWidget } from "@oh-my-pi/pi-animation";
import type { Theme } from "../modes/theme/theme";
import { budGlyph, isShimmering, unfurlGrowth } from "./growth";
import type { BonsaiSnapshot, BonsaiState } from "./state";
import { activeLeafRank, type BonsaiNode, collectLeafIds } from "./tree";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type BonsaiTheme = Pick<Theme, "fg">;

const ACTIVE_LEAF_GLYPH = "✦";
const DORMANT_LEAF_GLYPH = "○";
const BRANCH_GLYPH = "●";
const SHIMMER_GLYPH = "❋";

interface FlatRow {
	readonly node: BonsaiNode;
	readonly prefix: string;
}

/** Flatten the compact tree into ordered rows with tree-drawing connectors (`├─`/`└─`/`│`). Pure, deterministic pre-order. */
function flatten(nodes: readonly BonsaiNode[]): readonly FlatRow[] {
	const rows: FlatRow[] = [];
	function visit(node: BonsaiNode, linePrefix: string, childPrefix: string): void {
		rows.push({ node, prefix: linePrefix });
		node.children.forEach((child, index) => {
			const isLast = index === node.children.length - 1;
			visit(child, `${childPrefix}${isLast ? "└─ " : "├─ "}`, `${childPrefix}${isLast ? "   " : "│  "}`);
		});
	}
	for (const root of nodes) visit(root, "", "");
	return rows;
}

/** Pure per-row glyph choice: unfurling bud, shimmering active tip, resting active tip, dormant twig, or interior branch point. */
function nodeGlyph(node: BonsaiNode, growth: number, elapsedMs: number, tier: "full" | "subtle"): string {
	if (tier === "full" && growth < 1) return budGlyph(growth);
	if (!node.isLeaf) return BRANCH_GLYPH;
	if (!node.isActive) return DORMANT_LEAF_GLYPH;
	if (tier === "full" && isShimmering(elapsedMs)) return SHIMMER_GLYPH;
	return ACTIVE_LEAF_GLYPH;
}

/**
 * Pure renderer: the compact bonsai tree for one frame. `full` tier animates
 * newly-spawned limbs through the bud ramp until `unfurlGrowth` reaches 1 and
 * shimmers the active leaf's tip; `subtle` renders every node already fully
 * grown, active path highlighted, no unfurl or shimmer. Both tiers prune past
 * {@link MAX_DISPLAYED_LEAVES} branches, appending a trailing "+N more" note.
 * Deterministic given `snapshot` and `elapsedMs` — no wall-clock reads.
 */
export function renderBonsaiTree(
	snapshot: BonsaiSnapshot,
	elapsedMs: number,
	theme: BonsaiTheme,
	tier: "full" | "subtle",
): readonly string[] {
	const rows = flatten(snapshot.displayTree);
	if (rows.length === 0) return [theme.fg("dim", "(no branches yet)")];

	const lines = rows.map(row => {
		const spawnAt = snapshot.spawnAt.get(row.node.id) ?? elapsedMs;
		const growth = tier === "full" ? unfurlGrowth(spawnAt, elapsedMs) : 1;
		const glyph = nodeGlyph(row.node, growth, elapsedMs, tier);
		return theme.fg(row.node.isActive ? "accent" : "dim", `${row.prefix}${glyph}`);
	});
	if (snapshot.hiddenLeaves > 0) {
		lines.push(theme.fg("dim", `⋯ +${snapshot.hiddenLeaves} more`));
	}
	return lines;
}

/** Static one-line fallback for the motion-`off` tier: `branch X of Y`, or a bare count before an active leaf is known. */
export function renderBonsaiOffText(snapshot: BonsaiSnapshot): string {
	const total = collectLeafIds(snapshot.tree).length;
	if (total === 0) return "no branches yet";
	const rank = activeLeafRank(snapshot.tree, snapshot.activeLeafId);
	return rank > 0 ? `branch ${rank} of ${total}` : `${total} branch${total === 1 ? "" : "es"}`;
}

/** Minimal clock seam the widget needs — shared with the controller so spawn timestamps and render reads agree. */
export type BonsaiClock = Pick<FrameScheduler, "now">;

export interface SessionBonsaiWidgetOptions extends AnimatedWidgetOptions {
	state: BonsaiState;
	theme: BonsaiTheme;
	/** Same clock the controller stamps spawn times with — NOT the host's internal relative elapsed-ms. */
	clock: BonsaiClock;
}

/**
 * Ambient widget for the session-branch bonsai. A thin renderer over the
 * shared {@link BonsaiState}: each frame it takes a snapshot and draws the
 * tree at the current clock reading and live {@link MotionPolicy} tier.
 * Deliberately reads {@link BonsaiClock} rather than `this.elapsedMs` — the
 * host's frame ticks only drive repaint cadence here, not the unfurl/shimmer
 * phase, so mounting later than the controller's first branch event doesn't
 * skew growth math. The {@link AnimatedWidget} base owns the
 * subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class SessionBonsaiWidget extends AnimatedWidget {
	#state: BonsaiState;
	#theme: BonsaiTheme;
	#policy: MotionPolicy;
	#clock: BonsaiClock;

	constructor(options: SessionBonsaiWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return renderBonsaiTree(this.#state.snapshot(), this.#clock.now(), this.#theme, tier);
	}
}
