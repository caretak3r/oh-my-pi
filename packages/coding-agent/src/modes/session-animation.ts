import {
	AnimationHost,
	backpressureFromTui,
	type FrameScheduler,
	MotionPolicy,
	type MotionSetting,
} from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import { isSettingsInitialized, settings } from "../config/settings";

/** The one host/policy pair every animated widget in a session shares. */
export interface SessionAnimationHandle {
	readonly host: AnimationHost;
	readonly policy: MotionPolicy;
}

interface SessionAnimation extends SessionAnimationHandle {
	dispose(): void;
}

const sessions = new WeakMap<TUI, SessionAnimation>();

function readDisplayAnimations(): MotionSetting {
	if (!isSettingsInitialized()) return "full";
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

export function sessionAnimation(
	tui: TUI,
	scheduler?: FrameScheduler,
	environment?: { isTTY?: boolean; env?: Record<string, string | undefined> },
): SessionAnimationHandle {
	const existing = sessions.get(tui);
	if (existing) {
		existing.policy.setSetting(readDisplayAnimations());
		existing.policy.refresh();
		return existing;
	}

	const backpressure = backpressureFromTui(tui);
	const policy = new MotionPolicy(
		{
			hasUI: true,
			isTTY: environment?.isTTY ?? process.stdout.isTTY === true,
			env: environment?.env,
			backpressure,
		},
		readDisplayAnimations(),
	);
	const host = new AnimationHost({ policy, backpressure, scheduler });
	const animation: SessionAnimation = {
		host,
		policy,
		dispose: () => host.dispose(),
	};
	sessions.set(tui, animation);
	return animation;
}

export function disposeSessionAnimation(tui: TUI): void {
	const animation = sessions.get(tui);
	if (!animation) return;
	animation.dispose();
	sessions.delete(tui);
}
