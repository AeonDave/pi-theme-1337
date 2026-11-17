import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	backgroundDetail,
	backgroundSummary,
	backgroundWorkOf,
	branchLabel,
	cleanModel,
	costTotal,
	formatContextWindow,
	formatCost,
	formatRunDelta,
	formatDuration,
	formatElapsed,
	formatTokens,
	bashInputMode,
	codePointAtIndex,
	MAX_BACKGROUND_COUNT,
	parseBackgroundStatus,
	parsePersonaCost,
	sanitizeArtLine,
	sanitizeInlineText,
	skipTerminalSequence,
	plural,
	recordOf,
	shortCwd,
	textOf,
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
		assert.equal(shortCwd(win ? "C:\\Users\\me\\Desktop\\ctf" : "/home/me/Desktop/ctf"), "~/Desktop/ctf");
		assert.equal(shortCwd(win ? "C:\\Users\\me\\src\\Desktop\\ctf" : "/home/me/src/Desktop/ctf"), "~/…/Desktop/ctf");
		process.env.HOME = win ? "C:\\Users\\me" : "/home/me";
		assert.equal(shortCwd(win ? "C:\\Users\\me\\ctf" : "/home/me/ctf"), "~/ctf");
		assert.equal(shortCwd(win ? "C:\\Users\\me" : "/home/me"), "~"); // home itself
		// A sibling that merely shares the prefix is not inside home.
		assert.equal(shortCwd(win ? "C:\\Users\\me2\\ctf" : "/home/me2/ctf"), win ? "…/me2/ctf" : "/…/me2/ctf");
		if (win) {
			// Windows paths are case-insensitive; the shell's casing must not matter.
			assert.equal(shortCwd("c:\\users\\me\\desktop\\ctf"), "~/desktop/ctf");
			assert.equal(shortCwd("c:\\users\\me\\src\\desktop\\ctf"), "~/…/desktop/ctf");
		}
	} finally {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (profile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = profile;
	}
});

