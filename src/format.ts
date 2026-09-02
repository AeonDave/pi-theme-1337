/** Small, pure formatters shared by the frame borders. */

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
		const codePoint = value.codePointAt(i) ?? 0;
		const size = codePoint > 0xffff ? 2 : 1;

		if (codePoint === 0x1b) {
			const kind = value.charCodeAt(i + 1);
			if (kind === 0x5b) i = skipCsi(value, i + 2); // CSI
			else if (kind === 0x5d || kind === 0x50 || kind === 0x5f || kind === 0x5e || kind === 0x58) {
				i = skipControlString(value, i + 2); // OSC / DCS / APC / PM / SOS
			} else {
				i += 2; // two-byte escape; dropping both is safer than exposing its final
			}
			continue;
		}
		if (codePoint === 0x9b) {
			i = skipCsi(value, i + size); // C1 CSI
			continue;
		}
		if (codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f) {
			i = skipControlString(value, i + size);
			continue;
		}

		const char = value.slice(i, i + size);
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
		if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) || isBidiControl(codePoint)) continue;
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
 * Shorten a path to `~/…/<last two segments>`, normalizing Windows slashes.
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
	const segments = unix.split("/").filter(Boolean);
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

/** Tokens used, with % of the window: "12.3k · 6%" — or "ctx —" when unknown. */
export function formatContext(usage: ContextUsageLike | undefined): string {
	if (!usage || usage.tokens === null) return "ctx —";
	const pct = usage.percent === null ? "" : ` · ${Math.round(usage.percent)}%`;
	return `${formatTokens(usage.tokens)}${pct}`;
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

/** True when the buffer starts Pi's bash mode (a leading `!`), so the prompt sigil can react. */
export function isBashInput(text: string): boolean {
	return text.trimStart().startsWith("!");
}

export type UsageLevel = "normal" | "warn" | "critical";

/**
 * Escalation level for the context-usage label, matching Pi's footer
 * thresholds: warn above 70%, critical above 90% (auto-compact territory).
 */
export function usageLevel(percent: number | null | undefined): UsageLevel {
	if (percent == null) return "normal";
	if (percent > 90) return "critical";
	if (percent > 70) return "warn";
	return "normal";
}

/** Structural slice of a session entry — enough to sum costs without Pi imports. */
export interface SessionEntryLike {
	type: string;
	message?: { role?: string; usage?: { cost?: { total?: number } } };
	usage?: { cost?: { total?: number } };
}

/**
 * Cumulative session cost from assistant/tool-result messages plus compaction
 * and branch-summary usage (the same walk Pi's footer does): "$0.423" under a
 * dollar, "$2.50" above, "" when zero. On an OAuth
 * subscription the figure is a nominal API-equivalent, not money spent, so the
 * segment is hidden entirely — a visible cost therefore always means real
 * pay-per-token spend.
 */
export function formatCost(entries: Iterable<SessionEntryLike>, usingSubscription = false, extraCost = 0): string {
	if (usingSubscription) return "";
	let total = 0;
	for (const entry of entries) {
		const messageUsage =
			entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
				? entry.message.usage
				: undefined;
		const summaryUsage = entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
		const value = (messageUsage ?? summaryUsage)?.cost?.total;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
	}
	if (typeof extraCost === "number" && Number.isFinite(extraCost) && extraCost > 0) total += extraCost;
	if (total <= 0) return "";
	return `$${total < 1 ? total.toFixed(3) : total.toFixed(2)}`;
}

/**
 * Parse pi-persona's `persona-cost` status (leftover background-leg spend not yet
 * on a tool result). Accepts "$0.923" or "0.923"; anything else is 0.
 */
export function parsePersonaCost(text: string | undefined): number {
	if (!text) return 0;
	const match = text.trim().match(/^\$?(\d+(?:\.\d+)?)/);
	if (!match) return 0;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : 0;
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

/**
 * Resolve the live sub-agent count for the frame's top border. Prefer pi-persona's
 * published one-line count (`published` — covers strategy/council cores the
 * delegate-only counter misses) when it parses as a finite number; otherwise fall
 * back to `delegateCount`. Returns the count and a plain, uncolored label (empty
 * when zero). An empty/whitespace `published` is falsy and must fall back — never
 * coerce `""` to 0. Coloring stays in editor.ts so this module stays pure.
 */
export function agentCount(published: string | undefined, delegateCount: number): { count: number; label: string } {
	const parsed = published && Number.isFinite(Number(published)) ? Number(published) : delegateCount;
	const count = parsed > 0 ? parsed : 0;
	const label = count > 0 ? ` ${count} agent${count === 1 ? "" : "s"} ` : "";
	return { count, label };
}
