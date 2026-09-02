/**
 * Terminal-width helpers for width-aware TUI rendering.
 *
 * The frame is built from fixed-width rows: every row must measure *exactly* the
 * same number of columns as pi-tui lays out, or the right rail drifts — and a row
 * one column too wide wraps, which desynchronizes pi's differential renderer and
 * leaves stale chrome on screen (pi even throws on an over-wide line).
 *
 * So measurement is never guessed: `index.ts` installs pi-tui's own
 * `visibleWidth` / `truncateToWidth` through `useTerminalMetrics()` at load
 * time, and the render modules go through the thin wrappers below. That also
 * makes the frame correct across pi-tui versions that measure differently from
 * each other — the box agrees with whatever ruler the host is painting with.
 *
 * The built-in implementation that follows is a dependency-free fallback: it
 * keeps the pure modules unit-testable with nothing but `node --test`, and it
 * mirrors pi-tui's `graphemeWidth` rules (tab = 3 columns, terminal spacing
 * marks add a cell, RGI emoji are wide, East-Asian Wide/Fullwidth are wide).
 * Production never relies on it being perfect — and where it is uncertain it
 * should round *up*: over-measuring only makes the right rail sit a column
 * short, while under-measuring wraps the row and desynchronizes the renderer.
 */

/** The measurement primitives the render modules need. */
export interface TerminalMetrics {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, max: number, ellipsis?: string): string;
	stripAnsi(text: string): string;
}

// ANSI escapes consumed for measurement: CSI (styling and cursor codes), OSC
// (incl. OSC-8 links), APC (the TUI's cursor marker). Matching all three keeps
// measurement in parity with what pi-tui emits, so an escape is never counted as
// a printable column. APC accepts both terminators — pi-tui's CURSOR_MARKER
// (`\x1b_pi:c\x07`) ends in BEL, not ST; miscounting it once pulled the cursor
// row's right rail in by 5.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// The same set anchored at the start of a string (for streaming truncation).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI_HEAD = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/;

const VS16 = String.fromCodePoint(0xfe0f); // emoji-presentation variation selector
// Mirror pi-tui's `graphemeWidth` classification (packages/tui/src/utils.ts).
const ZERO_WIDTH = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Mark}\p{Surrogate}]+$/v;
const LEADING_NONPRINT = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const NONPRINT = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const MARK = /^\p{Mark}$/v;
// Marks a terminal allocates a cell for: Unicode spacing marks (minus three that
// terminals draw as combining) plus the non-spacing exceptions legacy wcwidth
// tables treat as advancing. Verbatim from pi-tui's `terminalSpacingMarkRegex`.
const SPACING_MARK =
	/^(?:[\p{Spacing_Mark}--[᜴〮〯]]|[ٟཿါာေဳ-ဵး်-ှ])+$/v;
// Only true RGI emoji are wide — NOT everything in the pictograph blocks. Text-
// presentation dingbats (✓ ✗ ✦ …) live in 0x2600–0x27bf but render one column;
// blanket-widening the block once pulled the frame's right rail in per ✓.
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TAB_WIDTH = 3; // pi-tui lays a literal tab out as three columns

/** East-Asian Wide/Fullwidth code point ranges (the Unicode W + F sets). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x2e80, 0x303e], // CJK radicals … ideographic marks (0x303f is narrow)
	[0x3041, 0x33ff],
	[0x3400, 0x9fff], // CJK ext A, Yijing hexagrams, CJK unified
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3], // Hangul syllables
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19], // vertical forms
	[0xfe30, 0xfe52],
	[0xfe54, 0xfe66],
	[0xfe68, 0xfe6b],
	[0xff01, 0xff60], // fullwidth forms
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x16ff0, 0x16ff1],
	[0x17000, 0x18cd5], // Tangut, Khitan
	[0x18d00, 0x18d08],
	[0x1aff0, 0x1affe],
	[0x1b000, 0x1b2fb], // Kana supplement / extended, Nushu
	[0x1f200, 0x1f251],
	[0x20000, 0x3fffd], // CJK extensions
];

/** Cheap pre-filter before the RGI_Emoji regex — same block heuristic as pi-tui. */
function couldBeEmoji(cluster: string): boolean {
	const cp = cluster.codePointAt(0) ?? 0;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // emoji & pictographs
		(cp >= 0x2300 && cp <= 0x23ff) || // misc technical (⌚ ⏰ …)
		(cp >= 0x2600 && cp <= 0x27bf) || // misc symbols, dingbats
		(cp >= 0x2b50 && cp <= 0x2b55) || // stars/circles
		cluster.includes(VS16) ||
		cluster.length > 2 // ZWJ sequences, skin tones, flags
	);
}

/** East-Asian Wide/Fullwidth test for a single code point. */
function isWide(cp: number): boolean {
	for (const [lo, hi] of WIDE_RANGES) {
		if (cp < lo) return false; // ranges are sorted
		if (cp <= hi) return true;
	}
	return false;
}

