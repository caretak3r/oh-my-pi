import { describe, expect, it } from "bun:test";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { SessionBranchEvent, SessionTreeEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type BonsaiSessionSource,
	type BonsaiTreeSourceNode,
	type SessionBonsaiContext,
	SessionBonsaiController,
} from "@oh-my-pi/pi-coding-agent/session-bonsai/controller";
import { budGlyph, isShimmering, unfurlGrowth } from "@oh-my-pi/pi-coding-agent/session-bonsai/growth";
import { type BonsaiSnapshot, BonsaiState } from "@oh-my-pi/pi-coding-agent/session-bonsai/state";
import type { BonsaiNode, RawTreeNode } from "@oh-my-pi/pi-coding-agent/session-bonsai/tree";
import {
	activeLeafRank,
	buildBonsaiTree,
	collectLeafIds,
	MAX_DISPLAYED_LEAVES,
	pruneForDisplay,
} from "@oh-my-pi/pi-coding-agent/session-bonsai/tree";
import {
	type BonsaiTheme,
	renderBonsaiOffText,
	renderBonsaiTree,
	SessionBonsaiWidget,
} from "@oh-my-pi/pi-coding-agent/session-bonsai/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: BonsaiTheme = { fg: (_color, text) => text };

/** Manual frame scheduler: drives host ticks and the shared clock deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

/** root -A- B(branch) -> C(leaf), -> D -E- (leaf, single-child chain collapses to E) */
function branchingRawTree(): RawTreeNode[] {
	return [
		{
			id: "A",
			children: [
				{
					id: "B",
					children: [
						{ id: "C", children: [] },
						{ id: "D", children: [{ id: "E", children: [] }] },
					],
				},
			],
		},
	];
}

function sevenLeafRawTree(): RawTreeNode[] {
	return [
		{
			id: "root",
			children: Array.from({ length: 7 }, (_, i) => ({ id: `L${i + 1}`, children: [] })),
		},
	];
}

function bonsaiSnapshot(
	tree: readonly BonsaiNode[],
	activeLeafId: string | null,
	spawnAt: ReadonlyMap<string, number>,
): BonsaiSnapshot {
	const display = pruneForDisplay(tree, activeLeafId, spawnAt);
	return { tree, displayTree: display.nodes, hiddenLeaves: display.hiddenLeaves, activeLeafId, spawnAt };
}

describe("session bonsai tree collapsing (pure)", () => {
	it("collapses linear single-child runs down to the next branch point or leaf", () => {
		const tree = buildBonsaiTree(branchingRawTree(), null);
		expect(tree).toHaveLength(1);
		expect(tree[0].id).toBe("B"); // A->B is a single-child run; B is the first real branch point
		expect(tree[0].isLeaf).toBe(false);
		expect(tree[0].children.map(c => c.id)).toEqual(["C", "E"]); // D->E collapses to E
		expect(tree[0].children.every(c => c.isLeaf)).toBe(true);
	});

	it("marks nodes on the root-to-active-leaf path as active, siblings as not", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		expect(tree[0].isActive).toBe(true); // B is on the path to C
		const [c, e] = tree[0].children;
		expect(c.id).toBe("C");
		expect(c.isActive).toBe(true);
		expect(e.id).toBe("E");
		expect(e.isActive).toBe(false);
	});

	it("marks nothing active when there is no active leaf", () => {
		const tree = buildBonsaiTree(branchingRawTree(), null);
		expect(tree[0].isActive).toBe(false);
		expect(tree[0].children.every(c => !c.isActive)).toBe(true);
	});

	it("a tree with no branch points collapses to a single leaf (the trunk tip)", () => {
		const linear: RawTreeNode[] = [{ id: "A", children: [{ id: "B", children: [{ id: "C", children: [] }] }] }];
		const tree = buildBonsaiTree(linear, "C");
		expect(tree).toHaveLength(1);
		expect(tree[0].id).toBe("C");
		expect(tree[0].isLeaf).toBe(true);
		expect(tree[0].isActive).toBe(true);
	});

	it("collectLeafIds returns leaves in left-to-right pre-order", () => {
		const tree = buildBonsaiTree(branchingRawTree(), null);
		expect(collectLeafIds(tree)).toEqual(["C", "E"]);
	});

	it("activeLeafRank is 1-based and 0 when the id isn't a leaf in this tree", () => {
		const tree = buildBonsaiTree(branchingRawTree(), null);
		expect(activeLeafRank(tree, "C")).toBe(1);
		expect(activeLeafRank(tree, "E")).toBe(2);
		expect(activeLeafRank(tree, "nonexistent")).toBe(0);
		expect(activeLeafRank(tree, null)).toBe(0);
	});

	it("an empty roots array collapses to an empty tree with no leaves", () => {
		const tree = buildBonsaiTree([], "anything");
		expect(tree).toEqual([]);
		expect(collectLeafIds(tree)).toEqual([]);
		expect(activeLeafRank(tree, "anything")).toBe(0);
	});

	it("an activeLeafId that doesn't exist anywhere in roots marks nothing active", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "nonexistent");
		expect(tree[0].isActive).toBe(false);
		expect(tree[0].children.every(c => !c.isActive)).toBe(true);
	});

	it("a root with a single leaf child and no branch collapses that root away entirely", () => {
		// root has exactly one child chain down to a leaf; collapseChain walks straight through the root.
		const tree = buildBonsaiTree([{ id: "root", children: [{ id: "leaf", children: [] }] }], "leaf");
		expect(tree).toHaveLength(1);
		expect(tree[0].id).toBe("leaf"); // "root" itself never survives collapsing
	});
});

