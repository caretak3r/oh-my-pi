import type { MotionSetting } from "@oh-my-pi/pi-animation";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { type TodoMeteorsContext, TodoMeteorsController } from "./controller";

export * from "./controller";
export * from "./ember";
export * from "./state";
export * from "./widget";

function readMotionSetting(): MotionSetting {
	const value = settings.get("display.animations");
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toTodoMeteorsContext(ctx: ExtensionContext): TodoMeteorsContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Todo Meteors: open todos as a glowing ember horizon in a thin `aboveEditor`
 * strip; completing one fires it off-screen as a shooting star. Built on the
 * shared `@oh-my-pi/pi-animation` kit: one `AnimationHost` for the whole
 * session, mounted on the first `todo` tool `tool_result` (or reminder) seen
 * this session and disposed only if the extension itself is torn down.
 * Completions come from the `todo` tool's own `completedTasks` diff on
 * `tool_result`; `todo_reminder`'s `attempt`/`maxAttempts` drives the urgency
 * pulse layered on top of each ember.
 */
export const createTodoMeteorsExtension: ExtensionFactory = api => {
	const controller = new TodoMeteorsController();
	api.on("tool_result", (event, ctx) => {
		controller.onToolResult(event, toTodoMeteorsContext(ctx));
	});
	api.on("todo_reminder", (event, ctx) => {
		controller.onTodoReminder(event, toTodoMeteorsContext(ctx));
	});
};
