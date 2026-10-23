/**
 * Pure framing for the editor — a rounded, continuous panel.
 *
 * Pi's editor renders open-sided — a top `─` rule, the content lines (cursor
 * inline), a bottom `─` rule, then any autocomplete rows. `frameEditor` takes
 * that raw output, drops the two rules, and rebuilds a centered box around the
 * editor content. Autocomplete stays below the box at Pi's original row indices.
 * The chrome lives *inside* the box, not cut into the border: the prompt sigil
 * and spinner sit in the first row's side gutters, and the workspace / token
 * usage / model / persona sit on a status row when autocomplete is closed.
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
export function editorWidthFor(boxWidth: number, spinnerColumns = 1): number {
	// Keep one gap plus the active profile width in the right gutter at all times,
	// including idle and waiting renders, so activity never changes cursor geometry.
	return Math.max(0, boxWidth - 2 - GUTTER - 1 - Math.max(1, spinnerColumns));
}

/** Width reserved at the right of a two-row spinner's status row; one-row profiles reserve none. */
export function statusSlotWidth(spinnerColumns = 1, spinnerHeight = 1): number {
	return spinnerHeight === 2 ? Math.max(1, spinnerColumns) + 1 : 0;
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
	/** Pre-colored first spinner row; empty when idle/waiting. */
	spinner?: string;
	/** Optional two-row animation; rows are rendered in the existing reserved gutter. */
	spinnerRows?: readonly string[];
	/** Reserve spinnerColumns + one gap at the status row for a two-row spinner, even while inactive. */
	spinnerHeight?: number;
	/** Fixed right-indicator width reserved even when idle (defaults to one cell). */
	spinnerColumns?: number;
	/** Pre-colored status segments laid out on the interior row above the bottom edge. */
	statusLeft?: string | RowCandidate[];
	statusCenter?: string;
	/** Right segment: a plain string, or a degradation ladder (widest candidate first). */
	statusRight?: string | RowCandidate[];
}

/**
 * One rung of a status-segment degradation ladder. `pre` and `post` are kept
 * verbatim during normal narrowing; `flex` is the only part that trims before
 * falling to the next rung. If no rung fits at all, the final fallback may
 * hard-truncate the last rung with a visible `…`. All parts are pre-colored strings.
 */
export interface RowCandidate {
	pre?: string;
	flex?: string;
	post?: string;
}

/** A trimmed flex part narrower than this reads as noise — fall to the next rung instead. */
const MIN_FLEX = 5;
/** Don't preserve the center by reducing the workspace label to a lone glyph. */
const MIN_LEFT_LABEL = 5;

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
	return truncateToWidth(`${last.pre ?? ""}${last.flex ?? ""}${last.post ?? ""}`, avail);
}

