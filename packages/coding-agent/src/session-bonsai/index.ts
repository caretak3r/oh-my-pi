import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAnimatedFeatureLifecycle } from "../extensibility/extensions/animated-feature";
import { type SessionBonsaiContext, SessionBonsaiController } from "./controller";

export * from "./controller";
export * from "./growth";
export * from "./state";
export * from "./tree";
export * from "./widget";

function toBonsaiContext(ctx: ExtensionContext): SessionBonsaiContext {
	return {
		hasUI: ctx.hasUI,
		animation: ctx.ui.animation?.(),
		theme: ctx.ui.theme,
		sessionManager: ctx.sessionManager,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Session Bonsai: the session's branch history as a small living bonsai.
 * Branching sprouts a new limb that unfurls over ~1s; the active path glows
 * and its tip shimmers; abandoned branches fade to dim bare twigs. Built on
 * the shared `@oh-my-pi/pi-animation` kit: one `AnimationHost` for the whole
 * session, mounted on the first `session_branch`/`session_tree` event and
 * disposed only if the extension itself is torn down.
 */
export const createSessionBonsaiExtension: ExtensionFactory = api => {
	const controller = new SessionBonsaiController();
	api.on("session_branch", (event, ctx) => {
		controller.onSessionBranch(event, toBonsaiContext(ctx));
	});
	api.on("session_tree", (event, ctx) => {
		controller.onSessionTree(event, toBonsaiContext(ctx));
	});
	registerAnimatedFeatureLifecycle(api, {
		toContext: toBonsaiContext,
		dispose: ctx => controller.dispose(ctx),
	});
};
