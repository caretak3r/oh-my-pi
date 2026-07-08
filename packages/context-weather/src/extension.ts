/**
 * Context Weather — ambient animated barometer of context-window pressure.
 *
 * Mounts a {@link ContextWeatherWidget} above/below the editor, refreshes it on
 * `ContextEvent` (the real change boundary, not a per-frame poll), and raises a
 * one-shot storm notification before auto-compaction — coordinated with the core
 * auto-compaction loader so the two signals never double up.
 *
 * Settings resolve from the plugin's manifest-declared settings via the runtime
 * plugin settings store (`getPluginSettings`), with env-var fallbacks:
 * stored setting > env var > default. Both mount and the live `context` refresh
 * re-read the store, so `omp plugin` settings changes apply without a restart.
 *
 * See README.md for the dev-load recipe and the manual acceptance walkthrough.
 */
import {
	AnimationHost,
	backpressureFromTui,
	type FrameScheduler,
	type MotionEnvironment,
	MotionPolicy,
} from "@oh-my-pi/pi-animation";
import type { ContextUsage, ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { WeatherForecast } from "./model";
import type { BarometerCaps } from "./renderer";
import { type ContextWeatherSettings, resolveContextWeatherSettingsFromSources } from "./settings";
import { ContextWeatherWidget } from "./widget";

const WIDGET_KEY = "context-weather";
/** npm package name, the key the runtime plugin settings store files settings under. */
const PLUGIN_NAME = "@oh-my-pi/context-weather";

interface MountedWidget {
	widget: ContextWeatherWidget;
	host: AnimationHost;
	policy: MotionPolicy;
	tui: TUI;
	style: ContextWeatherSettings["style"];
	placement: ContextWeatherSettings["placement"];
	stormAtPercent: number;
}

/** Injectable seams for behavioral tests; production callers use the defaults. */
export interface ContextWeatherExtensionOptions {
	/** Reads the plugin's stored settings record. Defaults to the runtime plugin settings store. */
	readPluginSettings?: (cwd: string) => Promise<Record<string, unknown>>;
	/** Env source for the manifest env-var fallbacks. Defaults to `Bun.env`. */
	env?: Record<string, string | undefined>;
	/** Motion environment factory. Defaults to the real TTY + render-backpressure probe. */
	motionEnvironment?: (tui: TUI) => MotionEnvironment;
	/** Frame clock scheduler seam. Defaults to real timers. */
	scheduler?: FrameScheduler;
}

function forecastFromUsage(usage: ContextUsage | undefined): WeatherForecast | undefined {
	if (!usage || usage.tokensUntilCompaction === undefined) return undefined;
	return {
		tokensUntilCompaction: usage.tokensUntilCompaction,
		compactionThresholdTokens: usage.compactionThresholdTokens,
	};
}

function capsFrom(tui: TUI, theme: Theme): BarometerCaps {
	return {
		trueColor: theme.getColorMode() === "truecolor",
		synchronizedOutput: tui.synchronizedOutput,
	};
}

export function createContextWeatherExtension(
	options: ContextWeatherExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	const readPluginSettings = options.readPluginSettings ?? ((cwd: string) => getPluginSettings(PLUGIN_NAME, cwd));
	const motionEnvironment =
		options.motionEnvironment ??
		((tui: TUI): MotionEnvironment => ({
			hasUI: true,
			isTTY: Boolean(process.stdout.isTTY),
			backpressure: backpressureFromTui(tui),
		}));

	return function contextWeatherExtension(pi: ExtensionAPI): void {
		pi.setLabel("Context Weather");

		let mounted: MountedWidget | undefined;
		let compacting = false;
		let notified = false;

		const loadSettings = async (ctx: ExtensionContext): Promise<ContextWeatherSettings> => {
			let stored: Record<string, unknown> = {};
			try {
				stored = await readPluginSettings(ctx.cwd);
			} catch (err) {
				pi.logger.warn("Context weather: failed to read plugin settings, using env/defaults", {
					error: String(err),
				});
			}
			return resolveContextWeatherSettingsFromSources(stored, options.env);
		};

		const mount = async (ctx: ExtensionContext, preloaded?: ContextWeatherSettings): Promise<void> => {
			if (!ctx.hasUI || mounted) return;
			const settings = preloaded ?? (await loadSettings(ctx));
			if (mounted) return;
			const usage = ctx.getContextUsage();
			const forecast = forecastFromUsage(usage);

			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui: TUI, theme: Theme) => {
					const backpressure = backpressureFromTui(tui);
					const policy = new MotionPolicy(motionEnvironment(tui), settings.animations);
					const host = new AnimationHost({ policy, backpressure, scheduler: options.scheduler });
					const widget = new ContextWeatherWidget({
						tui,
						host,
						policy,
						theme,
						style: settings.style,
						caps: capsFrom(tui, theme),
						stormAtPercent: settings.stormAtPercent,
						initialUsage: usage,
						initialForecast: forecast,
					});
					mounted = {
						widget,
						host,
						policy,
						tui,
						style: settings.style,
						placement: settings.placement,
						stormAtPercent: settings.stormAtPercent,
					};
					return widget;
				},
				{ placement: settings.placement },
			);
		};

		const unmount = (ctx: ExtensionContext): void => {
			if (mounted) {
				mounted.widget.dispose();
				mounted.host.dispose();
				mounted = undefined;
			}
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		};

		const refresh = async (ctx: ExtensionContext): Promise<void> => {
			const current = mounted;
			if (!current) return;

			const settings = await loadSettings(ctx);
			if (mounted !== current) return;

			// Live re-resolve the motion tier (subtle/full/off) without a remount.
			current.policy.setSetting(settings.animations);

			// Style/placement/threshold bake in at construction, remount if they changed.
			if (
				settings.style !== current.style ||
				settings.placement !== current.placement ||
				settings.stormAtPercent !== current.stormAtPercent
			) {
				unmount(ctx);
				await mount(ctx, settings);
				return;
			}

			const usage = ctx.getContextUsage();
			const forecast = forecastFromUsage(usage);
			const wasImminent = current.widget.imminent;
			if (current.widget.setUsage(usage, forecast)) {
				current.tui.requestComponentRender(current.widget);
			}

			const nowImminent = current.widget.imminent;
			if (nowImminent && !wasImminent) {
				// One-shot per crossing, gated by setting, never while the core
				// auto-compaction loader is already signalling.
				if (settings.notifyOnImminent && !compacting && !notified) {
					notified = true;
					ctx.ui.notify("Context weather: storm building — auto-compaction is near.", "warning");
				}
			} else if (!nowImminent) {
				notified = false;
			}
		};

		pi.on("session_start", async (_event, ctx) => {
			await mount(ctx);
		});

		pi.on("context", async (_event, ctx) => {
			await refresh(ctx);
		});

		pi.on("auto_compaction_start", () => {
			compacting = true;
		});

		pi.on("auto_compaction_end", () => {
			compacting = false;
		});

		pi.on("session_switch", async (_event, ctx) => {
			unmount(ctx);
			notified = false;
			await mount(ctx);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			unmount(ctx);
		});
	};
}

export default createContextWeatherExtension();
