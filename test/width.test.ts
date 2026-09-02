import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi, truncateToWidth, useTerminalMetrics, visibleWidth } from "../src/width.ts";

const RED = "\x1b[38;2;255;0;0m";
const RST = "\x1b[39m";

// Built from code points so the source carries no invisible joiners/selectors.
const ZWJ = String.fromCodePoint(0x200d); // zero-width joiner
const VS16 = String.fromCodePoint(0xfe0f); // emoji-presentation selector
const ACUTE = String.fromCodePoint(0x0301); // combining acute accent
const TARGET = String.fromCodePoint(0x1f3af); // 🎯 bullseye
const DEV = String.fromCodePoint(0x1f468) + ZWJ + String.fromCodePoint(0x1f4bb); // 👨‍💻 (ZWJ sequence)
const FLAG = String.fromCodePoint(0x1f1fa, 0x1f1f8); // 🇺🇸 regional-indicator pair
const UPARROW = String.fromCodePoint(0x2b06) + VS16; // ⬆️ arrow + VS16 emoji presentation

test("visibleWidth ignores ANSI SGR escapes", () => {
	assert.equal(visibleWidth(`${RED}hello${RST}`), 5);
	assert.equal(stripAnsi(`${RED}hello${RST}`), "hello");
});

test("visibleWidth counts emoji and CJK as width 2", () => {
	assert.equal(visibleWidth(TARGET), 2);
	assert.equal(visibleWidth("世界"), 4); // CJK
	assert.equal(visibleWidth("ab"), 2);
});

test("visibleWidth keeps text-presentation dingbats narrow, like pi-tui's RGI test", () => {
	// U+2713/U+2717 sit inside the 0x2600–0x27bf block but are NOT RGI emoji —
	// terminals (and pi-tui's graphemeWidth) render them one column wide.
	// Blanket-widening the block once pulled the frame's right rail in by one
	// column for every ✓ in a status label.
	assert.equal(visibleWidth("✓"), 1); // U+2713 check mark
	assert.equal(visibleWidth("✗"), 1); // U+2717 ballot X
	assert.equal(visibleWidth("✦"), 1); // U+2726 four-pointed star
	assert.equal(visibleWidth("⚡"), 2); // U+26A1 IS an RGI emoji — stays wide
	assert.equal(visibleWidth("✓ ok"), 4);
});

test("truncateToWidth shortens to the column budget and resets color", () => {
	const out = truncateToWidth("abcdefgh", 5);
	assert.equal(visibleWidth(out), 5); // 4 chars + ellipsis
	assert.ok(out.endsWith(`…${RST}`));
	assert.equal(truncateToWidth("abc", 10), "abc"); // already fits → untouched
});

test("visibleWidth measures ZWJ/flag/combining sequences as single grapheme clusters", () => {
	assert.equal(visibleWidth(DEV), 2); // man-technologist ZWJ sequence
	assert.equal(visibleWidth(FLAG), 2); // regional-indicator flag pair
	assert.equal(visibleWidth("caf" + "e" + ACUTE), 4); // NFD café: combining acute is zero-width
	assert.equal(visibleWidth(UPARROW), 2); // VS16 forces width-2 emoji presentation
});

test("visibleWidth zero-widths lone combining marks and joiners", () => {
	assert.equal(visibleWidth(ACUTE), 0); // lone combining acute (no base char)
	assert.equal(visibleWidth(ZWJ), 0); // lone zero-width joiner
	assert.equal(visibleWidth("a" + ACUTE), 1); // base + combining acute = one column
});

test("truncateToWidth never splits a ZWJ emoji cluster", () => {
	const out = truncateToWidth(`${DEV}abc`, 3); // budget 2 after the ellipsis
	assert.ok(out.startsWith(DEV)); // the emoji is kept whole, not cut mid-sequence
	assert.equal(visibleWidth(out), 3); // emoji (2) + ellipsis (1)
});

// pi-tui's hardware-cursor marker (tui.js CURSOR_MARKER): an APC sequence
// terminated by BEL, not ST. It rides inside the editor's cursor line and the
// TUI strips it at composite time — so it must measure as zero columns here,
// or the frame under-pads the cursor row and the right rail pulls in.
const CURSOR_MARKER = "\x1b_pi:c\x07";

test("visibleWidth zero-widths pi-tui's BEL-terminated APC cursor marker", () => {
	assert.equal(visibleWidth(CURSOR_MARKER), 0);
	assert.equal(visibleWidth(` ${CURSOR_MARKER}${" ".repeat(71)}`), 72); // empty-editor cursor line
	assert.equal(visibleWidth(`a${CURSOR_MARKER}b`), 2);
	assert.equal(stripAnsi(`a${CURSOR_MARKER}b`), "ab");
	assert.equal(visibleWidth("\x1b_pi:c\x1b\\"), 0); // ST-terminated APC still matches too
});

test("truncateToWidth passes the cursor marker through without spending budget", () => {
	const out = truncateToWidth(`${CURSOR_MARKER}abcdefgh`, 5);
	assert.ok(out.startsWith(CURSOR_MARKER)); // marker preserved — the TUI needs it to place the cursor
	assert.equal(visibleWidth(out), 5);
});

// Regression: the fallback used to under-measure these, so the frame padded past
// the terminal edge, the row wrapped, and pi's differential renderer lost a row —
// leaving a stale piece of border above the box (pi throws on the over-wide line
// when the same thing happens on a differential repaint).
//
// The expected values are current pi-tui's `graphemeWidth` answers. Older bundles
// disagree on the spacing-mark rows (0.83.0 reads "का" as 1, not 2) — which is
// fine, and the reason the direction matters more than the number: over-measuring
// only makes the right rail sit a column short, while under-measuring wraps the
// row and desynchronizes the renderer. Production never depends on either, since
// `useTerminalMetrics` installs the host's own ruler at load time.
test("visibleWidth matches pi-tui on the clusters the mirror used to under-count", () => {
	assert.equal(visibleWidth("\t"), 3); // pi-tui lays a tab out as three columns
	assert.equal(visibleWidth("a\tb"), 5);
	assert.equal(visibleWidth("का"), 2); // devanagari ka + spacing mark AA
	assert.equal(visibleWidth("नि"), 2); // na + spacing mark I
	assert.equal(visibleWidth("မြ"), 2); // burmese ma + medial ra
	assert.equal(visibleWidth("ာ"), 1); // lone burmese vowel AA takes a cell
	assert.equal(visibleWidth("\u{17000}"), 2); // tangut ideograph
	assert.equal(visibleWidth("\u{1B000}"), 2); // kana supplement
	assert.equal(visibleWidth("︐"), 2); // vertical form comma
	assert.equal(visibleWidth("䷀"), 2); // yijing hexagram
	assert.equal(visibleWidth("〿"), 1); // ideographic half-fill space is narrow
});

test("stripAnsi drops non-SGR CSI sequences instead of counting them as text", () => {
	assert.equal(stripAnsi("a\x1b[2Kb"), "ab");
	assert.equal(visibleWidth("a\x1b[2Kb"), 2);
	assert.equal(visibleWidth("a\x1b[5Gb"), 2);
});

test("useTerminalMetrics swaps in the host's measurement and restores the fallback", () => {
	try {
		useTerminalMetrics({ visibleWidth: () => 42 });
		assert.equal(visibleWidth("anything"), 42);
		assert.equal(stripAnsi(`${RED}hello${RST}`), "hello"); // unset members keep the fallback
	} finally {
		useTerminalMetrics();
	}
	assert.equal(visibleWidth("anything"), 8);
});
