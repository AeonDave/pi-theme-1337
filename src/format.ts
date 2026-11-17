/** Small, pure formatters shared by the frame and its status row. */

const INLINE_LIMIT = 512;
const ART_LINE_LIMIT = 2048;
const INLINE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isBidiControl(codePoint: number): boolean {
	return (
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

/**
 * The one list of code points that must never be written raw: C0, DEL, C1, and
 * bidi controls. Callers decide whether to drop, map or spell them; whitespace
 * among them (tab, CR, NEL) is each caller's policy and must be checked first.
 */
export function isUnsafeCodePoint(codePoint: number): boolean {
	return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) || isBidiControl(codePoint);
}

/** LS / PS: some hosts break the row on them, so the measured line is not the painted one. */
export function isLineSeparator(codePoint: number): boolean {
	return codePoint === 0x2028 || codePoint === 0x2029;
}

/**
 * The code point at `index`, pairing surrogates by hand: a surrogate that is not
 * half of a well-formed pair comes back as itself. `String.prototype.codePointAt`
 * is not used on purpose — V8's Maglev tier (Node 26.3) has returned the full
 * astral code point for a sliced string ending on a high surrogate whose low
 * half lies just past the slice, which let an unpaired surrogate through.
 */
export function codePointAtIndex(text: string, index: number): number {
	const high = text.charCodeAt(index);
	if (high >= 0xd800 && high <= 0xdbff && index + 1 < text.length) {
		const low = text.charCodeAt(index + 1);
		if (low >= 0xdc00 && low <= 0xdfff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
	}
	return high;
}

/** A surrogate code unit returned by `codePointAtIndex` is unpaired: measured as 0 columns, painted as 1. */
export function isLoneSurrogate(codePoint: number): boolean {
	return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/**
 * The terminal escape grammar, shared by every sanitizer: returns the index after
 * the control sequence that starts at `index`, or `index` itself when none does.
 * CSI (ESC [ / 0x9b) runs to its final byte; OSC/DCS/APC/PM/SOS (ESC ] P _ ^ X or
 * their C1 forms) run to BEL, ST or ESC \; anything unterminated owns the rest of
 * the text. Any other ESC drops the whole following code point, never half a
 * surrogate pair. Linear, allocation-free.
 */
export function skipTerminalSequence(text: string, index: number): number {
	const code = text.charCodeAt(index);
	if (code === 0x1b) {
		const kind = text.charCodeAt(index + 1);
		if (kind === 0x5b) return skipCsi(text, index + 2);
		if (kind === 0x5d || kind === 0x50 || kind === 0x5f || kind === 0x5e || kind === 0x58) {
			return skipControlString(text, index + 2);
		}
		if (index + 1 >= text.length) return index + 1;
		// two-char escape; dropping both is safer than exposing its final
		return index + 1 + (codePointAtIndex(text, index + 1) > 0xffff ? 2 : 1);
	}
	if (code === 0x9b) return skipCsi(text, index + 1);
	if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
		return skipControlString(text, index + 1);
	}
	return index;
}

function skipControlString(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 0x07 || code === 0x9c) return i + 1; // BEL / C1 ST
		if (code === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2; // ESC \\
		i++;
	}
	return text.length; // an unterminated control string owns the remaining bytes
}

function skipCsi(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const code = text.charCodeAt(i++);
		if (code >= 0x40 && code <= 0x7e) break; // final byte
	}
	return i;
}

/**
 * Make foreign text safe for one terminal row. This is a bounded, linear scan:
 * terminal control sequences (including unterminated OSC/APC/DCS), C0/C1
 * controls, and bidi overrides are removed; whitespace is folded to one space.
 * It deliberately preserves emoji selectors/joiners for `stableEmojiWidth` to
 * resolve at grapheme level afterwards.
 */