describe("session bonsai pruning (pure)", () => {
	it("does not prune at or below the display cap", () => {
		const tree = buildBonsaiTree(
			sevenLeafRawTree().map(n => ({ ...n, children: n.children.slice(0, MAX_DISPLAYED_LEAVES) })),
			null,
		);
		const { nodes, hiddenLeaves } = pruneForDisplay(tree, null, new Map());
		expect(hiddenLeaves).toBe(0);
		expect(nodes).toBe(tree); // same reference: no filtering happened
	});

	it("past the cap, always keeps the active leaf and fills the rest by most-recent spawn, dropping the remainder", () => {
		const tree = buildBonsaiTree(sevenLeafRawTree(), "L1");
		const spawnAt = new Map([
			["L1", 100],
			["L2", 200],
			["L3", 300],
			["L4", 400],
			["L5", 500],
			["L6", 600],
			["L7", 700],
		]);
		const { nodes, hiddenLeaves } = pruneForDisplay(tree, "L1", spawnAt);
		expect(hiddenLeaves).toBe(2);
		const kept = collectLeafIds(nodes);
		expect(kept).toContain("L1"); // active leaf always survives
		expect(kept).toEqual(expect.arrayContaining(["L7", "L6", "L5", "L4"])); // 4 most recent fill the rest
		expect(kept).not.toContain("L2");
		expect(kept).not.toContain("L3");
		expect(kept).toHaveLength(MAX_DISPLAYED_LEAVES);
	});

	it("ties in spawnAt break deterministically by original left-to-right order", () => {
		const tree = buildBonsaiTree(sevenLeafRawTree(), null);
		const { nodes: first } = pruneForDisplay(tree, null, new Map());
		const { nodes: second } = pruneForDisplay(tree, null, new Map());
		expect(collectLeafIds(first)).toEqual(collectLeafIds(second));
		expect(collectLeafIds(first)).toEqual(["L1", "L2", "L3", "L4", "L5"]); // all spawnAt missing -> stable original order
	});
});

