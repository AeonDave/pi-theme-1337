import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { backgroundEnv, chooseStartupTheme, copyShortcut, envPalette, isBundledTheme } from "../src/config.ts";

afterEach(() => {
	delete process.env.PI_1337_COPY_KEY;
	delete process.env.PI_1337_THEME;
	delete process.env.PI_1337_BG;
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