function sanitizeTerminalText(value: string, limit: number, preserveSpaces: boolean): string {
	let output = "";
	let emitted = 0;
	let pendingSpace = false;
	let i = 0;
	while (i < value.length && emitted < limit) {
		const next = skipTerminalSequence(value, i);
		if (next !== i) {
			i = next;
			continue;
		}
		const codePoint = codePointAtIndex(value, i);
		const size = codePoint > 0xffff ? 2 : 1;

		// An unpaired surrogate measures zero columns yet is written to the terminal
		// as U+FFFD, one cell: make it that glyph here so the measured row is the painted one.
		const char = isLoneSurrogate(codePoint) ? "\ufffd" : value.slice(i, i + size);
		i += size;
		if (/\p{White_Space}/v.test(char)) {
			if (preserveSpaces) {
				// Keep intentional ASCII-art padding exactly; fold a CRLF, tab, or
				// other row-breaking whitespace run to one ordinary terminal cell.
				if (char === " " || !output.endsWith(" ")) {
					output += " ";
					emitted++;
				}
			} else {
				pendingSpace = output.length > 0;
			}
			continue;
		}
		if (isUnsafeCodePoint(codePoint)) continue;
		if (pendingSpace && emitted < limit) {
			output += " ";
			emitted++;
			pendingSpace = false;
		}
		if (emitted < limit) {
			output += char;
			emitted++;
		}
	}
	return preserveSpaces ? output : output.trim();
}

export function sanitizeInlineText(value: string): string {
	return sanitizeTerminalText(value, INLINE_LIMIT, false);
}

/** Preserve intentional ASCII-art padding while removing terminal controls. */
export function sanitizeArtLine(value: string): string {
	return sanitizeTerminalText(value, ART_LINE_LIMIT, true);
}

/**
 * Shorten a path to `~/…/<last two segments>`, normalizing Windows slashes; the
 * ellipsis appears only when it stands for omitted segments.
 *
 * The home prefix is matched on normalized segments, not raw text: a `HOME` with
 * a trailing separator used to eat the one after `~` (`~Desktop/ctf`), and a
 * Windows shell that reports `C:\users\me\…` while `USERPROFILE` says
 * `C:\Users\me` missed the match entirely and showed the bare `…/desktop/ctf`.
 * Matching is case-insensitive on Windows only, where the filesystem is, and
 * requires a segment boundary so `/home/mario2` is not read as inside `/home/mario`.
 */
export function shortCwd(cwd: string): string {
	const toUnix = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const unixCwd = sanitizeInlineText(cwd).replace(/\\/g, "/");
	const home = toUnix(process.env.HOME || process.env.USERPROFILE || "");
	const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	const body = toUnix(unixCwd);
	const inHome = home !== "" && (fold(body) === fold(home) || fold(body).startsWith(`${fold(home)}/`));
	const unix = inHome ? `~${body.slice(home.length)}` : unixCwd;
	// `~` is an anchor, not a segment: `~/src/project` omits nothing, and an
	// ellipsis there would only make the label longer.
	const segments = (inHome ? unix.slice(1) : unix).split("/").filter(Boolean);
	if (segments.length <= 2) return unix;
	const lead = unix.startsWith("~") ? "~/" : unix.startsWith("/") ? "/" : "";
	return `${lead}…/${segments.slice(-2).join("/")}`;
}

/** Trim the recognizable model id for a calmer label (`claude-opus-4-8` → `opus-4-8`). */
export function cleanModel(id: string | undefined): string {
	if (!id) return "no model";
	return sanitizeInlineText(id).replace(/^claude-/, "");
}

/** Shape of Pi's `ctx.getContextUsage()` (kept local so this module stays pure). */
export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Compact token count: 500 → "500", 12345 → "12.3k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Elapsed time the way people read it: "850ms", "4.2s", "42s", "1m 05s", "1h 02m".
 * Non-finite or negative input yields "".
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
	// A finished duration rounds to the nearest second; formatElapsed only floors.
	return formatElapsed(Math.round(ms / 1000) * 1000);
}

/**
 * A live counter in whole seconds: "7s", "42s", "1m 05s", "1h 02m". Floored, so
 * it never reads ahead of the clock. Non-finite or negative input yields "".
 */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "1 file" / "3 files" — `many` defaults to `one` + "s". */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** Foreign values (tool arguments, results) read as text: non-strings become "". */
export function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Foreign values read as a record: anything that is not a non-null object becomes `{}`. */
export function recordOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * The git-branch suffix for the status row's workspace segment: " · main", or
 * "" when there's no branch to show (outside a repo, or footer data not yet
 * captured). Pi reports detached HEAD as the literal branch "detached".
 */
export function branchLabel(branch: string | null | undefined): string {
	const safe = branch ? sanitizeInlineText(branch) : "";
	return safe ? ` · ${safe}` : "";
}

/**
 * What submitting the buffer would do with a shell command: nothing ("none"),
 * run it and hand its output to the model ("context", a leading `!`), or run
 * it and keep the output out of the model's context ("excluded", a leading
 * `!!`).
 */
export type BashInputMode = "none" | "context" | "excluded";