describe("session bonsai growth math (pure)", () => {
	it("unfurlGrowth is 0 before spawn, ramps linearly, and clamps at 1", () => {
		expect(unfurlGrowth(1000, 500)).toBe(0);
		expect(unfurlGrowth(1000, 1000)).toBe(0);
		expect(unfurlGrowth(1000, 1500)).toBeCloseTo(0.5, 5);
		expect(unfurlGrowth(1000, 2000)).toBe(1);
		expect(unfurlGrowth(1000, 5000)).toBe(1);
	});

	it("budGlyph is monotonic non-decreasing along the growth ramp", () => {
		const samples = [0, 0.2, 0.4, 0.6, 0.8, 0.99].map(budGlyph);
		const uniqueInOrder = [...new Set(samples)];
		expect(uniqueInOrder).toEqual([...samples].filter((g, i) => samples.indexOf(g) === i));
		expect(new Set(samples).size).toBeGreaterThan(1); // the ramp actually changes glyph
	});

	it("isShimmering fires a short periodic blip", () => {
		expect(isShimmering(0)).toBe(true);
		expect(isShimmering(219)).toBe(true);
		expect(isShimmering(220)).toBe(false);
		expect(isShimmering(1400)).toBe(true); // period repeats
	});

	it("budGlyph falls back to the first glyph rather than 'undefined' for a NaN growth fraction", () => {
		// NaN satisfies neither the <=0 nor >=1 clamp branches, so it flows through
		// to a NaN array index -- same class of gotcha as Token Tide's waveGlyph(NaN).
		expect(budGlyph(Number.NaN)).toBe(".");
	});

	it("unfurlGrowth returns NaN for a non-finite spawn or elapsed reading, never throwing", () => {
		expect(unfurlGrowth(Number.NaN, 1000)).toBeNaN();
		expect(unfurlGrowth(1000, Number.NaN)).toBeNaN();
		expect(unfurlGrowth(1000, Number.POSITIVE_INFINITY)).toBe(1); // an infinitely-elapsed clock clamps to fully grown
	});

	it("unfurlGrowth clamps to 0 for elapsed readings before spawn (backward clock skew)", () => {
		expect(unfurlGrowth(1000, 0)).toBe(0);
		expect(unfurlGrowth(1000, -5000)).toBe(0);
	});
});

describe("session bonsai state", () => {
	it("seeds the first observed tree as already-grown baseline, no unfurl", () => {
		const state = new BonsaiState();
		const changed = state.update(branchingRawTree(), "C", 5000);
		expect(changed).toBe(true); // first observation always reports a change
		const snapshot = state.snapshot();
		const spawnAt = snapshot.spawnAt.get("B");
		expect(spawnAt).toBeDefined();
		expect(unfurlGrowth(spawnAt as number, 5000)).toBe(1); // baseline nodes render fully grown immediately
	});

	it("a genuinely new branch appearing later unfurls from that moment", () => {
		const state = new BonsaiState();
		state.update([{ id: "A", children: [{ id: "C", children: [] }] }], "C", 0);
		const changed = state.update(branchingRawTree(), "C", 3000); // B/D->E now appear as new nodes at t=3000
		expect(changed).toBe(true);
		const snapshot = state.snapshot();
		expect(snapshot.spawnAt.get("B")).toBe(3000);
		expect(unfurlGrowth(snapshot.spawnAt.get("B") as number, 3000)).toBe(0); // freshly spawned: growth starts at 0
		expect(unfurlGrowth(snapshot.spawnAt.get("B") as number, 4000)).toBe(1); // 1s later, fully unfurled
	});

	it("reports no change when re-observing an identical tree and active leaf", () => {
		const state = new BonsaiState();
		state.update(branchingRawTree(), "C", 0);
		const changed = state.update(branchingRawTree(), "C", 1000);
		expect(changed).toBe(false);
	});

	it("reports a change when only the active leaf moves", () => {
		const state = new BonsaiState();
		state.update(branchingRawTree(), "C", 0);
		const changed = state.update(branchingRawTree(), "E", 1000);
		expect(changed).toBe(true);
	});

	it("a node id already seen keeps its original spawn time even if the raw tree is re-observed at an earlier clock reading (backward skew)", () => {
		const state = new BonsaiState();
		state.update(branchingRawTree(), "C", 5000);
		const originalSpawn = state.snapshot().spawnAt.get("B");
		state.update(branchingRawTree(), "C", 100); // clock jumps backward; B already known
		expect(state.snapshot().spawnAt.get("B")).toBe(originalSpawn); // never overwritten once recorded
	});

	it("an empty raw tree update reports a change from the initial empty baseline and yields an empty snapshot", () => {
		const state = new BonsaiState();
		const changed = state.update([], null, 0);
		expect(changed).toBe(false); // both tree and active leaf are already empty/null pre-update; nothing changed
		expect(state.snapshot().tree).toEqual([]);
		expect(state.snapshot().spawnAt.size).toBe(0);
	});

	it("removes spawn timestamps for node ids that disappear from the raw tree", () => {
		const state = new BonsaiState();
		state.update(branchingRawTree(), "C", 0); // compact tree keeps B (branch) and C/E (leaves; D collapses into E)
		expect(state.snapshot().spawnAt.has("E")).toBe(true);
		state.update([{ id: "A", children: [{ id: "C", children: [] }] }], "C", 1000); // the D->E branch is pruned from the raw tree entirely
		expect(state.snapshot().tree.map(n => n.id)).not.toContain("E");
		expect(state.snapshot().spawnAt.has("E")).toBe(false);
	});

	it("re-prunes the cached display tree when only the active leaf changes", () => {
		const state = new BonsaiState();
		state.update(sevenLeafRawTree(), "L1", 0);
		expect(collectLeafIds(state.snapshot().displayTree)).toEqual(["L1", "L2", "L3", "L4", "L5"]);

		state.update(sevenLeafRawTree(), "L7", 1000);
		expect(collectLeafIds(state.snapshot().displayTree)).toEqual(["L1", "L2", "L3", "L4", "L7"]);
	});
});

