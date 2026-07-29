import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("plugin mapped settings", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let lockfile: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-mapped-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		lockfile = path.join(pluginsDir, "omp-plugins.lock.json");

		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
		spyOn(piUtils.logger, "warn").mockImplementation(() => undefined);

		await Settings.init({ agentDir: path.join(tmpRoot, "agent"), inMemory: true });
	});

	afterEach(async () => {
		mock.restore();
		resetSettingsForTest();
		await removeWithRetries(tmpRoot);
	});

	async function writeInstalledPlugin(pluginSettings: Record<string, unknown>): Promise<void> {
		await fs.mkdir(path.join(pluginsDir, "node_modules", "test-plugin"), { recursive: true });
		await Promise.all([
			Bun.write(path.join(pluginsDir, "package.json"), JSON.stringify({ dependencies: { "test-plugin": "1.0.0" } })),
			Bun.write(
				path.join(pluginsDir, "node_modules", "test-plugin", "package.json"),
				JSON.stringify({
					name: "test-plugin",
					version: "1.0.0",
					omp: { version: "1.0.0", settings: pluginSettings },
				}),
			),
			Bun.write(
				lockfile,
				JSON.stringify({
					plugins: {
						"test-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true },
					},
					settings: {},
				}),
			),
		]);
	}

	test("valid mapped enum write routes to core", async () => {
		await writeInstalledPlugin({
			motion: {
				type: "enum",
				values: ["full", "subtle", "off"],
				mapsTo: "display.animations",
			},
		});
		settings.set("display.animations", "full");
		const manager = new PluginManager(tmpRoot);

		await manager.setPluginSetting("test-plugin", "motion", "subtle");

		expect(settings.get("display.animations")).toBe("subtle");
		const lock = await Bun.file(lockfile).json();
		expect(lock.settings["test-plugin"]?.motion).toBeUndefined();
		await expect(manager.getPluginSettings("test-plugin")).resolves.toMatchObject({ motion: "subtle" });
	});

	test("out-of-schema mapped value falls back to the plugin store", async () => {
		await writeInstalledPlugin({
			motion: {
				type: "enum",
				values: ["warp-speed"],
				mapsTo: "display.animations",
			},
		});
		settings.set("display.animations", "full");
		const manager = new PluginManager(tmpRoot);

		await expect(manager.setPluginSetting("test-plugin", "motion", "warp-speed")).resolves.toBeUndefined();

		expect(settings.get("display.animations")).toBe("full");
		const lock = await Bun.file(lockfile).json();
		expect(lock.settings["test-plugin"].motion).toBe("warp-speed");
	});

	test("unknown mapsTo neither crashes writes nor reads", async () => {
		await writeInstalledPlugin({
			broken: {
				type: "string",
				mapsTo: "not.a.real.setting",
			},
		});
		settings.set("display.animations", "full");
		const manager = new PluginManager(tmpRoot);

		await expect(manager.setPluginSetting("test-plugin", "broken", "x")).resolves.toBeUndefined();

		await expect(manager.getPluginSettings("test-plugin")).resolves.toMatchObject({ broken: "x" });
	});

	test("boolean mapsToTrue and mapsToFalse semantics are preserved", async () => {
		await writeInstalledPlugin({
			anims: {
				type: "boolean",
				mapsTo: "display.animations",
				mapsToTrue: "full",
				mapsToFalse: "off",
			},
		});
		const manager = new PluginManager(tmpRoot);

		settings.set("display.animations", "off");
		await manager.setPluginSetting("test-plugin", "anims", true);
		expect(settings.get("display.animations")).toBe("full");

		await manager.setPluginSetting("test-plugin", "anims", false);
		expect(settings.get("display.animations")).toBe("off");

		settings.set("display.animations", "subtle");
		await manager.setPluginSetting("test-plugin", "anims", true);
		expect(settings.get("display.animations")).toBe("subtle");
		await expect(manager.getPluginSettings("test-plugin")).resolves.toMatchObject({ anims: true });
	});
});
