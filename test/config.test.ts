import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	backgroundEnv,
	chooseStartupTheme,
	configFileSettings,
	copyShortcut,
	envPalette,
	hiddenThinkingLabel,
	isBundledTheme,
	isDisabled,
	maxBoxWidth,
	resolveSettings,
	stateDir,
} from "../src/config.ts";

const tempDirs: string[] = [];

// Every test starts from an EMPTY state dir so the developer's real
// ~/.pi/agent/1337-theme/config.json can never leak into these assertions.
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-1337-empty-"));
	tempDirs.push(dir);
	process.env.PI_1337_STATE_DIR = dir;
});

/** Point the state dir at a scratch directory and write `config.json` into it. */
function withConfigFile(contents: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-1337-cfg-"));
	tempDirs.push(dir);
	if (contents !== null) writeFileSync(join(dir, "config.json"), contents);
	process.env.PI_1337_STATE_DIR = dir;
	return dir;
}

afterEach(() => {
	delete process.env.PI_1337_COPY_KEY;
	delete process.env.PI_1337_THEME;
	delete process.env.PI_1337_BG;
	delete process.env.PI_1337_DISABLE;
	delete process.env.PI_1337_THINKING_LABEL;
	delete process.env.PI_1337_ACTIVITY;
	delete process.env.PI_1337_GROUPS;
	delete process.env.PI_1337_SUMMARY;
	delete process.env.PI_1337_TITLE;
	delete process.env.PI_1337_QUOTA;
	delete process.env.PI_1337_POLISH;
	delete process.env.PI_1337_MAX_WIDTH;
	delete process.env.PI_1337_STATE_DIR;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("copyShortcut defaults to alt+c when unset", () => {
	delete process.env.PI_1337_COPY_KEY;
	assert.equal(copyShortcut(), "alt+c");
});

test("copyShortcut honors an explicit override, trimmed", () => {
	process.env.PI_1337_COPY_KEY = "  ctrl+alt+y  ";
	assert.equal(copyShortcut(), "ctrl+alt+y");
});

test("copyShortcut treats an empty/whitespace value as disabled", () => {
	process.env.PI_1337_COPY_KEY = "   ";
	assert.equal(copyShortcut(), ""); // empty → registerShortcut is skipped
	process.env.PI_1337_COPY_KEY = "";
	assert.equal(copyShortcut(), "");
});

test("envPalette pins a palette only when PI_1337_THEME explicitly names one", () => {
	delete process.env.PI_1337_THEME;
	assert.equal(envPalette(), undefined); // unset → no pin
	process.env.PI_1337_THEME = "on";
	assert.equal(envPalette(), undefined); // plain enable → no pin
	process.env.PI_1337_THEME = "off";
	assert.equal(envPalette(), undefined);
	process.env.PI_1337_THEME = "chartreuse";
	assert.equal(envPalette(), undefined); // unrecognized → no pin
	process.env.PI_1337_THEME = "  AMBER ";
	assert.equal(envPalette(), "1337-amber"); // alias, case/space-insensitive
	process.env.PI_1337_THEME = "ice";
	assert.equal(envPalette(), "1337-ice");
	process.env.PI_1337_THEME = "poison";
	assert.equal(envPalette(), "1337-poison");
	process.env.PI_1337_THEME = "magma";
	assert.equal(envPalette(), "1337-magma");
	process.env.PI_1337_THEME = "skynet-dark";
	assert.equal(envPalette(), "1337-skynet-dark");
	process.env.PI_1337_THEME = "green";
	assert.equal(envPalette(), "1337");
	process.env.PI_1337_THEME = "cyber";
	assert.equal(envPalette(), "1337-cyber");
	process.env.PI_1337_THEME = "cyberpunk-2077";
	assert.equal(envPalette(), "1337-cyberpunk-2077");
	process.env.PI_1337_THEME = "cyberpunk-2077-edgerunner";
	assert.equal(envPalette(), "1337-cyberpunk-2077-edgerunner");
	process.env.PI_1337_THEME = "blue"; // convenience alias for the same palette
	assert.equal(envPalette(), "1337-cyber");
	process.env.PI_1337_THEME = "neon";
	assert.equal(envPalette(), "1337-neon");
	process.env.PI_1337_THEME = "cosmos";
	assert.equal(envPalette(), "1337-cosmos");
	process.env.PI_1337_THEME = "1337-cosmos";
	assert.equal(envPalette(), "1337-cosmos");
	process.env.PI_1337_THEME = "fallout";
	assert.equal(envPalette(), "1337-fallout");
	process.env.PI_1337_THEME = "skynet";
	assert.equal(envPalette(), "1337-skynet");
	process.env.PI_1337_THEME = "1337-ice"; // full id works too
	assert.equal(envPalette(), "1337-ice");
	process.env.PI_1337_THEME = "1337-cyberpunk-2077";
	assert.equal(envPalette(), "1337-cyberpunk-2077");
	process.env.PI_1337_THEME = "1337-cyberpunk-2077-edgerunner";
	assert.equal(envPalette(), "1337-cyberpunk-2077-edgerunner");
});

test("isBundledTheme recognizes exactly the thirteen shipped palettes", () => {
	for (const name of ["1337", "1337-amber", "1337-ice", "1337-poison", "1337-magma", "1337-cyber", "1337-cyberpunk-2077", "1337-cyberpunk-2077-edgerunner", "1337-neon", "1337-cosmos", "1337-fallout", "1337-skynet", "1337-skynet-dark"])
		assert.ok(isBundledTheme(name));
	assert.ok(!isBundledTheme("dark"));
	assert.ok(!isBundledTheme("1337-custom")); // unknown sibling names are not ours to claim
	assert.ok(!isBundledTheme(undefined));
});

test("backgroundEnv forwards the raw PI_1337_BG (undefined when unset) for the resolver", () => {
	delete process.env.PI_1337_BG;
	assert.equal(backgroundEnv(), undefined); // unset → defer to the theme's own pi1337.background
	process.env.PI_1337_BG = "on";
	assert.equal(backgroundEnv(), "on");
	process.env.PI_1337_BG = "#0a0303";
	assert.equal(backgroundEnv(), "#0a0303");
	process.env.PI_1337_BG = "off";
	assert.equal(backgroundEnv(), "off"); // an explicit off must reach the resolver to override the theme
});

test("chooseStartupTheme respects a persisted bundled palette when no env pin is set", () => {
	// The reported bug: user picks 1337-ice in /settings, restarts, and the
	// extension used to stomp it back to the default green.
	delete process.env.PI_1337_THEME;
	assert.equal(chooseStartupTheme("1337-ice"), "1337-ice");
	assert.equal(chooseStartupTheme("1337-amber"), "1337-amber");
	assert.equal(chooseStartupTheme("1337"), "1337");
});

test("a Pi palette choice wins over the config-file theme on reload", () => {
	withConfigFile(JSON.stringify({ theme: "cyber" }));
	delete process.env.PI_1337_THEME;
	assert.equal(chooseStartupTheme("1337-skynet"), "1337-skynet");
	assert.equal(chooseStartupTheme("1337-skynet-dark"), "1337-skynet-dark");
	assert.equal(chooseStartupTheme("1337-cyberpunk-2077"), "1337-cyberpunk-2077");
	assert.equal(chooseStartupTheme("1337-cyberpunk-2077-edgerunner"), "1337-cyberpunk-2077-edgerunner");
	assert.equal(chooseStartupTheme("dark"), "1337-cyber", "config-file palette is the fallback when Pi has no bundled choice");
	process.env.PI_1337_THEME = "on";
	assert.equal(chooseStartupTheme("dark"), "1337", "explicit env enable suppresses the file's palette fallback");
});

test("chooseStartupTheme applies the default green over a foreign theme", () => {
	delete process.env.PI_1337_THEME;
	assert.equal(chooseStartupTheme("dark"), "1337");
	assert.equal(chooseStartupTheme(undefined), "1337");
});

test("chooseStartupTheme lets an explicit env pin win over the persisted choice", () => {
	process.env.PI_1337_THEME = "amber";
	assert.equal(chooseStartupTheme("1337-ice"), "1337-amber");
	assert.equal(chooseStartupTheme("dark"), "1337-amber");
});

test("chooseStartupTheme keeps a light theme unless a palette was asked for", () => {
	// Every bundled palette is dark: forcing one onto a light terminal makes the
	// text unreadable, so a light theme survives unless the user named a palette.
	const cases: { env?: string; file?: string; current: string | undefined; appearance?: "light" | "dark"; want: string; why: string }[] = [
		{ env: "1337-ice", current: "light", appearance: "light", want: "1337-ice", why: "1: env pin wins on a light theme" },
		{ env: "amber", current: "1337-fallout", appearance: "dark", want: "1337-amber", why: "1: env pin wins over a bundled current" },
		{ current: "1337-neon", appearance: "dark", want: "1337-neon", why: "2: bundled current kept" },
		{ file: "magma", current: "1337-neon", appearance: "dark", want: "1337-neon", why: "2: bundled current beats the file" },
		{ file: "cyber", current: "light", appearance: "light", want: "1337-cyber", why: "3: file palette applied on a light theme" },
		{ current: "light", appearance: "light", want: "light", why: "4: built-in light kept" },
		{ current: "solarized-light", appearance: "light", want: "solarized-light", why: "4: third-party light kept" },
		{ current: "dark", appearance: "dark", want: "1337", why: "5: built-in dark → default" },
		{ current: "gruvbox", appearance: "dark", want: "1337", why: "5: third-party dark → default" },
		{ current: "light", want: "1337", why: "5: unknown appearance → default, as before" },
		{ current: undefined, appearance: "light", want: "1337", why: "5: no current theme to keep" },
		{ env: "on", current: "light", appearance: "light", want: "1337", why: "5: explicit on forces default on light" },
		{ env: "chartreuse", current: "light", appearance: "light", want: "light", why: "4: a typo is not a request for a dark palette on a light theme" },
		{ env: "", current: "light", appearance: "light", want: "light", why: "4: neither is an emptied variable" },
		{ env: "chartreuse", current: "dark", appearance: "dark", want: "1337", why: "5: an unrecognized env value on a dark theme still means default" },
		{ env: " ON ", current: "light", appearance: "light", want: "1337", why: "5: `on` is matched as the other toggles are" },
		{ env: "on", file: "cyber", current: "light", appearance: "light", want: "1337", why: "5: env on suppresses the file palette" },
	];
	for (const c of cases) {
		withConfigFile(c.file === undefined ? null : JSON.stringify({ theme: c.file }));
		if (c.env === undefined) delete process.env.PI_1337_THEME;
		else process.env.PI_1337_THEME = c.env;
		assert.equal(chooseStartupTheme(c.current, c.appearance), c.want, c.why);
	}
});

// --- config.json state file -------------------------------------------------

test("stateDir honors PI_1337_STATE_DIR, else <agent-dir>/1337-theme", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-1337-cfg-"));
	tempDirs.push(dir);
	process.env.PI_1337_STATE_DIR = dir;
	assert.equal(stateDir(), dir);
	delete process.env.PI_1337_STATE_DIR;
	// Default namespaced under Pi's agent dir, like claude-native/ and persona/.
	assert.match(stateDir(), /[/\\]1337-theme$/);
	assert.match(stateDir(), /[/\\]\.pi[/\\]agent[/\\]1337-theme$/);
});

test("configFileSettings is empty when the file is absent", () => {
	withConfigFile(null);
	assert.deepEqual(configFileSettings(), {});
});

test("configFileSettings parses known keys and ignores unknown ones", () => {
	withConfigFile(JSON.stringify({ theme: "ice", thinkingLabel: "...", nope: 1, disable: true }));
	assert.deepEqual(configFileSettings(), { theme: "ice", thinkingLabel: "...", disable: true });
});

test("configFileSettings survives malformed JSON and non-object payloads", () => {
	withConfigFile("{ not json");
	assert.deepEqual(configFileSettings(), {});
	withConfigFile(JSON.stringify([1, 2, 3]));
	assert.deepEqual(configFileSettings(), {});
});

test("configFileSettings ignores wrong-typed values rather than throwing", () => {
	withConfigFile(JSON.stringify({ theme: 42, thinkingLabel: false, copyKey: null }));
	assert.deepEqual(configFileSettings(), {});
});

test("copyShortcut reads copyKey from the config file when the env var is unset", () => {
	withConfigFile(JSON.stringify({ copyKey: "ctrl+alt+y" }));
	delete process.env.PI_1337_COPY_KEY;
	assert.equal(copyShortcut(), "ctrl+alt+y");
});

test("the env var still wins over the config file", () => {
	withConfigFile(JSON.stringify({ copyKey: "ctrl+alt+y" }));
	process.env.PI_1337_COPY_KEY = "ctrl+shift+p";
	assert.equal(copyShortcut(), "ctrl+shift+p");
});

test("an empty copyKey in the config file disables the shortcut", () => {
	withConfigFile(JSON.stringify({ copyKey: "" }));
	delete process.env.PI_1337_COPY_KEY;
	assert.equal(copyShortcut(), "");
});

test("hiddenThinkingLabel falls back to the config file, then to the default", () => {
	withConfigFile(JSON.stringify({ thinkingLabel: "» spin" }));
	assert.equal(hiddenThinkingLabel(), "» spin");
	withConfigFile(null);
	assert.equal(hiddenThinkingLabel(), "∴ thinking");
});

test("config-file theme is a startup fallback rather than an env pin", () => {
	withConfigFile(JSON.stringify({ theme: "cyberpunk-2077-edgerunner" }));
	delete process.env.PI_1337_THEME;
	assert.equal(envPalette(), undefined);
	assert.equal(chooseStartupTheme("dark"), "1337-cyberpunk-2077-edgerunner");
});

test("isDisabled honors disable:true in the config file", () => {
	withConfigFile(JSON.stringify({ disable: true }));
	assert.equal(isDisabled(), true);
	withConfigFile(null);
	assert.equal(isDisabled(), false);
});

test("backgroundEnv reads background from the config file", () => {
	withConfigFile(JSON.stringify({ background: "on" }));
	assert.equal(backgroundEnv(), "on");
});

test("polished tool views default on and allow file/env opt-out", () => {
	delete process.env.PI_1337_POLISH;
	try {
		assert.equal(resolveSettings().polish, true);
		withConfigFile(JSON.stringify({ polish: false }));
		assert.equal(resolveSettings().polish, false);
		process.env.PI_1337_POLISH = " ON ";
		assert.equal(resolveSettings().polish, true);
		process.env.PI_1337_POLISH = "off";
		assert.equal(resolveSettings().polish, false);
		delete process.env.PI_1337_POLISH;
		withConfigFile(JSON.stringify({ polish: "false" }));
		assert.equal(resolveSettings().polish, true, "wrong-typed config is ignored");
	} finally {
		delete process.env.PI_1337_POLISH;
	}
});

for (const [name, accessor, env] of [
	["activity label", "activity", "PI_1337_ACTIVITY"],
	["tool grouping", "groups", "PI_1337_GROUPS"],
	["run summary", "summary", "PI_1337_SUMMARY"],
	["terminal title", "title", "PI_1337_TITLE"],
	["subscription quota", "quota", "PI_1337_QUOTA"],
] as const) {
	test(`${name} defaults on and allows file/env opt-out`, () => {
		delete process.env[env];
		assert.equal(resolveSettings()[accessor], true);
		withConfigFile(JSON.stringify({ [accessor]: false }));
		assert.equal(resolveSettings()[accessor], false);
		process.env[env] = " ON ";
		assert.equal(resolveSettings()[accessor], true, "the env token wins over the config file");
		process.env[env] = "off";
		assert.equal(resolveSettings()[accessor], false);
		delete process.env[env];
		withConfigFile(JSON.stringify({ [accessor]: "false" }));
		assert.equal(resolveSettings()[accessor], true, "wrong-typed config is ignored");
		withConfigFile(null);
		assert.equal(resolveSettings()[accessor], true);
	});
}

test("resolveSettings merges env over file over defaults", () => {
	withConfigFile(JSON.stringify({ theme: "ice", copyKey: "ctrl+alt+y", thinkingLabel: "file label" }));
	process.env.PI_1337_COPY_KEY = "ctrl+shift+p";
	const s = resolveSettings();
	assert.equal(s.theme, "1337-ice"); // alias normalized to the registered id
	assert.equal(s.copyKey, "ctrl+shift+p");
	assert.equal(s.thinkingLabel, "file label");
	assert.equal(s.disable, false);
	assert.equal(s.background, undefined);
});

test("polish resolution: env on/off wins, anything else defers to the file, then on", () => {
	assert.equal(resolveSettings().polish, true, "unset, no file");
	withConfigFile(JSON.stringify({ polish: true }));
	assert.equal(resolveSettings().polish, true);
	withConfigFile(JSON.stringify({ polish: false }));
	process.env.PI_1337_POLISH = "maybe";
	assert.equal(resolveSettings().polish, false, "an unrecognized env value defers to the file");
	process.env.PI_1337_POLISH = "On";
	assert.equal(resolveSettings().polish, true);
	withConfigFile(JSON.stringify({ polish: true }));
	process.env.PI_1337_POLISH = " OFF ";
	assert.equal(resolveSettings().polish, false);
});

test("grouping is off whenever polish is off, from env or file", () => {
	assert.equal(resolveSettings().groups, true, "on by default");
	process.env.PI_1337_POLISH = "off";
	process.env.PI_1337_GROUPS = "on";
	assert.equal(resolveSettings().groups, false, "env polish off beats an explicit groups on");
	delete process.env.PI_1337_POLISH;
	delete process.env.PI_1337_GROUPS;
	withConfigFile(JSON.stringify({ polish: false, groups: true }));
	assert.equal(resolveSettings().groups, false, "file polish off beats file groups on");
	process.env.PI_1337_POLISH = "on";
	assert.equal(resolveSettings().groups, true, "env polish on re-enables the file's groups");
	withConfigFile(JSON.stringify({ polish: false }));
	assert.equal(resolveSettings().groups, true, "env polish on wins over file polish off");
	assert.equal(resolveSettings().activity, true, "the activity label does not depend on polish");
	process.env.PI_1337_POLISH = "off";
	assert.equal(resolveSettings().activity, true);
});

test("maxBoxWidth defaults to the original 100-column box", () => {
	assert.equal(maxBoxWidth(), 100);
	assert.equal(resolveSettings().maxWidth, 100);
});

test("maxBoxWidth takes whole columns, 0/full for no cap, and raises tiny caps to 40", () => {
	for (const [raw, expected] of [
		["140", 140], [" 120 ", 120], ["0", Infinity], ["full", Infinity], [" FULL ", Infinity],
		["40", 40], ["39", 40], ["1", 40], ["007", 40], ["080", 80],
	] as const) {
		process.env.PI_1337_MAX_WIDTH = raw;
		assert.equal(maxBoxWidth(), expected, JSON.stringify(raw));
	}
});

test("maxBoxWidth ignores invalid values at each level instead of shrinking the box", () => {
	for (const raw of ["", " ", "-5", "12.5", "1e3", "wide", "100px", "0x40", "Infinity", "99999999999999999999"]) {
		process.env.PI_1337_MAX_WIDTH = raw;
		assert.equal(maxBoxWidth(), 100, `env ${JSON.stringify(raw)} falls back to the default`);
	}
	withConfigFile(JSON.stringify({ maxWidth: 140 }));
	process.env.PI_1337_MAX_WIDTH = "garbage";
	assert.equal(maxBoxWidth(), 140, "an invalid env value defers to the file");
	for (const maxWidth of [-1, 12.5, true, null, "", "narrow", [120], { columns: 120 }]) {
		withConfigFile(JSON.stringify({ maxWidth }));
		delete process.env.PI_1337_MAX_WIDTH;
		assert.equal(maxBoxWidth(), 100, `file ${JSON.stringify(maxWidth)} falls back to the default`);
	}
});

test("maxBoxWidth reads the config file under the env var", () => {
	withConfigFile(JSON.stringify({ maxWidth: 160 }));
	assert.equal(maxBoxWidth(), 160);
	withConfigFile(JSON.stringify({ maxWidth: "full" }));
	assert.equal(maxBoxWidth(), Infinity);
	withConfigFile(JSON.stringify({ maxWidth: 0 }));
	assert.equal(maxBoxWidth(), Infinity);
	withConfigFile(JSON.stringify({ maxWidth: 10 }));
	assert.equal(maxBoxWidth(), 40, "the floor applies to the file too");
	withConfigFile(JSON.stringify({ maxWidth: 160 }));
	process.env.PI_1337_MAX_WIDTH = "120";
	assert.equal(maxBoxWidth(), 120, "a valid env value wins");
	process.env.PI_1337_MAX_WIDTH = "full";
	assert.equal(resolveSettings().maxWidth, Infinity);
});