/**
 * Pi's own bash-mode test, so the prompt sigil reacts as the host will: the
 * host ignores leading whitespace and looks at the first one or two characters
 * (`!!!x` runs `!x` excluded; a bare `!` is bash mode with nothing to run yet).
 */
export function bashInputMode(text: string): BashInputMode {
	const input = text.trimStart();
	if (!input.startsWith("!")) return "none";
	return input.startsWith("!!") ? "excluded" : "context";
}

export type UsageLevel = "normal" | "warn" | "critical";

/**
 * Escalation level for the context-usage label, matching Pi's footer
 * thresholds: warn above 70%, critical above 90% (auto-compact territory).
 */
export function usageLevel(percent: number | null | undefined): UsageLevel {
	if (percent == null) return "normal";
	// Judge the number the row prints (a whole percent), so the color and the
	// digits never disagree: a warning-colored "70%" would read as a mistake.
	const shown = Math.round(percent);
	if (shown > 90) return "critical";
	if (shown > 70) return "warn";
	return "normal";
}

/** Structural slice of a session entry — enough to sum costs without Pi imports. */
export interface SessionEntryLike {
	type: string;
	provider?: string;
	model?: string;
	message?: { role?: string; usage?: { cost?: { total?: unknown } } };
	usage?: { cost?: { total?: unknown } };
}

/**
 * Cumulative API-equivalent estimate from assistant/tool-result messages,
 * compaction, branch-summary, and Pi usage entries (the same usage sources Pi's
 * footer sums), plus pending persona usage. It is not an invoice: session history
 * does not establish actual billing across providers, subscriptions, or model
 * changes. Malformed, negative and non-finite values count as zero.
 */
export function costTotal(entries: Iterable<SessionEntryLike>, extraCost = 0): number {
	let total = 0;
	for (const entry of entries) {
		const messageUsage =
			entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
				? entry.message.usage
				: undefined;
		const summaryUsage =
			entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage" ? entry.usage : undefined;
		const value = (messageUsage ?? summaryUsage)?.cost?.total;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
	}
	if (typeof extraCost === "number" && Number.isFinite(extraCost) && extraCost > 0) total += extraCost;
	return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * The estimate's label: "~$0.423" below a dollar, "~$48.89" from one. The
 * decimals follow the ROUNDED value, so 0.9996 reads "~$1.00", not "~$1.000";
 * a positive total too small to print reads "~<$0.001" rather than a false
 * zero. Zero, negative and non-finite totals show nothing. Always marked `~`:
 * these are list-price estimates, never an assertion of actual billing.
 */
export function formatCost(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "";
	const mills = Math.round(total * 1000);
	if (mills === 0) return "~<$0.001";
	if (mills < 1000) return `~$${(mills / 1000).toFixed(3)}`;
	return `~$${(Math.round(total * 100) / 100).toFixed(2)}`;
}

/**
 * Spend since the current run began: "+$1.24", or "" until it prints at least
 * one cent (and for anything non-finite or negative).
 */
export function formatRunDelta(delta: number): string {
	if (!Number.isFinite(delta)) return "";
	const cents = Math.round(delta * 100);
	return cents >= 1 ? `+$${(cents / 100).toFixed(2)}` : "";
}

/**
 * Compact context window for the usage denominator, three significant digits
 * with trailing zeros dropped: 128000 → "128k", 1000000 → "1M", 1048576 →
 * "1.05M". Unknown, zero, negative or non-finite windows yield "".
 */
export function formatContextWindow(window: number | null | undefined): string {
	if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return "";
	if (window < 1000) return `${Math.round(window)}`;
	const k = Number((window / 1000).toPrecision(3));
	if (k < 1000) return `${k}k`;
	return `${Number((window / 1_000_000).toPrecision(3))}M`;
}

/**
 * Parse pi-persona's `persona-cost` status (leftover background-leg spend not yet
 * on a tool result). Accepts "~$0.923", "$0.923" or "0.923"; anything else is 0.
 */
export function parsePersonaCost(text: string | undefined): number {
	if (!text) return 0;
	const match = text.trim().match(/^~?\$?(\d+(?:\.\d+)?)/);
	if (!match) return 0;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** pi-persona's background work, by kind, in the order its status publishes them. */
export const BACKGROUND_KINDS = ["agents", "monitors", "timers", "scripts"] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];
/** How much is still running in the background, per kind; at least one count is positive. */
export type BackgroundWork = Readonly<Record<BackgroundKind, number>>;
/** No session runs more of one kind than this; a larger number is not a count we print. */
export const MAX_BACKGROUND_COUNT = 9999;
/** The longest well-formed status is 50 characters; nothing longer is scanned at all. */
const BACKGROUND_STATUS_LIMIT = 64;
const BACKGROUND_PAIR = /^(agents|monitors|timers|scripts)=([1-9]\d{0,3})$/;
const BACKGROUND_NOUN: Record<BackgroundKind, string> = { agents: "agent", monitors: "monitor", timers: "timer", scripts: "script" };

/**
 * Parse pi-persona's `persona-background` status: `kind=count` pairs separated
 * by one space, in the fixed order agents, monitors, timers, scripts, zero
 * counts omitted ("agents=3 monitors=1", "timers=1"). Strict on purpose: an
 * unknown or repeated key, a pair out of order, a zero, a sign, a leading zero,
 * a count past MAX_BACKGROUND_COUNT or any stray character means no background
 * work at all, so nothing that did not parse can reach the UI. Only the numbers
 * leave this function; the text itself is never displayed.
 */
export function parseBackgroundStatus(text: unknown): BackgroundWork | undefined {
	if (typeof text !== "string" || text.length === 0 || text.length > BACKGROUND_STATUS_LIMIT) return undefined;
	const work = { agents: 0, monitors: 0, timers: 0, scripts: 0 };
	let next = 0;
	for (const pair of text.split(" ")) {
		const match = BACKGROUND_PAIR.exec(pair);
		if (!match) return undefined;
		const kind = match[1] as BackgroundKind;
		const index = BACKGROUND_KINDS.indexOf(kind);
		if (index < next) return undefined; // repeated, or out of the published order
		next = index + 1;
		work[kind] = Number(match[2]);
	}
	return work;
}

/**
 * The same counts read back from stored JSON (the run summary's snapshot): all
 * four kinds as whole numbers within the bound, at least one positive. Anything
 * else is undefined, so a damaged entry renders as if it carried none.
 */
export function backgroundWorkOf(value: unknown): BackgroundWork | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const work = { agents: 0, monitors: 0, timers: 0, scripts: 0 };
	let total = 0;
	for (const kind of BACKGROUND_KINDS) {
		const count = Object.hasOwn(record, kind) ? record[kind] : undefined;
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_BACKGROUND_COUNT) return undefined;
		work[kind] = count;
		total += count;
	}
	return total > 0 ? work : undefined;
}