// `~` is the anchor, not a segment: two real segments under home omit nothing,
// so an ellipsis there would only lengthen the label ("~/…/src/project").
test("shortCwd shows an ellipsis under home only when segments are actually omitted", () => {
	const home = process.env.HOME;
	const profile = process.env.USERPROFILE;
	const win = process.platform === "win32";
	const root = win ? "C:\\Users\\me" : "/home/me";
	const at = (...parts: string[]) => [root, ...parts].join(win ? "\\" : "/");
	try {
		process.env.HOME = root;
		assert.equal(shortCwd(at("src", "project")), "~/src/project");
		assert.equal(shortCwd(at("src", "project", "")), "~/src/project", "a trailing separator adds no segment");
		assert.equal(shortCwd(at("work", "src", "project")), "~/…/src/project");
		assert.equal(shortCwd(at("a", "b", "c", "d")), "~/…/c/d");
		// USERPROFILE is the fallback home on Windows shells that leave HOME unset.
		delete process.env.HOME;
		process.env.USERPROFILE = root;
		assert.equal(shortCwd(at("src", "project")), "~/src/project");
		assert.equal(shortCwd(at("work", "src", "project")), "~/…/src/project");
		// Outside home the root still stands for omitted context, as before.
		assert.equal(shortCwd("/srv/app/pkg"), "/…/app/pkg");
		assert.equal(shortCwd("/srv/app"), "/srv/app");
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

test("branchLabel renders ' · branch' and omits itself outside a repo", () => {
	assert.equal(branchLabel("main"), " · main");
	assert.equal(branchLabel("detached"), " · detached"); // Pi's detached-HEAD sentinel
	assert.equal(branchLabel(null), ""); // not in a git repo
	assert.equal(branchLabel(undefined), ""); // footer data not captured yet
	assert.equal(branchLabel(""), "");
});

test("bashInputMode reads the buffer as the host will: none, context for !, excluded for !!", () => {
	assert.equal(bashInputMode(""), "none");
	assert.equal(bashInputMode("   "), "none");
	assert.equal(bashInputMode("hello !world"), "none"); // bash mode is a leading !, not any !
	assert.equal(bashInputMode("hello !!world"), "none");
	assert.equal(bashInputMode("!npm test"), "context");
	assert.equal(bashInputMode("!"), "context"); // bash mode already, with nothing to run yet
	assert.equal(bashInputMode("! !"), "context"); // the second ! is the command's, not the marker's
	assert.equal(bashInputMode("!!npm test"), "excluded");
	assert.equal(bashInputMode("!!"), "excluded");
	assert.equal(bashInputMode("!!!"), "excluded"); // the host runs `!` and keeps its output out
	// The host ignores leading whitespace (trimStart while typing, trim on submit).
	for (const lead of ["  ", "\t", " \t ", "\n", " ", "　"]) {
		assert.equal(bashInputMode(`${lead}!npm test`), "context", JSON.stringify(lead));
		assert.equal(bashInputMode(`${lead}!!npm test`), "excluded", JSON.stringify(lead));
		assert.equal(bashInputMode(`${lead}npm test`), "none", JSON.stringify(lead));
	}
	assert.equal(bashInputMode("!npm test  "), "context"); // trailing whitespace changes nothing
});

test("usageLevel escalates with the footer's thresholds (>70 warn, >90 critical)", () => {
	assert.equal(usageLevel(6), "normal");
	assert.equal(usageLevel(70), "normal"); // boundary stays normal
	assert.equal(usageLevel(71), "warn");
	assert.equal(usageLevel(90), "warn"); // boundary stays warn
	assert.equal(usageLevel(92), "critical");
	// The level follows the whole percent the row prints, so color and digits agree.
	assert.equal(usageLevel(70.4), "normal", "prints 70%");
	assert.equal(usageLevel(70.5), "warn", "prints 71%");
	assert.equal(usageLevel(90.4), "warn", "prints 90%");
	assert.equal(usageLevel(90.5), "critical", "prints 91%");
	assert.equal(usageLevel(null), "normal");
	assert.equal(usageLevel(undefined), "normal");
});

const assistant = (total: unknown) => ({ type: "message", message: { role: "assistant", usage: { cost: { total } } } });

test("costTotal sums assistant usage and is zero for an empty session", () => {
	const entries = [
		assistant(0.3),
		{ type: "message", message: { role: "user" } }, // no cost, ignored
		{ type: "compaction" }, // no usage, ignored
		assistant(0.123),
	];
	assert.ok(Math.abs(costTotal(entries) - 0.423) < 1e-12);
	assert.equal(costTotal([assistant(2.5)]), 2.5);
	assert.equal(costTotal([]), 0);
});

test("costTotal matches Pi's cumulative usage across tool results and summaries", () => {
	const entries = [
		{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.5 } } } },
		{ type: "compaction", usage: { cost: { total: 1.25 } } },
		{ type: "branch_summary", usage: { cost: { total: 2.75 } } },
	];
	assert.equal(costTotal(entries), 4.5);
});

test("costTotal includes Pi 1.3 cache-warm usage entries", () => {
	assert.equal(costTotal([{ type: "usage", usage: { cost: { total: 0.25 } } }]), 0.25);
});

test("costTotal adds leftover background-leg usage published as persona-cost", () => {
	assert.equal(costTotal([assistant(0.5)], 0.5), 1);
	assert.equal(costTotal([], 0.5), 0.5, "the extra counts with no session spend at all");
});

test("costTotal includes mixed-provider history without treating an OAuth selection as billing proof", () => {
	const entries = [assistant(2.5), { type: "usage", provider: "anthropic", model: "claude-opus-4-8", usage: { cost: { total: 0.75 } } }];
	assert.equal(costTotal(entries), 3.25);
});