/** Terminal column width of one grapheme cluster, mirroring pi-tui's graphemeWidth. */
function clusterWidth(cluster: string): number {
	if (cluster === "\t") return TAB_WIDTH;
	if (SPACING_MARK.test(cluster)) return [...cluster].length; // marks that stand on their own cells
	if (ZERO_WIDTH.test(cluster)) return 0; // combining marks / format / control only
	if (couldBeEmoji(cluster) && RGI_EMOJI.test(cluster)) return 2; // real emoji only
	const base = cluster.replace(LEADING_NONPRINT, ""); // skip leading joiners/marks
	const cp = base.codePointAt(0);
	if (cp === undefined) return 0; // joiner-only cluster (e.g. a lone ZWJ)
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2; // lone regional indicator (streaming)
	let width = isWide(cp) ? 2 : 1;
	// Intl.Segmenter can fold several cell-taking code points into one cluster
	// (Indic consonants after a mark, halfwidth/fullwidth forms, Thai/Lao AM).
	let followsMark = false;
	for (const char of [...base].slice(1)) {
		if (SPACING_MARK.test(char)) {
			width += 1;
			followsMark = false;
		} else if (MARK.test(char)) {
			followsMark = true;
		} else if (!NONPRINT.test(char)) {
			const c = char.codePointAt(0) ?? 0;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) width += isWide(c) ? 2 : 1;
			else if (c === 0x0e33 || c === 0x0eb3) width += 1;
			followsMark = false;
		}
	}
	return width;
}

function stripSequences(text: string): string {
	return text.replace(ANSI, "");
}

/** Printable column width of `text`, ignoring ANSI escapes; grapheme-aware. */
function measureWidth(text: string): number {
	let width = 0;
	for (const { segment } of SEGMENTER.segment(stripSequences(text))) width += clusterWidth(segment);
	return width;
}

/**
 * Truncate `text` to at most `max` printable columns, appending `ellipsis`.
 * ANSI escapes are copied through verbatim (zero width); advancing is
 * grapheme-aware, so truncation never splits an emoji/ZWJ cluster mid-sequence.
 * A trailing foreground reset is added so truncation never bleeds color forward.
 */
function clipToWidth(text: string, max: number, ellipsis = "…"): string {
	if (max <= 0) return "";
	if (measureWidth(text) <= max) return text;
	const budget = Math.max(0, max - measureWidth(ellipsis));
	let out = "";
	let width = 0;
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);
		const esc = rest.match(ANSI_HEAD);
		if (esc) {
			out += esc[0];
			i += esc[0].length;
			continue;
		}
		const cluster = SEGMENTER.segment(rest)[Symbol.iterator]().next().value?.segment ?? rest[0];
		const cw = clusterWidth(cluster);
		if (width + cw > budget) break;
		out += cluster;
		width += cw;
		i += cluster.length;
	}
	return `${out}${ellipsis}\x1b[39m`;
}

const BUILTIN: TerminalMetrics = {
	visibleWidth: measureWidth,
	truncateToWidth: clipToWidth,
	stripAnsi: stripSequences,
};

let metrics: TerminalMetrics = BUILTIN;

/**
 * Install the terminal's real measurement primitives (pi-tui's). Called once by
 * `index.ts`; passing nothing restores the built-in fallback (used by tests).
 */
export function useTerminalMetrics(next?: Partial<TerminalMetrics>): void {
	// Drop absent members instead of spreading them: pi-tui's export surface moves, and an
	// import that has become `undefined` would otherwise overwrite a working built-in with it
	// and only surface as "not a function" on the first render.
	const supplied = Object.fromEntries(Object.entries(next ?? {}).filter(([, fn]) => typeof fn === "function"));
	metrics = { ...BUILTIN, ...supplied };
}

export function visibleWidth(text: string): number {
	return metrics.visibleWidth(text);
}

export function truncateToWidth(text: string, max: number, ellipsis = "…"): string {
	return metrics.truncateToWidth(text, max, ellipsis);
}

export function stripAnsi(text: string): string {
	return metrics.stripAnsi(text);
}

/**
 * Pure box geometry shared by `FramedEditor.render`. From the terminal `width`,
 * the cap `maxWidth`, and the side `minMargin`, decide the outer box width, the
 * centering left margin, and whether the terminal is simply too narrow to frame
 * (`fallback` — render the bare editor instead).
 */
export interface BoxGeometry {
	fallback: boolean;
	boxWidth: number;
	leftMargin: number;
}

export function chooseBox(width: number, maxWidth: number, minMargin: number): BoxGeometry {
	let boxWidth = Math.min(maxWidth, width - 2 * minMargin);
	if (boxWidth < 24) boxWidth = Math.min(Math.max(1, width - 2), maxWidth); // narrow: trade margin for width
	if (width < 8 || boxWidth < 6) return { fallback: true, boxWidth, leftMargin: 0 };
	return { fallback: false, boxWidth, leftMargin: Math.max(0, Math.floor((width - boxWidth) / 2)) };
}
