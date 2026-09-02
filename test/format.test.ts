import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentCount,
	branchLabel,
	cleanModel,
	formatContext,
	formatCost,
	formatTokens,
	isBashInput,
	parsePersonaCost,
	shortCwd,
	stableEmojiWidth,
	usageLevel,
} from "../src/format.ts";
import { visibleWidth } from "../src/width.ts";

test("shortCwd keeps short paths and trims long ones to the last two segments", () => {
	assert.equal(shortCwd("/srv/app"), "/srv/app");
	assert.equal(shortCwd("/a/b/c/d"), "/…/c/d");
	assert.equal(shortCwd("C:\\work\\proj\\pkg"), "…/proj/pkg"); // windows slashes normalized
});

// The home prefix used to be matched as raw text against $HOME, which broke in two
// ways seen on a real machine: a HOME with a trailing separator swallowed the slash
// after `~` ("~Desktop/ctf"), and a Windows shell reporting `C:\users\me` while
// USERPROFILE says `C:\Users\me` missed the match and dropped the `~` entirely.
test("shortCwd anchors ~ on segment boundaries, whatever shape HOME arrives in", () => {
	const home = process.env.HOME;
	const profile = process.env.USERPROFILE;
	const win = process.platform === "win32";
	try {
		process.env.HOME = win ? "C:\\Users\\me\\" : "/home/me/"; // trailing separator
		assert.equal(shortCwd(win ? "C:\\Users\\me\\Desktop\\ctf" : "/home/me/Desktop/ctf"), "~/…/Desktop/ctf");
		process.env.HOME = win ? "C:\\Users\\me" : "/home/me";
		assert.equal(shortCwd(win ? "C:\\Users\\me\\ctf" : "/home/me/ctf"), "~/ctf");
		assert.equal(shortCwd(win ? "C:\\Users\\me" : "/home/me"), "~"); // home itself
		// A sibling that merely shares the prefix is not inside home.
		assert.equal(shortCwd(win ? "C:\\Users\\me2\\ctf" : "/home/me2/ctf"), win ? "…/me2/ctf" : "/…/me2/ctf");
		if (win) {
			// Windows paths are case-insensitive; the shell's casing must not matter.
			assert.equal(shortCwd("c:\\users\\me\\desktop\\ctf"), "~/…/desktop/ctf");
		}
	} finally {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (profile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = profile;
	}
});

test("cleanModel strips the claude- prefix and handles none", () => {
	assert.equal(cleanModel("claude-opus-4-8"), "opus-4-8");
	assert.equal(cleanModel(undefined), "no model");
});

test("chrome labels neutralize terminal controls, line breaks, and bidi overrides", () => {
	assert.equal(cleanModel("claude-opus\x1b[2J\nspoof\u202e"), "opus spoof");
	assert.equal(branchLabel("\x1b]8;;https://example.invalid\x07main\x1b]8;;\x07\r\nspoof\u2066"), " · main spoof");
	assert.equal(shortCwd("C:\\work\\\x1b[31mrepo\x1b[0m\nspoof"), "…/work/repo spoof");
	assert.equal(stableEmojiWidth("\x1b[2J🎯 Elite\nspoof\u202d"), "🎯 Elite spoof");
});

test("formatTokens compacts counts to k/M", () => {
	assert.equal(formatTokens(500), "500");
	assert.equal(formatTokens(12345), "12.3k");
	assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatContext shows tokens used + percent, or — when unknown", () => {
	assert.equal(formatContext({ tokens: 12345, contextWindow: 200000, percent: 6.2 }), "12.3k · 6%");
	assert.equal(formatContext({ tokens: 500, contextWindow: 200000, percent: 0.25 }), "500 · 0%");
	assert.equal(formatContext({ tokens: null, contextWindow: 200000, percent: null }), "ctx —");
	assert.equal(formatContext(undefined), "ctx —");
});

test("agentCount prefers a finite published count and pluralizes", () => {
	assert.deepEqual(agentCount("3", 0), { count: 3, label: " 3 agents " });
	assert.deepEqual(agentCount("1", 0), { count: 1, label: " 1 agent " });
});

test("agentCount falls back to the delegate count for non-numeric or empty published", () => {
	assert.deepEqual(agentCount("2 cores", 5), { count: 5, label: " 5 agents " }); // non-numeric → fallback
	assert.deepEqual(agentCount(undefined, 2), { count: 2, label: " 2 agents " });
	assert.deepEqual(agentCount("", 4), { count: 4, label: " 4 agents " }); // empty string must NOT coerce to 0
});

test("agentCount yields an empty label at zero", () => {
	assert.deepEqual(agentCount(undefined, 0), { count: 0, label: "" });
	assert.deepEqual(agentCount("0", 3), { count: 0, label: "" }); // explicit published 0 wins over the fallback
});

test("branchLabel renders ' · branch' and omits itself outside a repo", () => {
	assert.equal(branchLabel("main"), " · main");
	assert.equal(branchLabel("detached"), " · detached"); // Pi's detached-HEAD sentinel
	assert.equal(branchLabel(null), ""); // not in a git repo
	assert.equal(branchLabel(undefined), ""); // footer data not captured yet
	assert.equal(branchLabel(""), "");
});

test("isBashInput flags a buffer that starts Pi's bash mode", () => {
	assert.ok(isBashInput("!npm test"));
	assert.ok(isBashInput("  \t!npm test")); // Pi trims leading whitespace before entering bash mode
	assert.ok(isBashInput("!"));
	assert.ok(!isBashInput("hello !world")); // bash mode is a leading !, not any !
	assert.ok(!isBashInput(""));
});

test("usageLevel escalates with the footer's thresholds (>70 warn, >90 critical)", () => {
	assert.equal(usageLevel(6), "normal");
	assert.equal(usageLevel(70), "normal"); // boundary stays normal
	assert.equal(usageLevel(71), "warn");
	assert.equal(usageLevel(90), "warn"); // boundary stays warn
	assert.equal(usageLevel(92), "critical");
	assert.equal(usageLevel(null), "normal");
	assert.equal(usageLevel(undefined), "normal");
});

test("formatCost sums assistant usage and hides a zero total", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.3 } } } },
		{ type: "message", message: { role: "user" } }, // no cost, ignored
		{ type: "compaction" }, // non-message, ignored
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.123 } } } },
	];
	assert.equal(formatCost(entries), "$0.423"); // < $1 → 3 decimals
	assert.equal(formatCost([{ type: "message", message: { role: "assistant", usage: { cost: { total: 2.5 } } } }]), "$2.50");
	assert.equal(formatCost([]), ""); // zero → omitted from the plancia
});