test("costTotal ignores malformed and negative usage instead of producing NaN or Infinity", () => {
	const entries = [
		assistant(Number.NaN),
		assistant(Number.POSITIVE_INFINITY),
		assistant(-2),
		assistant("0.5"),
		{ type: "usage", usage: { cost: { total: null } } },
		{ type: "message", message: { role: "user", usage: { cost: { total: 9 } } } }, // user rows carry no spend
		assistant(0.25),
	];
	assert.equal(costTotal(entries, Number.NaN), 0.25);
	assert.equal(costTotal(entries, -1), 0.25);
	assert.equal(costTotal(entries, Number.POSITIVE_INFINITY), 0.25);
});

test("formatCost picks its decimals from the rounded value and never prints a false zero", () => {
	for (const [total, label] of [
		[0, ""],
		[0.0004, "~<$0.001"],
		[0.0005, "~$0.001"],
		[0.0096, "~$0.010"],
		[0.423, "~$0.423"],
		[0.9994, "~$0.999"],
		[0.9996, "~$1.00"],
		[1, "~$1.00"],
		[2.5, "~$2.50"],
		[48.885, "~$48.89"],
		[99.999, "~$100.00"],
		[100, "~$100.00"],
		[1234.5, "~$1234.50"],
		[Number.NaN, ""],
		[Number.POSITIVE_INFINITY, ""],
		[-0.5, ""],
	] as const) assert.equal(formatCost(total), label, `${total}`);
});

test("formatRunDelta shows two decimals once the run has spent a printable cent", () => {
	for (const [delta, label] of [
		[0, ""], [0.004, ""], [0.005, "+$0.01"], [0.01, "+$0.01"], [1.24, "+$1.24"], [1.2449, "+$1.24"],
		[0.30000000000000004 - 0.3, ""], [123.456, "+$123.46"], [-1, ""], [Number.NaN, ""], [Number.POSITIVE_INFINITY, ""],
	] as const) assert.equal(formatRunDelta(delta), label, `${delta}`);
});

test("formatContextWindow is a compact denominator, omitted when the window is unknown", () => {
	for (const [window, label] of [
		[200_000, "200k"], [1_000_000, "1M"], [128_000, "128k"], [1_048_576, "1.05M"], [32_768, "32.8k"],
		[400_000, "400k"], [999_999, "1M"], [2_000_000, "2M"], [10_000_000, "10M"], [1500, "1.5k"], [512, "512"],
		[0, ""], [-1, ""], [Number.NaN, ""], [Number.POSITIVE_INFINITY, ""], [null, ""], [undefined, ""],
	] as const) assert.equal(formatContextWindow(window), label, `${window}`);
});

