/**
 * Pure framing for the editor — a rounded, continuous panel.
 *
 * Pi's editor renders open-sided — a top `─` rule, the content lines (cursor
 * inline), a bottom `─` rule, then any autocomplete rows. `frameEditor` takes
 * that raw output, drops the two rules, and rebuilds a centered box whose
 * border is a single unbroken rounded outline. The chrome lives *inside* the
 * box, not cut into the border: the prompt sigil and spinner sit in the first
 * row's side gutters, and the workspace / token usage / model / persona sit on
 * a dedicated status row just above the bottom edge.
 *
 *      ╭────────────────────────────────────────────╮
 *      │ › refactor the auth module_             ⠹  │
 *      │                                            │
 *      │ ~/…/pi-1337        12.3k · 6%    opus · ◆  │
 *      ╰────────────────────────────────────────────╯
 *
 * No Pi imports — `string[]` in, `string[]` out — so it unit-tests with `tsx`.
 */

import { stripAnsi, truncateToWidth, visibleWidth } from "./width.ts";

export interface BorderStyle {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
}

/** Rounded single-line box — a soft, continuous outline (no labels cut into it). */
export const ROUNDED: BorderStyle = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

/** Columns reserved on each side of every body row for the chrome gutters. */
export const GUTTER = 2;

/**
 * Width the editor must be rendered at to fit inside a `boxWidth` panel: the box
 * spends two columns per side on the rails plus the chrome gutters. Single source
 * of that arithmetic — the caller renders at this width and `frameEditor` fits
 * every row to it, so the two can never disagree and pull the right rail off.
 */
export function editorWidthFor(boxWidth: number): number {
	return Math.max(0, boxWidth - 2 - 2 * GUTTER);
}

export interface FrameOptions {
	/** Outer box width in columns (side glyphs included). */
	boxWidth: number;
	/** Spaces of left margin to center the box. */
	leftMargin: number;
	style: BorderStyle;
	/** Colorizer for the border glyphs (corners, edges, side rails). */
	border: (text: string) => string;
	/** Pre-colored prompt sigil (1 col) placed in the first row's left gutter. */
	prompt?: string;
	/** Pre-colored spinner glyph (1 col) placed in the first row's right gutter; empty when idle. */
	spinner?: string;
	/** Pre-colored status segments laid out on the interior row above the bottom edge. */
	statusLeft?: string;
	statusCenter?: string;
	/** Right segment: a plain string, or a degradation ladder (widest candidate first). */
	statusRight?: string | RowCandidate[];
}

/**
 * One rung of a status-segment degradation ladder. `pre` and `post` are kept
 * verbatim; `flex` is the only part allowed to trim with `…` when the whole
 * candidate doesn't fit. All parts are pre-colored strings.
 */
export interface RowCandidate {
	pre?: string;
	flex?: string;
	post?: string;
}

/** A trimmed flex part narrower than this reads as noise — fall to the next rung instead. */
const MIN_FLEX = 5;

/**
 * Pick the widest ladder rung that fits in `avail` columns. A rung with a
 * `flex` part may trim it with `…` down to MIN_FLEX columns (the last rung
 * trims below the floor rather than vanish). If nothing fits, the last rung is
 * hard-truncated so the row can never overflow.
 */
export function resolveSegment(candidates: RowCandidate[], avail: number): string {
	if (avail <= 0 || candidates.length === 0) return "";
	for (let i = 0; i < candidates.length; i++) {
		const { pre = "", flex = "", post = "" } = candidates[i];
		const full = pre + flex + post;
		if (visibleWidth(full) <= avail) return full;
		if (flex) {
			const flexAvail = avail - visibleWidth(pre) - visibleWidth(post);
			const isLast = i === candidates.length - 1;
			if (flexAvail >= MIN_FLEX || (isLast && flexAvail >= 1)) {
				return pre + truncateToWidth(flex, flexAvail) + post;
			}
		}
	}
	const last = candidates[candidates.length - 1];
	return truncateToWidth(`${last.pre ?? ""}${last.flex ?? ""}${last.post ?? ""}`, avail, "");
}

/** True when a line is one of Pi's horizontal rules (so we can drop/locate it). */
export function isRuleLine(line: string): boolean {
	const plain = stripAnsi(line);
	// At editor widths 4–5, Pi clips "─── ↓ N more" to one/two rule
	// glyphs plus a three-dot ellipsis. Recognize that exact terminal shape
	// before applying the ordinary minimum-rule-length heuristic.
	if (/^[─═]+\.{3}$/.test(plain.trim())) return true;
	const dashes = (plain.match(/[─═]/g) ?? []).length;
	if (dashes < 3) return false;
	const residue = plain.replace(/[─═↑↓\s\d]|more/g, "");
	if (residue.length !== 0) return false;
	// The editor's "↑/↓ N more" scroll indicator is a degraded rule with few dashes;
	// recognize it explicitly so lastRuleIndex finds it instead of an autocomplete row.
	if (/[↑↓]/.test(plain) && /more/.test(plain)) return true;
	return dashes >= Math.floor(visibleWidth(line) * 0.4);
}

