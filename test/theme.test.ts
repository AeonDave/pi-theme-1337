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

test("each theme's name matches its filename and declares canonical dark metadata", () => {
	for (const [file, theme] of themes) {
		assert.equal(theme.name, file.replace(/\.json$/, ""), `${file}`);
		const raw = JSON.parse(readFileSync(join(themesDir, file), "utf8")) as { $schema?: string; appearance?: string };
		assert.equal(raw.$schema, "https://pi.dev/schemas/theme.schema.json", `${file}: canonical published schema URL`);
		assert.equal(raw.appearance, "dark", `${file}: palette must explicitly target dark terminals`);
	}
});

test("all palettes satisfy the installed host's published top-level theme schema", () => {
	const schemaPath = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "schemas", "theme.schema.json");
	const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { additionalProperties: boolean; properties: Record<string, unknown> };
	assert.equal(schema.additionalProperties, false, "keep the test pinned to the published strict contract");
	for (const [file] of themes) {
		const theme = JSON.parse(readFileSync(join(themesDir, file), "utf8")) as Record<string, unknown>;
		assert.deepEqual(Object.keys(theme).filter((key) => !(key in schema.properties)), [], `${file}: unknown top-level fields`);
	}
});

test("bundled sidecars retain tint without shipping avatars or image assets", () => {
	for (const name of ["1337-fallout", "1337-skynet"]) {
		const extra = JSON.parse(readFileSync(join(themesDir, `${name}.pi1337`), "utf8")) as { background?: string; avatar?: unknown };
		assert.equal(extra.background, "on");
		assert.equal(extra.avatar, undefined, `${name}: bundled themes stay image-free`);
	}
	const bundledPngs = readdirSync(themesDir, { recursive: true }).filter((file) => String(file).toLowerCase().endsWith(".png"));
	assert.deepEqual(bundledPngs, [], "bundled themes must contain no PNG assets");
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

	test(`${file}: unchanged diff text stays readable on successful tool output`, () => {
		const ratio = contrastRatio(resolveColor(theme, "toolDiffContext"), resolveColor(theme, "toolSuccessBg"));
		assert.ok(ratio >= 4.5, `${file}: diff context on toolSuccessBg is only ${ratio.toFixed(2)}:1`);
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

test("every palette body color stays vivid: broad RGB range and at least 60% HSL saturation", () => {
	for (const [file, theme] of themes) {
		const hex = resolveColor(theme, "text");
		const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
		const range = Math.max(...channels) - Math.min(...channels);
		const [r, g, b] = channels.map((channel) => channel / 255);
		const max = Math.max(r ?? 0, g ?? 0, b ?? 0);
		const min = Math.min(r ?? 0, g ?? 0, b ?? 0);
		const lightness = (max + min) / 2;
		const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
		assert.ok(range >= 85, `${file}: body ${hex} has only ${range} RGB channel range (<85)`);
		assert.ok(saturation >= 0.6, `${file}: body ${hex} has only ${(saturation * 100).toFixed(1)}% HSL saturation (<60%)`);
	}
});

test("palette readability, semantic separation, and role contrast stay measured", () => {
	const surfaceNames = ["void", "panel", "selectedBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
	const statusRoles = ["accent", "error", "warning", "success"];
	const syntaxRoles = ["syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation"];
	const thinkingRoles = ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh"];
	const surfaces = [...new Set(["void", "panel", "selectedBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"])] as const;
	const minContrast = (current: Theme, fg: string, bgs: string[]) => Math.min(...bgs.map((bg) => contrastRatio(fg, resolveColor(current, bg))));

	for (const [file, theme] of themes) {
		const voidBg = resolveColor(theme, "void");
		const backgrounds = ["void", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
		for (const role of ["text", "toolOutput"]) {
			const color = resolveColor(theme, role);
			for (const bg of backgrounds) {
				const ratio = contrastRatio(color, resolveColor(theme, bg));
				assert.ok(ratio >= 7, `${file}: ${role} on ${bg} is ${ratio.toFixed(2)}:1 (<7)`);
			}
		}
		for (const [role, bg] of [["userMessageText", "userMessageBg"], ["customMessageText", "customMessageBg"]]) {
			const ratio = contrastRatio(resolveColor(theme, role), resolveColor(theme, bg));
			assert.ok(ratio >= 7, `${file}: ${role} on ${bg} is ${ratio.toFixed(2)}:1 (<7)`);
		}
		for (const role of ["dim", "muted"]) {
			const ratio = minContrast(theme, resolveColor(theme, role), [...surfaces]);
			assert.ok(ratio >= 4.5, `${file}: ${role} minimum surface contrast ${ratio.toFixed(2)}:1 (<4.5)`);
		}
		const hierarchy = ["border", "dim", "muted", "text"].map((role) => relativeLuminance(resolveColor(theme, role)));
		for (let i = 1; i < hierarchy.length; i++) {
			assert.ok((hierarchy[i] ?? 0) - (hierarchy[i - 1] ?? 0) >= 0.02, `${file}: ${["border", "dim", "muted", "text"][i - 1]}→${["border", "dim", "muted", "text"][i]} lacks the luminance tier gap`);
		}
		for (const role of syntaxRoles) {
			for (const bg of ["void", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
				const ratio = contrastRatio(resolveColor(theme, role), resolveColor(theme, bg));
				assert.ok(ratio >= 4.5, `${file}: ${role} on ${bg} is ${ratio.toFixed(2)}:1 (<4.5)`);
			}
		}
		for (const [role, bg] of [["toolDiffAdded", "toolSuccessBg"], ["toolDiffRemoved", "toolErrorBg"], ["toolDiffContext", "void"], ["toolDiffContext", "toolSuccessBg"]]) {
			const ratio = contrastRatio(resolveColor(theme, role), resolveColor(theme, bg));
			assert.ok(ratio >= 4.5, `${file}: ${role} on ${bg} is ${ratio.toFixed(2)}:1 (<4.5)`);
		}
		for (const role of statusRoles) {
			for (const bg of ["void", "panel", "selectedBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
				const ratio = contrastRatio(resolveColor(theme, role), resolveColor(theme, bg));
				assert.ok(ratio >= 4.5, `${file}: ${role} on ${bg} is ${ratio.toFixed(2)}:1 (<4.5)`);
			}
		}
		for (const role of ["text", "dim", "muted", ...statusRoles]) {
			const ratio = contrastRatio(resolveColor(theme, role), "#1e1e1e");
			assert.ok(ratio >= 4.5, `${file}: ${role} on untinted terminal #1e1e1e is ${ratio.toFixed(2)}:1 (<4.5)`);
		}
		const syntaxColors = syntaxRoles.map((role) => resolveColor(theme, role).toLowerCase());
		assert.ok(new Set(syntaxColors).size >= 6, `${file}: syntax needs at least six distinct colors`);
		for (const [a, b] of [["syntaxKeyword", "syntaxType"], ["syntaxFunction", "syntaxVariable"], ["syntaxString", "syntaxComment"]]) {
			assert.notEqual(resolveColor(theme, a).toLowerCase(), resolveColor(theme, b).toLowerCase(), `${file}: ${a}/${b} should remain visually distinct`);
		}
		const luminances = thinkingRoles.map((role) => relativeLuminance(resolveColor(theme, role)));
		for (let i = 1; i < luminances.length; i++) {
			assert.ok((luminances[i] ?? 0) > (luminances[i - 1] ?? 0), `${file}: ${thinkingRoles[i]} must be brighter than ${thinkingRoles[i - 1]}`);
		}
		for (const [left, right] of [["accent", "error"], ["accent", "warning"], ["success", "error"], ["warning", "error"]]) {
			const delta = deltaE(resolveColor(theme, left), resolveColor(theme, right)) * 100;
			assert.ok(delta >= 8, `${file}: ${left}/${right} separation is only ${delta.toFixed(1)} OKLab ΔE (<8)`);
		}
	}
});

function deltaE(a: string, b: string): number {
	const lab = (hex: string): [number, number, number] => {
		const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		const [r, g, bl] = rgb;
		const l = Math.cbrt(0.4122214708 * (r ?? 0) + 0.5363325363 * (g ?? 0) + 0.0514459929 * (bl ?? 0));
		const m = Math.cbrt(0.2119034982 * (r ?? 0) + 0.6806995451 * (g ?? 0) + 0.1073969566 * (bl ?? 0));
		const s = Math.cbrt(0.0883024619 * (r ?? 0) + 0.2817188376 * (g ?? 0) + 0.6299787005 * (bl ?? 0));
		return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
	};
	const x = lab(a), y = lab(b);
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