test("formatCost matches Pi's cumulative usage across tool results and summaries", () => {
	const entries = [
		{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.5 } } } },
		{ type: "compaction", usage: { cost: { total: 1.25 } } },
		{ type: "branch_summary", usage: { cost: { total: 2.75 } } },
	];
	assert.equal(formatCost(entries), "$4.50");
});

test("formatCost adds leftover background-leg spend published as persona-cost", () => {
	const supervisor = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } }];
	assert.equal(formatCost(supervisor, false, 0.5), "$1.00");
	assert.equal(formatCost(supervisor, true, 0.5), ""); // subscription still hides the whole figure
});

test("parsePersonaCost reads pi-persona's leftover-leg status", () => {
	assert.equal(parsePersonaCost(undefined), 0);
	assert.equal(parsePersonaCost("$0.923"), 0.923);
	assert.equal(parsePersonaCost("1.92"), 1.92);
	assert.equal(parsePersonaCost("not a cost"), 0);
});

test("formatCost hides the nominal cost entirely on an OAuth subscription", () => {
	// On Claude Pro/Max the accumulated figure is an API-equivalent, not money
	// spent — showing it (or a "(sub)" marker) is noise. No cost shown = sub;
	// a visible cost = actually paying per token.
	const paid = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 2.5 } } } }];
	assert.equal(formatCost(paid, true), "");
	assert.equal(formatCost([], true), "");
	assert.equal(formatCost(paid, false), "$2.50");
});

test("formatCost ignores malformed and negative usage instead of rendering NaN or Infinity", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: Number.NaN } } } },
		{ type: "message", message: { role: "assistant", usage: { cost: { total: Number.POSITIVE_INFINITY } } } },
		{ type: "message", message: { role: "assistant", usage: { cost: { total: -2 } } } },
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
	];
	assert.equal(formatCost(entries), "$0.250");
});

test("stableEmojiWidth drops the lone VS16 so our width model matches the terminal", () => {
	// 🗺️ Planner / ⚖️ Judge: base symbol + U+FE0F. Before: our model sizes the
	// emoji at 2 but the terminal paints a different cell count → the box's right
	// rail drifts. After: the selector is gone, so both agree at width 1.
	const map = stableEmojiWidth("🗺️ Planner");
	assert.ok(!map.includes("\uFE0F"));
	assert.equal(visibleWidth(map), visibleWidth("🗺 Planner"));
	assert.equal(visibleWidth(map), 9); // 1 (map) + " Planner"

	const judge = stableEmojiWidth("⚖️ Judge");
	assert.ok(!judge.includes("\uFE0F"));
	assert.equal(visibleWidth(judge), 7); // 1 (scales) + " Judge"
});

test("stableEmojiWidth leaves selector-free emoji and ZWJ sequences intact", () => {
	assert.equal(stableEmojiWidth("🎯 Elite"), "🎯 Elite"); // Emoji_Presentation=Yes, no VS16
	const rainbow = "🏳️‍🌈 Pride"; // VS16 sits next to U+200D — part of the ZWJ sequence
	assert.equal(stableEmojiWidth(rainbow), rainbow); // untouched, still one wide cluster
	const medic = "👩‍⚕️ Medic"; // VS16 belongs to the grapheme even though it is not adjacent to the joiner
	assert.equal(stableEmojiWidth(medic), medic);
	assert.equal(stableEmojiWidth("plain text"), "plain text");
});