/** Index of the last rule line (the editor's bottom border); anything after is autocomplete. */
export function lastRuleIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isRuleLine(lines[i])) return i;
	}
	return lines.length - 1;
}

/**
 * `↑`/`↓` when one of Pi's rules is really its "N more" scroll indicator. Both
 * rules are dropped when the box is rebuilt, so without this the fact that the
 * buffer continues above or below the visible rows would be lost — the glyph is
 * re-hung in the matching row's side gutter instead.
 */
export function scrollMarker(rule: string | undefined, glyph: "↑" | "↓"): string {
	if (!rule) return "";
	const plain = stripAnsi(rule);
	return plain.includes(glyph) && plain.includes("more") ? glyph : "";
}

/**
 * Lay out `left`, `center`, `right` across exactly `width` columns using space
 * fill: left-aligned left, right-aligned right, an optional centered segment
 * between them. The center is dropped when there's no room for a >= 1 space
 * run on each side. A `right` given as a ladder degrades via `resolveSegment`
 * (against the room the full left leaves); the trailing clips are only the
 * defense for extreme widths. Always returns `width` cols.
 */
export function layoutRow(left: string, center: string, right: string | RowCandidate[], width: number): string {
	if (width <= 0) return "";
	const minGap = 1;
	let l = left;
	let r = Array.isArray(right) ? resolveSegment(right, width - visibleWidth(left) - minGap) : right;
	// Extreme widths only: clip the right segment to what the left leaves, then the
	// left to what remains. The final clamp below guarantees the row never overflows.
	if (visibleWidth(l) + visibleWidth(r) + minGap > width) {
		r = truncateToWidth(r, Math.max(0, width - visibleWidth(l) - minGap), "");
	}
	if (visibleWidth(l) + visibleWidth(r) + minGap > width) {
		l = truncateToWidth(l, Math.max(0, width - visibleWidth(r) - minGap), "");
	}
	const gap = Math.max(0, width - visibleWidth(l) - visibleWidth(r));
	const c = center && visibleWidth(center) + 2 <= gap ? center : "";
	let line: string;
	if (c) {
		const rem = gap - visibleWidth(c);
		const f1 = Math.floor(rem / 2);
		const f2 = rem - f1;
		line = `${l}${" ".repeat(f1)}${c}${" ".repeat(f2)}${r}`;
	} else {
		line = `${l}${" ".repeat(gap)}${r}`;
	}
	// Defense-in-depth: a residual mismeasure must never exceed `width` and wrap the terminal.
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

/** Pad or truncate a line to exactly `width` columns so the right rail always aligns. */
function fit(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	return w < width ? line + " ".repeat(width - w) : truncateToWidth(line, width, "");
}

export function frameEditor(raw: string[], options: FrameOptions): string[] {
	if (raw.length < 2) return raw;

	const bottomIdx = lastRuleIndex(raw);
	const content = raw.slice(1, Math.max(1, bottomIdx)); // editor lines (rules dropped)
	const below = raw.slice(bottomIdx + 1); // autocomplete rows, if any
	const inner = content.concat(below);

	const { style, border, boxWidth, leftMargin } = options;
	const pad = " ".repeat(Math.max(0, leftMargin));
	const v = border(style.v);
	const INT = Math.max(0, boxWidth - 2); // interior columns between the rails
	const editorWidth = editorWidthFor(boxWidth); // width the editor was rendered at

	const top = `${pad}${border(style.tl + style.h.repeat(INT) + style.tr)}`;
	const bottom = `${pad}${border(style.bl + style.h.repeat(INT) + style.br)}`;

	const prompt = options.prompt ?? "";
	const spinner = options.spinner ?? "";
	// Pi's rules double as scroll indicators; re-hang them on the rows they describe.
	const up = scrollMarker(raw[0], "↑");
	const down = scrollMarker(raw[bottomIdx], "↓");
	const lastContent = content.length - 1;

	const body = inner.map((line, i) => {
		// First row carries the prompt (left) and the spinner (right) in its gutters;
		// the rest get blank gutters so every content column lines up beneath the
		// first. The otherwise-dead right gutters carry the scroll markers.
		const lg = i === 0 && prompt ? ` ${prompt}` : "  ";
		const marker = i === 0 && spinner ? spinner : i === 0 && up ? border(up) : i === lastContent && down ? border(down) : "";
		const rg = marker ? `${marker} ` : "  ";
		return `${pad}${v}${lg}${fit(line, editorWidth)}${rg}${v}`;
	});

	const rows = [top, ...body];
	if (options.statusLeft || options.statusCenter || options.statusRight) {
		const interior = layoutRow(options.statusLeft ?? "", options.statusCenter ?? "", options.statusRight ?? "", INT);
		rows.push(`${pad}${v}${interior}${v}`);
	}
	rows.push(bottom);
	return rows;
}