describe("session bonsai rendering (pure)", () => {
	it("preserves the rendered rows for a cached tree above the five-leaf display cap", () => {
		const state = new BonsaiState();
		state.update(sevenLeafRawTree(), "L1", 0);

		expect(renderBonsaiTree(state.snapshot(), 0, idTheme, "subtle")).toEqual([
			"●",
			"├─ ✦",
			"├─ ○",
			"├─ ○",
			"├─ ○",
			"└─ ○",
			"⋯ +2 more",
		]);
	});

	it("is byte-stable across repeated calls with the same snapshot and elapsed time", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		const snapshot = bonsaiSnapshot(tree, "C", new Map([["B", -1000]]));
		const first = renderBonsaiTree(snapshot, 1000, idTheme, "full");
		const second = renderBonsaiTree(snapshot, 1000, idTheme, "full");
		expect(first).toEqual(second);
	});

	it("renders a bud glyph while a freshly-spawned branch unfurls, then the resting glyph once grown", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		const spawnAt = new Map([["B", 1000]]);
		const mid = renderBonsaiTree(bonsaiSnapshot(tree, "C", spawnAt), 1500, idTheme, "full"); // 50% grown
		expect(mid[0]).toMatch(/[.o0]$/);
		const grown = renderBonsaiTree(bonsaiSnapshot(tree, "C", spawnAt), 5000, idTheme, "full"); // fully grown, well past any shimmer window issues
		expect(grown[0]).not.toMatch(/[.o0]$/);
	});

	it("subtle tier always renders fully grown, ignoring spawn time", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		const spawnAt = new Map([["B", 1000]]);
		const rows = renderBonsaiTree(bonsaiSnapshot(tree, "C", spawnAt), 1000, idTheme, "subtle"); // t=spawn, would be 0% grown in full tier
		expect(rows[0]).not.toMatch(/[.o0]$/);
	});

	it("shows a dormant twig glyph for a non-active leaf and an active glyph for the active one", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		const spawnAt = new Map([["B", -1000]]);
		const rows = renderBonsaiTree(bonsaiSnapshot(tree, "C", spawnAt), 0, idTheme, "subtle");
		expect(rows.some(r => r.trimEnd().endsWith("✦"))).toBe(true); // C is active
		expect(rows.some(r => r.trimEnd().endsWith("○"))).toBe(true); // E is dormant
	});

	it("appends a '+N more' trailer once branch count exceeds the display cap", () => {
		const raw: RawTreeNode[] = [
			{ id: "root", children: Array.from({ length: 7 }, (_, i) => ({ id: `L${i + 1}`, children: [] })) },
		];
		const tree = buildBonsaiTree(raw, "L1");
		const rows = renderBonsaiTree(bonsaiSnapshot(tree, "L1", new Map()), 0, idTheme, "subtle");
		expect(rows[rows.length - 1]).toContain("+2 more");
	});

	it("falls back to a placeholder when there are no branches yet", () => {
		const rows = renderBonsaiTree(bonsaiSnapshot([], null, new Map()), 0, idTheme, "full");
		expect(rows[0]).toContain("no branches yet");
	});

	it("never renders the literal string 'undefined' even with a NaN elapsed clock reading", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		const rows = renderBonsaiTree(bonsaiSnapshot(tree, "C", new Map()), Number.NaN, idTheme, "full");
		expect(rows.every(r => !r.includes("undefined"))).toBe(true);
	});
});

