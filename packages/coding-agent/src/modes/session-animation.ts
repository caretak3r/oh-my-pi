import { AnimationHost, backpressureFromTui, type FrameScheduler, MotionPolicy } from "@oh-my-pi/pi-animation";
import type { TUI } from "@oh-my-pi/pi-tui";
import { readMotionSetting } from "../config/motion";
import { onDisplayAnimationsChanged } from "../config/settings";

/** The one host/policy pair every animated widget in a session shares. */
export interface SessionAnimationHandle {
	readonly host: AnimationHost;
	readonly policy: MotionPolicy;
}

interface SessionAnimation extends SessionAnimationHandle {
	dispose(): void;
}

const sessions = new WeakMap<TUI, SessionAnimation>();

export function sessionAnimation(
	tui: TUI,
	scheduler?: FrameScheduler,
	environment?: { isTTY?: boolean; env?: Record<string, string | undefined> },
): SessionAnimationHandle {
	const existing = sessions.get(tui);
	if (existing) {
		existing.policy.setSetting(readMotionSetting());
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
		readMotionSetting(),
	);
	const host = new AnimationHost({ policy, backpressure, scheduler });
	const unsubscribe = onDisplayAnimationsChanged(() => {
		policy.setSetting(readMotionSetting());
	});
	const animation: SessionAnimation = {
		host,
		policy,
		dispose: () => {
			unsubscribe();
			host.dispose();
		},
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
