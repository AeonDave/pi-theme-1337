import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** The 51 color tokens Pi's theme schema requires — none are optional. */
const REQUIRED = [
	// Core UI (11)
	"accent", "border", "borderAccent", "borderMuted", "success", "error",
	"warning", "muted", "dim", "text", "thinkingText",
	// Backgrounds & content (11)
	"selectedBg", "userMessageBg", "userMessageText", "customMessageBg",
	"customMessageText", "customMessageLabel", "toolPendingBg", "toolSuccessBg",
	"toolErrorBg", "toolTitle", "toolOutput",
	// Markdown (10)
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
	"mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
	// Tool diffs (3)
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	// Syntax (9)
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
	"syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	// Thinking borders (6)
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
	// Bash mode (1)
	"bashMode",
];

interface Theme {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
}

const themesDir = join(import.meta.dirname, "..", "themes");
const files = readdirSync(themesDir).filter((f) => f.endsWith(".json"));
const themes = new Map<string, Theme>(files.map((f) => [f, JSON.parse(readFileSync(join(themesDir, f), "utf8")) as Theme]));

const HEX = /^#[0-9a-fA-F]{6}$/;
function isColorLiteral(v: string | number): boolean {
	return typeof v === "number" ? v >= 0 && v <= 255 : v === "" || HEX.test(v);
}

function resolveColor(theme: Theme, key: string): string {
	const value = theme.colors[key] ?? theme.vars?.[key];
	if (typeof value !== "string") throw new TypeError(`${theme.name}: ${key} is not a truecolor value`);
	const resolved = HEX.test(value) ? value : theme.vars?.[value];
	assert.ok(typeof resolved === "string" && HEX.test(resolved), `${theme.name}: cannot resolve ${key}`);
	return resolved;
}

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const [r, g, b] = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrastRatio(a: string, b: string): number {
	const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

test("the bundled palettes ship", () => {
	assert.deepEqual(files.sort(), [
		"1337-amber.json",
		"1337-cyber.json",
		"1337-fallout.json",
		"1337-ice.json",
		"1337-neon.json",
		"1337-skynet.json",
		"1337-split.json",
		"1337.json",
	]);
});

test("each theme's name matches its filename", () => {
	for (const [file, theme] of themes) {
		assert.equal(theme.name, file.replace(/\.json$/, ""), `${file}`);
	}
});

test("all palettes satisfy Pi 1.0's published top-level theme schema", () => {
	const schemaPath = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme", "theme-schema.json");
	const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { additionalProperties: boolean; properties: Record<string, unknown> };
	assert.equal(schema.additionalProperties, false, "keep the test pinned to the published strict contract");
	for (const [file] of themes) {
		const theme = JSON.parse(readFileSync(join(themesDir, file), "utf8")) as Record<string, unknown>;
		assert.deepEqual(Object.keys(theme).filter((key) => !(key in schema.properties)), [], `${file}: unknown top-level fields`);
	}
});

test("fallout and skynet extras live in adjacent non-theme sidecars", () => {
	for (const name of ["1337-fallout", "1337-skynet"]) {
		const extra = JSON.parse(readFileSync(join(themesDir, `${name}.pi1337`), "utf8")) as { background?: string; avatar?: unknown };
		assert.equal(extra.background, "on");
		assert.ok(extra.avatar, `${name}: avatar preserved`);
	}
});

for (const [file, theme] of themes) {
	test(`${file} defines all 51 required tokens and no unknown ones`, () => {
		for (const token of REQUIRED) assert.ok(token in theme.colors, `${file} missing token: ${token}`);
		const extra = Object.keys(theme.colors).filter((k) => !REQUIRED.includes(k));
		assert.deepEqual(extra, [], `${file} unexpected tokens: ${extra.join(", ")}`);
	});

	test(`${file}: every color value is a hex/index literal or resolves through vars`, () => {
		const vars = theme.vars ?? {};
		for (const [key, value] of Object.entries(theme.colors)) {
			if (isColorLiteral(value)) continue;
			assert.ok(typeof value === "string" && value in vars, `${file} token ${key}: "${value}" is not a literal or known var`);
			assert.ok(isColorLiteral(vars[value]), `${file} var ${value} → "${vars[value]}" is not a valid color`);
		}
	});
}

test("the default 1337 palette stays monochrome green: amber is the only deviation", () => {
	// Every var is either an amber/caution accent or sits in the green ramp (green
	// channel dominant). Guards against an off-palette color sneaking into the
	// flagship theme. The amber/ice/split siblings are intentionally other-hued
	// and only bound by the token contract above.
	const vars = (themes.get("1337.json") as Theme).vars ?? {};
	const allowedNonGreen = new Set(["amber", "caution", "errBg"]);
	for (const [name, value] of Object.entries(vars)) {
		if (allowedNonGreen.has(name) || typeof value !== "string" || !HEX.test(value)) continue;
		const r = parseInt(value.slice(1, 3), 16);
		const g = parseInt(value.slice(3, 5), 16);
		const b = parseInt(value.slice(5, 7), 16);
		assert.ok(g >= r && g >= b, `var ${name} (${value}) is not green-dominant`);
	}
});

test("dim text remains WCAG AA-readable on terminal, panel, and selected backgrounds", () => {
	for (const [file, theme] of themes) {
		const dim = resolveColor(theme, "dim");
		for (const background of ["void", "panel", "selectedBg"]) {
			const ratio = contrastRatio(dim, resolveColor(theme, background));
			assert.ok(ratio >= 4.5, `${file}: dim on ${background} is only ${ratio.toFixed(2)}:1`);
		}
	}
});
