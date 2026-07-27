import { onDisplayAnimationsChanged } from "../../config/settings";
import type { SessionShutdownEvent, SessionStartEvent, SessionSwitchEvent } from "../shared-events";
import type { ExtensionContext, ExtensionHandler } from "./index";

/** The extension API surface used to register animated-feature teardown. */
export interface AnimatedFeatureLifecycleAPI {
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
}

interface AnimatedFeatureSessionStartAPI {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

/** The controller surface the lifecycle helper drives. */
interface AnimatedFeatureLifecycle<C> {
	/** Adapt the raw extension context to the feature's own context shape. */
	toContext(ctx: ExtensionContext): C;
	/** Tear down the live mount (idempotent; clears the feature's #mount). */
	dispose(ctx: C): void;
	/** Optional: remount immediately after a session switch. */
	remountOnSwitch?(ctx: C): void;
}

/**
 * Structural teardown for every animated feature: the UI disposes widgets on
 * session switch/shutdown, so the controller must drop its #mount at the same
 * boundaries or it will believe a dead widget is still live and never remount.
 */
export function registerAnimatedFeatureLifecycle<C>(
	api: AnimatedFeatureLifecycleAPI,
	lifecycle: AnimatedFeatureLifecycle<C>,
): void {
	let latestCtx: ExtensionContext | undefined;
	const disposeAndRemount = (ctx: ExtensionContext): void => {
		const featureCtx = lifecycle.toContext(ctx);
		lifecycle.dispose(featureCtx);
		lifecycle.remountOnSwitch?.(featureCtx);
	};
	const unsubscribe = onDisplayAnimationsChanged(() => {
		if (!latestCtx) return;
		disposeAndRemount(latestCtx);
	});

	(api as AnimatedFeatureLifecycleAPI & AnimatedFeatureSessionStartAPI).on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});
	api.on("session_switch", (_event, ctx) => {
		latestCtx = ctx;
		disposeAndRemount(ctx);
	});
	api.on("session_shutdown", (_event, ctx) => {
		lifecycle.dispose(lifecycle.toContext(ctx));
		latestCtx = undefined;
		unsubscribe();
	});
}