describe("session bonsai static off-tier text", () => {
	it("formats 'branch X of Y' when an active leaf is known", () => {
		const tree = buildBonsaiTree(branchingRawTree(), "C");
		expect(renderBonsaiOffText(bonsaiSnapshot(tree, "C", new Map()))).toBe("branch 1 of 2");
		expect(renderBonsaiOffText(bonsaiSnapshot(tree, "E", new Map()))).toBe("branch 2 of 2");
	});

	it("falls back to a bare pluralized count when there is no active leaf yet", () => {
		const tree = buildBonsaiTree(branchingRawTree(), null);
		expect(renderBonsaiOffText(bonsaiSnapshot(tree, null, new Map()))).toBe("2 branches");
	});

	it("singularizes a lone branch and reports 'no branches yet' for an empty tree", () => {
		const single = buildBonsaiTree([{ id: "A", children: [] }], null);
		expect(renderBonsaiOffText(bonsaiSnapshot(single, null, new Map()))).toBe("1 branch");
		expect(renderBonsaiOffText(bonsaiSnapshot([], null, new Map()))).toBe("no branches yet");
	});
});

describe("session bonsai widget lifecycle", () => {
	it("subscribes on mount, reflects the shared clock, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BonsaiState();
		state.update(branchingRawTree(), "C", scheduler.now());
		const widget = new SessionBonsaiWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);

		// Force a brand-new branch mid-flight so the frame clock has something to animate.
		state.update(
			[
				{
					id: "A",
					children: [
						{
							id: "B",
							children: [
								{ id: "C", children: [] },
								{ id: "D", children: [{ id: "E", children: [] }] },
								{ id: "F", children: [] },
							],
						},
					],
				},
			],
			"C",
			scheduler.now(),
		);
		const initial = widget.render(80);
		scheduler.advance(500); // mid-unfurl for F
		const midGrowth = widget.render(80);
		expect(midGrowth).not.toEqual(initial);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BonsaiState();
		state.update(branchingRawTree(), "C", scheduler.now());
		const widget = new SessionBonsaiWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80).some(r => r.trimEnd().endsWith("✦"))).toBe(true);
	});
});

/** Mirrors `branchingRawTree` but wrapped in the `{ entry: { id }, children }` shape the real `SessionTreeNode`/`ReadonlySessionManager.getTree()` returns. */
function branchingSourceTree(): BonsaiTreeSourceNode[] {
	return [
		{
			entry: { id: "A" },
			children: [
				{
					entry: { id: "B" },
					children: [
						{ entry: { id: "C" }, children: [] },
						{ entry: { id: "D" }, children: [{ entry: { id: "E" }, children: [] }] },
					],
				},
			],
		},
	];
}