/** Every kind that is running, in order: "3 agents, 1 monitor, 1 timer, 1 script". */
export function backgroundDetail(work: BackgroundWork): string {
	return BACKGROUND_KINDS.filter(kind => work[kind] > 0).map(kind => plural(work[kind], BACKGROUND_NOUN[kind])).join(", ");
}

/** One kind is named ("3 agents", "1 timer"); several are counted together ("5 background tasks"). */
export function backgroundSummary(work: BackgroundWork): string {
	const running = BACKGROUND_KINDS.filter(kind => work[kind] > 0);
	if (running.length === 1) return plural(work[running[0]!], BACKGROUND_NOUN[running[0]!]);
	return plural(running.reduce((sum, kind) => sum + work[kind], 0), "background task");
}

/**
 * Neutralize width-ambiguous VS16 emoji in a status label so a fixed-width box's
 * right rail always lands on the corner. A grapheme of the form
 * <text-default symbol> + U+FE0F (⚖️, 🗺️, …) requests emoji presentation of a
 * symbol whose default is text; terminals disagree on its column count (1, 2, or 2
 * plus a tofu cell), so our width model — which mirrors pi-tui at 2 — and the glyph
 * the terminal actually paints drift apart, and the persona segment then pushes or
 * pulls the right rail off the border. Dropping the lone VS16 forces deterministic
 * text presentation: width 1 in our model AND in every terminal, so the two agree
 * regardless of how the terminal would have sized the emoji form. Emoji that need
 * no selector (🎯, Emoji_Presentation=Yes), keycaps, and complete grapheme clusters
 * containing a ZWJ (flags/professions, even when VS16 is not adjacent) stay intact.
 */
export function stableEmojiWidth(label: string): string {
	const safe = sanitizeInlineText(label);
	let output = "";
	for (const { segment } of INLINE_SEGMENTER.segment(safe)) {
		// Keep selectors that belong to a joined emoji or a keycap. For a lone
		// text-default symbol, remove VS16 to force deterministic one-cell text.
		output += segment.includes("\u200d") || segment.includes("\u20e3") ? segment : segment.replaceAll("\uFE0F", "");
	}
	return output;
}
