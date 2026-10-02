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
	process.env.PI_1337_THEME = "split";
	assert.equal(envPalette(), "1337-split");
	process.env.PI_1337_THEME = "green";
	assert.equal(envPalette(), "1337");
	process.env.PI_1337_THEME = "cyber";
	assert.equal(envPalette(), "1337-cyber");
	process.env.PI_1337_THEME = "blue"; // convenience alias for the same palette
	assert.equal(envPalette(), "1337-cyber");
	process.env.PI_1337_THEME = "neon";
	assert.equal(envPalette(), "1337-neon");
	process.env.PI_1337_THEME = "fallout";
	assert.equal(envPalette(), "1337-fallout");
	process.env.PI_1337_THEME = "skynet";
	assert.equal(envPalette(), "1337-skynet");
	process.env.PI_1337_THEME = "1337-ice"; // full id works too
	assert.equal(envPalette(), "1337-ice");
});

test("isBundledTheme recognizes exactly the eight shipped palettes", () => {
	for (const name of ["1337", "1337-amber", "1337-ice", "1337-split", "1337-cyber", "1337-neon", "1337-fallout", "1337-skynet"])
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

test("envPalette honors a theme pinned in the config file", () => {
	withConfigFile(JSON.stringify({ theme: "amber" }));
	delete process.env.PI_1337_THEME;
	assert.equal(envPalette(), "1337-amber");
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