test("parsePersonaCost reads pi-persona's leftover-leg status with or without the estimate mark", () => {
	assert.equal(parsePersonaCost(undefined), 0);
	assert.equal(parsePersonaCost(""), 0);
	assert.equal(parsePersonaCost("$0.923"), 0.923);
	assert.equal(parsePersonaCost("~$0.923"), 0.923);
	assert.equal(parsePersonaCost(" ~$1.24 "), 1.24);
	assert.equal(parsePersonaCost("~1.92"), 1.92);
	assert.equal(parsePersonaCost("1.92"), 1.92);
	assert.equal(parsePersonaCost("~~$1"), 0);
	assert.equal(parsePersonaCost("$~1"), 0);
	assert.equal(parsePersonaCost("not a cost"), 0);
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

test("formatDuration picks the coarsest unit that still reads precisely", () => {
	const cases: Array<[number, string]> = [
		[0, "0ms"], [999, "999ms"], [1000, "1.0s"], [4210, "4.2s"], [9949, "9.9s"], [9950, "10s"],
		[59_499, "59s"], [59_500, "1m 00s"], [60_000, "1m 00s"], [61_000, "1m 01s"], [3_599_000, "59m 59s"],
		[3_600_000, "1h 00m"], [5_400_000, "1h 30m"],
	];
	for (const [ms, text] of cases) assert.equal(formatDuration(ms), text, String(ms));
	for (const ms of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(formatDuration(ms), "", String(ms));
});

test("formatElapsed counts whole seconds and never reads ahead of the clock", () => {
	const cases: Array<[number, string]> = [
		[0, "0s"], [999, "0s"], [1000, "1s"], [7_900, "7s"], [42_000, "42s"], [59_999, "59s"], [60_000, "1m 00s"],
		[65_000, "1m 05s"], [3_599_000, "59m 59s"], [3_599_999, "59m 59s"], [3_600_000, "1h 00m"], [3_720_000, "1h 02m"],
	];
	for (const [ms, text] of cases) assert.equal(formatElapsed(ms), text, String(ms));
	for (const ms of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(formatElapsed(ms), "", String(ms));
});

test("plural counts with a regular or explicit plural", () => {
	assert.equal(plural(0, "line"), "0 lines");
	assert.equal(plural(1, "line"), "1 line");
	assert.equal(plural(2, "line"), "2 lines");
	assert.equal(plural(1, "match", "matches"), "1 match");
	assert.equal(plural(3, "match", "matches"), "3 matches");
});

test("textOf and recordOf read foreign values defensively", () => {
	assert.equal(textOf("x"), "x");
	for (const value of [undefined, null, 1, {}, ["x"]]) assert.equal(textOf(value), "", JSON.stringify(value));
	const record = { a: 1 };
	assert.equal(recordOf(record), record, "a record is returned as is");
	const list = ["x"];
	assert.equal(recordOf(list), list as unknown, "arrays are objects too");
	for (const value of [undefined, null, 1, "x", true]) assert.deepEqual(recordOf(value), {}, JSON.stringify(value));
});

test("unpaired surrogates become the glyph the terminal would paint for them", () => {
	// Measured as zero columns but written as U+FFFD (one cell): left alone, each one
	// pushes a padded row one column past the terminal edge.
	assert.equal(sanitizeInlineText("a\udc00b"), "a\ufffdb");
	assert.equal(sanitizeInlineText("\ud83dlone high"), "\ufffdlone high");
	assert.equal(sanitizeInlineText("pair \ud83d\ude00 stays"), "pair \ud83d\ude00 stays");
	assert.equal(sanitizeArtLine("x\udfffy"), "x\ufffdy");
});

// Seeded corpus dense in escape-grammar bytes. The forbidden set below is written
// out independently of src so a weakened predicate there cannot pass here.
function corpus(seed: number, count: number): string[] {
	let s = seed >>> 0;
	const next = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), s | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const alphabet = [
		"\x1b", "\x1b", "[", "]", "P", "_", "^", "X", "\\", "\x07", "\x9c", "\x9b", "\x90", "\x98", "\x9d", "\x9e", "\x9f",
		"\x85", "\x7f", "\x00", "\x0b", "\x1f", "0", ";", "?", " ", "m", "H", "@", "~", "\n", "\r", "\t", "\u2028", "\u2029",
		"\u061c", "\u200e", "\u202e", "\u2066", "\u2069", "\ud800", "\udfff", "\ud83d\ude00", "\ud83d", "\ude00", "\u6f22", "a",
	];
	return Array.from({ length: count }, () =>
		Array.from({ length: Math.floor(next() * 24) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""));
}

function forbidden(text: string): number | undefined {
	for (let i = 0; i < text.length; i++) {
		const cu = text.charCodeAt(i);
		if (cu >= 0xd800 && cu <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
			i++;
			continue;
		}
		if (cu >= 0xd800 && cu <= 0xdfff) return cu;
		if (cu < 0x20 || (cu >= 0x7f && cu <= 0x9f) || cu === 0x061c || cu === 0x200e || cu === 0x200f ||
			(cu >= 0x202a && cu <= 0x202e) || (cu >= 0x2066 && cu <= 0x2069) || cu === 0x2028 || cu === 0x2029) return cu;
	}
	return undefined;
}

// Terminated forms of every sequence kind, each consumed whole by the grammar.
const TERMINATED_SEQUENCES = [
	"\x1b[1;31m", "\x1b[?25h", "\x9b2J", "\x1b]0;title\x07", "\x1b]8;;u\x9c", "\x1b]2;t\x1b\\", "\x1b_Ga=T\x1b\\",
	"\x1bP+q\x1b\\", "\x1b^pm\x07", "\x1bXsos\x9c", "\x90dcs\x9c", "\x98sos\x07", "\x9d0;t\x1b\\", "\x9eapc\x9c", "\x9fpm\x07",
	"\x1b7", "\x1bc", "\x1b]x\x1b\x1b\\", "\x1b]x\x1b\x07", "\x1b[3~", "\x1b[2@",
];

test("inline and art sanitizers never emit a control, bidi override or unpaired surrogate, and are idempotent", () => {
	for (const input of corpus(1337, 20_000)) {
		for (const sanitize of [sanitizeInlineText, sanitizeArtLine]) {
			const once = sanitize(input);
			assert.equal(forbidden(once), undefined, `${sanitize.name} ${JSON.stringify(input)} -> ${JSON.stringify(once)}`);
			assert.equal(sanitize(once), once, `${sanitize.name} is idempotent on ${JSON.stringify(input)}`);
		}
	}
});

test("printable text between terminated sequences survives in order", () => {
	const tokens = ["alpha", "\u6f22\u5b57", "\ud83d\udc4d\ud83c\udffd", "x9", "\u00e9", "[", "]", "\\", "P_^X", "end"];
	let s = 7;
	const pick = <T>(xs: readonly T[]) => xs[((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) % xs.length];
	for (let round = 0; round < 2000; round++) {
		let input = "";
		let expected = "";
		for (let k = 0; k < 12; k++) {
			const token = pick(tokens);
			input += pick(TERMINATED_SEQUENCES) + token;
			expected += token;
		}
		assert.equal(sanitizeInlineText(input), expected, JSON.stringify(input));
		assert.equal(sanitizeArtLine(input), expected, JSON.stringify(input));
	}
});

test("one escape grammar: each terminator form ends its sequence exactly", () => {
	assert.equal(skipTerminalSequence("plain", 0), 0, "no sequence starts at a printable");
	assert.equal(skipTerminalSequence("a\x1b[31mb", 1), 6, "CSI ends after its final byte");
	assert.equal(skipTerminalSequence("\x9b31mb", 0), 4, "C1 CSI");
	assert.equal(skipTerminalSequence("\x1b]0;t\x07b", 0), 6, "OSC ended by BEL");
	assert.equal(skipTerminalSequence("\x1b]0;t\x9cb", 0), 6, "OSC ended by C1 ST");
	assert.equal(skipTerminalSequence("\x1b]0;t\x1b\\b", 0), 7, "OSC ended by ESC \\");
	assert.equal(skipTerminalSequence("\x1b]0;evil", 0), 8, "an unterminated string owns the rest");
	assert.equal(skipTerminalSequence("\x1b[1\n2m", 0), 6, "a newline does not end a CSI");
	assert.equal(skipTerminalSequence("\x1b", 0), 1, "ESC at the end");
	assert.equal(skipTerminalSequence("\x1b\x1b[", 0), 2, "ESC ESC is one two-char escape");
	assert.equal(skipTerminalSequence("\x1b\ud83d\ude00b", 0), 3, "ESC drops a whole astral code point");
	assert.equal(sanitizeInlineText("a\x1b]0;evil"), "a");
	assert.equal(sanitizeInlineText("a\x1b[1\n2mb"), "ab");
	assert.equal(sanitizeInlineText("a\x1b\x1b[31mb"), "a[31mb");
	assert.equal(sanitizeInlineText("a\x1b]x\x1b\x1b\\b"), "ab", "ESC ESC \\ inside a string still terminates it");
	assert.equal(sanitizeInlineText("a\x1b]x\x1b\x07b"), "ab", "BEL after a stray ESC inside a string terminates it");
});

test("ESC before an astral character drops the whole character, not half a surrogate pair", () => {
	// Resolved disagreement: this scanner used to drop ESC + high surrogate and paint
	// the orphaned low surrogate as U+FFFD; the tool-output scanner dropped both.
	assert.equal(sanitizeInlineText("a\x1b\ud83d\ude00b"), "ab");
	assert.equal(sanitizeArtLine("a\x1b\ud83d\udc4d\ud83c\udffdb"), "a\ud83c\udffdb", "only the code point right after ESC is consumed");
	assert.equal(sanitizeInlineText("a\x1b\udc00b"), "ab", "a lone surrogate after ESC is still one code point");
});

test("code points are paired by hand, so a pair split by a slice is never read as whole", () => {
	assert.equal(codePointAtIndex("a", 0), 0x61);
	assert.equal(codePointAtIndex("\u{1F600}", 0), 0x1f600);
	assert.equal(codePointAtIndex("\u{1F600}", 1), 0xde00, "a low half read on its own is itself");
	assert.equal(codePointAtIndex("x\ud83d", 1), 0xd83d, "a high half at the end is itself");
	assert.equal(codePointAtIndex("\ud83dx", 0), 0xd83d, "a high half before a non-surrogate is itself");
	assert.ok(Number.isNaN(codePointAtIndex("", 0)));
	// The sanitizers must never go back to String.prototype.codePointAt: on Node 26.3 V8's
	// Maglev tier answers it, for a sliced string ending on a high surrogate, with the astral
	// code point of the pair in the parent string — and the raw half got through. Whether a
	// given loop gets that tier is up to the engine, so the source is the reliable guard.
	for (const file of ["format.ts", "tool-view.ts"]) {
		const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /\.codePointAt\(/, `${file} reads a code point without pairing it`);
	}
});

test("a surrogate pair split by a slice never leaks its raw half", () => {
	// The hot loop gives the engine every chance to compile the scan (see the test above).
	const parent = `${"x".repeat(20)}\u{1F600}tail`;
	let leaked = 0;
	for (let n = 0; n < 150_000; n++) {
		const cut = parent.slice(n % 3, 21); // always ends on the pair's high half
		if (sanitizeInlineText(cut).charCodeAt(cut.length - 1) !== 0xfffd) leaked++;
		if (!sanitizeArtLine(cut).endsWith("\ufffd")) leaked++;
	}
	assert.equal(leaked, 0);
});

test("pi-persona's background status parses to counts: four keys, fixed order, positive integers", () => {
	assert.deepEqual(parseBackgroundStatus("agents=3 monitors=1 timers=1 scripts=1"), { agents: 3, monitors: 1, timers: 1, scripts: 1 });
	assert.deepEqual(parseBackgroundStatus("timers=1"), { agents: 0, monitors: 0, timers: 1, scripts: 0 });
	assert.deepEqual(parseBackgroundStatus("agents=12 scripts=2"), { agents: 12, monitors: 0, timers: 0, scripts: 2 }, "omitted kinds are zero");
	assert.deepEqual(parseBackgroundStatus(`monitors=${MAX_BACKGROUND_COUNT}`), { agents: 0, monitors: MAX_BACKGROUND_COUNT, timers: 0, scripts: 0 });
});

test("anything else in the background status is no background work at all", () => {
	for (const bad of [
		undefined, null, 3, {}, ["agents=3"], "",
		" ", "agents=3 ", " agents=3", "agents=3  timers=1", "agents=3\ttimers=1", "agents=3\n", "agents=3\nmonitors=1", "agents=3,timers=1",
		"agents=0", "agents=03", "agents=-1", "agents=+1", "agents=1.5", "agents=1e3", "agents=", "agents", "=3", "agents=\uff13", "agents=3x",
		`agents=${MAX_BACKGROUND_COUNT + 1}`, "agents=99999999999999999999",
		"monitors=1 agents=3", "scripts=1 timers=1", "agents=1 agents=2", "timers=1 timers=1",
		"Agents=3", "agent=3", "tasks=3", "agents=3 tasks=1", "constructor=1", "__proto__=1", "toString=1",
		"agents=3 monitors=1 timers=1 scripts=1 agents=1",
		"agents=3 \u001b[31mtimers=1", "\u001b]0;pwned\u0007agents=3", "agents=3\u202e", "3 agents running",
		`agents=3${" ".repeat(100)}`, "agents=3".padEnd(100_000, "x"),
	]) assert.equal(parseBackgroundStatus(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
	// Bounded before any scan: a megabyte of status costs nothing.
	const started = performance.now();
	assert.equal(parseBackgroundStatus("agents=1 ".repeat(500_000)), undefined);
	assert.ok(performance.now() - started < 50);
});

test("background work reads back from stored JSON only when every count is whole, bounded and one is positive", () => {
	assert.deepEqual(backgroundWorkOf({ agents: 3, monitors: 1, timers: 1, scripts: 1 }), { agents: 3, monitors: 1, timers: 1, scripts: 1 });
	assert.deepEqual(backgroundWorkOf({ agents: 0, monitors: 0, timers: 2, scripts: 0, extra: "ignored" }), { agents: 0, monitors: 0, timers: 2, scripts: 0 });
	const inherited = Object.create({ agents: 1, monitors: 0, timers: 0, scripts: 0 });
	for (const bad of [
		undefined, null, "agents=3", 3, [], [1, 0, 0, 0], {}, inherited,
		{ agents: 0, monitors: 0, timers: 0, scripts: 0 }, { agents: 3 }, { agents: 3, monitors: 1, timers: 1 },
		{ agents: "3", monitors: 0, timers: 0, scripts: 0 }, { agents: 1.5, monitors: 0, timers: 0, scripts: 0 },
		{ agents: -1, monitors: 2, timers: 0, scripts: 0 }, { agents: MAX_BACKGROUND_COUNT + 1, monitors: 0, timers: 0, scripts: 0 },
		{ agents: Number.NaN, monitors: 0, timers: 0, scripts: 0 }, { agents: Number.POSITIVE_INFINITY, monitors: 0, timers: 0, scripts: 0 },
	]) assert.equal(backgroundWorkOf(bad), undefined, JSON.stringify(bad));
});

test("background work is spelled per kind with its plural, or as one count when several kinds run", () => {
	const work = (agents: number, monitors: number, timers: number, scripts: number) => ({ agents, monitors, timers, scripts });
	assert.equal(backgroundDetail(work(3, 1, 1, 1)), "3 agents, 1 monitor, 1 timer, 1 script");
	assert.equal(backgroundDetail(work(1, 2, 2, 2)), "1 agent, 2 monitors, 2 timers, 2 scripts");
	assert.equal(backgroundDetail(work(0, 0, 1, 0)), "1 timer", "zero kinds are left out");
	assert.equal(backgroundSummary(work(3, 0, 0, 0)), "3 agents");
	assert.equal(backgroundSummary(work(1, 0, 0, 0)), "1 agent");
	assert.equal(backgroundSummary(work(0, 1, 0, 0)), "1 monitor");
	assert.equal(backgroundSummary(work(0, 0, 4, 0)), "4 timers");
	assert.equal(backgroundSummary(work(0, 0, 0, 1)), "1 script");
	assert.equal(backgroundSummary(work(3, 1, 1, 0)), "5 background tasks", "several kinds are counted together");
	assert.equal(backgroundSummary(work(1, 0, 0, 1)), "2 background tasks");
});