/** True when a line is one of Pi's horizontal rules (so we can drop/locate it). */
export function isRuleLine(line: string): boolean {
	const plain = stripAnsi(line);
	// Pi's border starts at column zero. Editor content and autocomplete are
	// indented (including unselected suggestions whose labels are all dashes).
	if (!/^[─═]/.test(plain)) return false;
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
 * between them. When the row is crowded, a long left segment yields first so a
 * useful right rung can survive, and the center too when both can fit. A left
 * ladder reserves its narrowest semantic label before provider/model detail is
 * allocated. The center is dropped when that combination cannot fit. Always
 * returns `width` cols.
 */
export function layoutRow(left: string | RowCandidate[], center: string, right: string | RowCandidate[], width: number): string {
	if (width <= 0) return "";
	const minGap = 1;
	let l: string;
	let r: string;
	let centerAllowed = true;
	const centerWidth = visibleWidth(center);
	if (Array.isArray(left)) {
		// A semantic left ladder (workspace path → repository basename) outranks
		// optional center/provider detail. Reserve its narrowest useful rung and the
		// right ladder's minimum before spending the remaining columns on richer labels.
		const leftFloor = minimumUsefulWidth(left);
		const rightFloor = minimumUsefulWidth(right);
		const canPreserveCenter = !!center && leftFloor + rightFloor + centerWidth + 2 <= width;
		centerAllowed = canPreserveCenter;
		const reservedCenter = canPreserveCenter ? centerWidth + 2 : minGap;
		const rightRoom = Math.max(0, width - leftFloor - reservedCenter);
		r = Array.isArray(right) ? resolveSegment(right, rightRoom) : truncateToWidth(right, rightRoom);
		const leftRoom = Math.max(0, width - visibleWidth(r) - reservedCenter);
		l = resolveSegment(left, leftRoom);
	} else {
		l = left;
		const rightFloor = minimumUsefulWidth(right);
		const leftWidth = visibleWidth(l);
		const canPreserveCenter =
			!!center &&
			leftWidth > centerWidth + rightFloor &&
			leftWidth + centerWidth + rightFloor + 2 > width &&
			width - centerWidth - rightFloor - 2 >= MIN_LEFT_LABEL;
		const canPreserveRight =
			leftWidth > rightFloor &&
			leftWidth + rightFloor + minGap > width &&
			width - rightFloor - minGap >= MIN_LEFT_LABEL;
		const yieldLeft = canPreserveCenter || canPreserveRight;
		if (yieldLeft) {
			// First keep the widest semantic right rung that fits; then abbreviate only
			// the overlong left metadata to make room for it (and the center when possible).
			const rightRoom = canPreserveCenter
				? width - centerWidth - MIN_LEFT_LABEL - 2
				: width - MIN_LEFT_LABEL - minGap;
			r = Array.isArray(right) ? resolveSegment(right, rightRoom) : truncateToWidth(right, rightRoom);
			const centerRoom = canPreserveCenter ? centerWidth + 2 : minGap;
			l = truncateToWidth(left, width - centerRoom - visibleWidth(r));
		} else {
			const rightWidth = Math.max(0, width - leftWidth - minGap);
			r = Array.isArray(right) ? resolveSegment(right, rightWidth) : right;
		}
	}
	// Extreme widths only: clip the right segment to what the left leaves, then the
	// left to what remains. The final clamp below guarantees the row never overflows.
	if (visibleWidth(l) + visibleWidth(r) + minGap > width) {
		r = truncateToWidth(r, Math.max(0, width - visibleWidth(l) - minGap));
	}
	if (visibleWidth(l) + visibleWidth(r) + minGap > width) {
		l = truncateToWidth(l, Math.max(0, width - visibleWidth(r) - minGap));
	}
	const gap = Math.max(0, width - visibleWidth(l) - visibleWidth(r));
	const c = centerAllowed && center && visibleWidth(center) + 2 <= gap ? center : "";
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
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/** Width needed to preserve the narrowest meaningful right-side label. */
function minimumUsefulWidth(right: string | RowCandidate[]): number {
	if (!Array.isArray(right)) return Math.min(MIN_FLEX, visibleWidth(right));
	const last = right[right.length - 1];
	if (!last) return 0;
	const { pre = "", flex = "", post = "" } = last;
	return visibleWidth(pre) + visibleWidth(post) + Math.min(MIN_FLEX, visibleWidth(flex));
}

/** Pad or truncate a line to exactly `width` columns so the right rail always aligns. */
function fit(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	return w < width ? line + " ".repeat(width - w) : truncateToWidth(line, width, "");
}

export function frameEditor(raw: string[], options: FrameOptions): string[] {
	if (raw.length < 2) return raw;
	// A two-rail frame cannot exist in fewer than two columns; the editor factory
	// normally falls back before this point, but keep the pure seam non-overflowing.
	if (options.boxWidth < 2 + GUTTER + 1 + Math.max(1, options.spinnerColumns ?? 1)) return [];

	const bottomIdx = lastRuleIndex(raw);
	const content = raw.slice(1, Math.max(1, bottomIdx)); // editor lines (rules dropped)
	const below = raw.slice(bottomIdx + 1); // autocomplete rows stay outside the box

	const { style, border, boxWidth, leftMargin } = options;
	const pad = " ".repeat(Math.max(0, leftMargin));
	const v = border(style.v);
	const INT = Math.max(0, boxWidth - 2); // interior columns between the rails
	const spinnerColumns = Math.max(1, options.spinnerColumns ?? 1);
	const editorWidth = editorWidthFor(boxWidth, spinnerColumns); // width the editor was rendered at

	const top = `${pad}${border(style.tl + style.h.repeat(INT) + style.tr)}`;
	const bottom = `${pad}${border(style.bl + style.h.repeat(INT) + style.br)}`;

	const prompt = options.prompt ?? "";
	const spinner = options.spinner ?? "";
	const spinnerRows = options.spinnerRows;
	const pyramid = (options.spinnerHeight ?? spinnerRows?.length ?? 1) === 2;
	// Pi's rules double as scroll indicators; re-hang them on the rows they describe.
	const up = scrollMarker(raw[0], "↑");
	const down = scrollMarker(raw[bottomIdx], "↓");
	const lastContent = content.length - 1;

	const body = content.map((line, i) => {
		// First row carries the prompt (left) and the spinner (right) in its gutters;
		// the rest get blank gutters so every content column lines up beneath the
		// first. The otherwise-dead right gutters carry the scroll markers.
		const lg = i === 0 && prompt ? ` ${prompt}` : "  ";
		const logoRow = pyramid && spinnerRows && (i === 0 || i === 1) ? spinnerRows[i] : "";
		const marker = i === 0 && spinner ? spinner : i === 0 && up ? border(up) : i === lastContent && down ? border(down) : "";
		const gutterText = i === 0 && pyramid && spinner ? `${spinnerRows?.[0] ?? spinner} ` : i === 1 && logoRow ? `${logoRow}${down && i === lastContent ? border(down) : " "}` : marker ? `${marker}${" ".repeat(Math.max(0, spinnerColumns + 1 - visibleWidth(marker)))}` : " ".repeat(spinnerColumns + 1);
		const rg = visibleWidth(gutterText) > spinnerColumns + 1 ? truncateToWidth(gutterText, spinnerColumns + 1, "") : gutterText + " ".repeat(Math.max(0, spinnerColumns + 1 - visibleWidth(gutterText)));
		return `${pad}${v}${lg}${fit(line, editorWidth)}${rg}${v}`;
	});

	const rows = [top, ...body];
	// The base editor places autocomplete immediately after its bottom rule.
	// Hide status while the menu is open so that row indices match without
	// reaching into the base editor's private mouse/layout state.
	if (below.length === 0 && (options.statusLeft || options.statusCenter || options.statusRight)) {
		const statusLogo = pyramid && content.length === 1 && spinnerRows && spinner ? spinnerRows[1] : "";
		const slotWidth = statusSlotWidth(spinnerColumns, pyramid ? 2 : 1);
		const statusWidth = Math.max(0, INT - slotWidth);
		const interior = layoutRow(options.statusLeft ?? "", options.statusCenter ?? "", options.statusRight ?? "", statusWidth);
		const statusGutter = slotWidth ? fit(`${statusLogo}${down && content.length === 1 ? border(down) : " "}`, slotWidth) : "";
		rows.push(`${pad}${v}${interior}${statusGutter}${v}`);
	}
	rows.push(bottom);
	for (const line of below) {
		rows.push(`${pad}${" ".repeat(1 + GUTTER)}${fit(line, editorWidth)}${" ".repeat(1 + GUTTER)}`);
	}
	return rows;
}