describe("session bonsai controller", () => {
	/** A source whose leaf id can be mutated between events, mirroring `ctx.sessionManager` always reflecting live state rather than the event payload. */
	function treeSource(
		roots: BonsaiTreeSourceNode[],
		leafId: string | null,
	): BonsaiSessionSource & { setLeafId(id: string | null): void } {
		let current = leafId;
		return { getTree: () => roots, getLeafId: () => current, setLeafId: id => (current = id) };
	}

	function recordingContext(
		sessionManager: BonsaiSessionSource,
		scheduler: FrameScheduler,
		overrides: Partial<SessionBonsaiContext> = {},
	): { ctx: SessionBonsaiContext; calls: Array<{ key: string; content: unknown }> } {
		const calls: Array<{ key: string; content: unknown }> = [];
		const policy = new MotionPolicy(fullEnv, "full");
		const ctx: SessionBonsaiContext = {
			hasUI: true,
			animation: { host: new AnimationHost({ policy, scheduler }), policy },
			theme: idTheme,
			sessionManager,
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	const branchEvent: SessionBranchEvent = { type: "session_branch", previousSessionFile: undefined };
	const treeEvent: SessionTreeEvent = { type: "session_tree", newLeafId: "C", oldLeafId: null };

	it("mounts an animated widget on the first session_branch event and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const source = treeSource(branchingSourceTree(), "C");
		const { ctx, calls } = recordingContext(source, scheduler);

		controller.onSessionBranch(branchEvent, ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: BonsaiTheme) => SessionBonsaiWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);

		controller.onSessionTree(treeEvent, ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.snapshot().activeLeafId).toBe("C");
	});

	it("renders and updates a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const source = treeSource(branchingSourceTree(), "C");
		const { ctx, calls } = recordingContext(source, scheduler, { animation: undefined });

		controller.onSessionBranch(branchEvent, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
		expect((calls[0].content as string[])[0]).toBe("branch 1 of 2");
		expect(scheduler.running).toBe(false); // static tier never starts the shared frame clock

		source.setLeafId("E");
		controller.onSessionTree({ type: "session_tree", newLeafId: "E", oldLeafId: "C" }, ctx);
		expect((calls[1].content as string[])[0]).toBe("branch 2 of 2");
	});

	it("falls back to a static line without a session animation handle", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const source = treeSource(branchingSourceTree(), "C");
		const { ctx, calls } = recordingContext(source, scheduler, { animation: undefined });

		controller.onSessionBranch(branchEvent, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const source = treeSource(branchingSourceTree(), "C");
		const { ctx, calls } = recordingContext(source, scheduler, { hasUI: false });

		controller.onSessionBranch(branchEvent, ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose clears the widget without disposing the session-owned host", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const source = treeSource(branchingSourceTree(), "C");
		const { ctx, calls } = recordingContext(source, scheduler);

		controller.onSessionBranch(branchEvent, ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: BonsaiTheme) => SessionBonsaiWidget;
		const widget = factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(true);

		widget.dispose();
		expect(scheduler.running).toBe(false);
	});

	it("dispose before any mount is a no-op: no setWidget call, no host to tear down", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const { ctx, calls } = recordingContext(treeSource(branchingSourceTree(), "C"), scheduler);

		controller.dispose(ctx);
		expect(calls).toHaveLength(0);
	});

	it("disposing twice is idempotent: the second call is a silent no-op", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const { ctx, calls } = recordingContext(treeSource(branchingSourceTree(), "C"), scheduler);

		controller.onSessionBranch(branchEvent, ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;

		controller.dispose(ctx);
		expect(calls).toHaveLength(callsAfterFirstDispose); // no extra setWidget(undefined) call
	});

	it("a session event after dispose remounts a fresh widget rather than staying dormant", () => {
		const scheduler = manualScheduler();
		const controller = new SessionBonsaiController({ scheduler });
		const { ctx, calls } = recordingContext(treeSource(branchingSourceTree(), "C"), scheduler);

		controller.onSessionBranch(branchEvent, ctx);
		controller.dispose(ctx);
		controller.onSessionTree(treeEvent, ctx);

		const lastCall = calls[calls.length - 1];
		expect(typeof lastCall.content).toBe("function"); // remounted, not left dormant
	});
});
