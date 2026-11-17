/**
 * Pure framing for the editor — a rounded, continuous panel.
 *
 * Pi's editor renders open-sided — a top `─` rule, the content lines (cursor
 * inline), a bottom `─` rule, then any autocomplete rows. `frameEditor` takes
 * that raw output, drops the two rules, and rebuilds a centered box around the
 * editor content. Autocomplete stays below the box at Pi's original row indices.
 * The border carries exactly one label, the model identity at the top-right;
 * the rest of the chrome lives inside: the prompt sigil and spinner sit in the
 * first row's side gutters, and a status row (where you are, left; the
 * session's state, right) sits above the bottom edge when autocomplete is closed.
 *
 *      ╭──────────────────────────── anthropic/opus-4-8 · high ──╮
 *      │ › refactor the auth module_                          ⠹  │
 *      │ ~/…/pi-1337 · main               12.3k · 6% · ~$0.42    │
 *      ╰─────────────────────────────────────────────────────────╯
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

/** Rounded single-line box — a soft, continuous outline. */
export const ROUNDED: BorderStyle = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

/** Columns reserved on each side of every body row for the chrome gutters. */
export const GUTTER = 2;

/** Rule cells the top label keeps on its left (at least) and its right (exactly). */
const LABEL_RULE = 2;

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
	/**
	 * Pre-colored ladder (widest first) for the one label the top border carries,
	 * at its right end: `╭──… label ──╮`. No rung that fits → the plain rule.
	 */
	borderLabel?: RowCandidate[];
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
	/** Pre-colored left group of the status row: a plain string, or a degradation ladder (widest first). */
	statusLeft?: string | RowCandidate[];
	/** Right group, right-aligned: a plain string, or a degradation ladder (widest candidate first). */
	statusRight?: string | RowCandidate[];
	/** Transient label painted over the left group's cells; never moves the right group (see layoutRow). */
	statusOverlay?: RowCandidate[];
}

/**
 * One rung of a degradation ladder. `pre` and `post` are kept verbatim during
 * normal narrowing; `flex` is the only part that trims before falling to the
 * next rung. If no rung fits at all, the status row's final fallback may
 * hard-truncate the last rung with a visible `…` (a last rung with `minFlex`
 * is absent instead). All parts are pre-colored strings.
 */
export interface RowCandidate {
	pre?: string;
	flex?: string;
	post?: string;
	/**
	 * The narrowest `flex` may trim to, in columns. When set, the rung is shown
	 * whole, trimmed to no fewer than this, or skipped — as the last rung too,
	 * which otherwise trims down to one column. Unset: MIN_FLEX.
	 */
	minFlex?: number;
}

/** A trimmed flex part narrower than this reads as noise — fall to the next rung instead. */
const MIN_FLEX = 5;
/** Don't preserve the right group by reducing a plain-string workspace label to a lone glyph. */
const MIN_LEFT_LABEL = 5;

/**
 * The widest rung that fits in `avail` columns, with `flex` trimmed down to
 * MIN_FLEX (the last rung below it, to one column) or to the rung's own
 * `minFlex`, which holds for the last rung too; `undefined` when none does.
 */
function fitSegment(candidates: RowCandidate[], avail: number): string | undefined {
	if (avail <= 0) return undefined;
	for (let i = 0; i < candidates.length; i++) {
		const { pre = "", flex = "", post = "", minFlex } = candidates[i];
		const full = pre + flex + post;
		if (visibleWidth(full) <= avail) return full;
		if (flex) {
			const flexAvail = avail - visibleWidth(pre) - visibleWidth(post);
			const isLast = i === candidates.length - 1;
			if (minFlex !== undefined ? flexAvail >= minFlex : flexAvail >= MIN_FLEX || (isLast && flexAvail >= 1)) {
				return pre + truncateToWidth(flex, flexAvail) + post;
			}
		}
	}
	return undefined;
}

/**
 * Pick the widest ladder rung that fits in `avail` columns. A rung with a
 * `flex` part may trim it with `…` down to MIN_FLEX columns (the last rung
 * trims below the floor rather than vanish). If nothing fits, the last rung is
 * hard-truncated so the row can never overflow — unless it declares a
 * `minFlex`: that rung's contract is whole, trimmed to its floor, or absent,
 * so below its floor the segment is empty rather than a stub of the label.
 */
export function resolveSegment(candidates: RowCandidate[], avail: number): string {
	if (avail <= 0 || candidates.length === 0) return "";
	const fitted = fitSegment(candidates, avail);
	if (fitted !== undefined) return fitted;
	const last = candidates[candidates.length - 1];
	if (last.minFlex !== undefined) return "";
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
 * The top edge, `boxWidth` columns: `╭─…─╮`, or `╭─… label ──╮` when a rung of
 * `label` fits with at least two rule cells on its left. The label is measured
 * with the shared ruler and sits between single spaces; the rule pieces are
 * colored on their own so the label keeps its colors. A rung that only trims
 * to a lone `…`, or shows nothing visible, is noise, not a label: the rule
 * stays plain then.
 */
function topEdge(style: BorderStyle, border: (text: string) => string, boxWidth: number, label: RowCandidate[] | undefined): string {
	const interior = Math.max(0, boxWidth - 2);
	const plain = border(style.tl + style.h.repeat(interior) + style.tr);
	if (!label || label.length === 0) return plain;
	const room = interior - LABEL_RULE - 2 - LABEL_RULE;
	const shown = fitSegment(label, room);
	// No visible content (escape-only, blank, zero-width) is no label either: never `╭──  ──╮`.
	if (shown === undefined) return plain;
	const visible = stripAnsi(shown).trim();
	if (!visible || visible === "…" || visibleWidth(visible) === 0) return plain;
	const lead = interior - 2 - LABEL_RULE - visibleWidth(shown);
	if (lead < LABEL_RULE) return plain;
	const row = `${border(style.tl + style.h.repeat(lead))} ${shown} ${border(style.h.repeat(LABEL_RULE) + style.tr)}`;
	// Defense-in-depth: a residual mismeasure must never change the box width.
	return visibleWidth(row) === boxWidth ? row : plain;
}

/**
 * Lay out `left` and `right` across exactly `width` columns using space fill:
 * left-aligned left, right-aligned right. When the row is crowded, a long left
 * segment yields first so a useful right rung can survive. A left ladder
 * reserves its narrowest semantic label before the right is allocated, so the
 * right keeps its widest rung that fits beside that floor and the left then
 * spends what remains. Always returns `width` cols.
 *
 * `overlay` is a transient label (the running tool) that borrows the left
 * segment's cells without moving anything else. The row is first laid out from
 * left/right alone; then the cells before the right segment are repainted with
 * the overlay, left-aligned and space-padded, resolved against those cells − 1
 * so one space always separates it from what follows. Rungs are tried whole,
 * widest first, and only the last rung may trim. An overlay that resolves to
 * nothing — including one whose cells cannot hold its narrowest useful rung —
 * leaves the row as it was. Guarantee: for any width the right segment occupies
 * byte-identical columns with and without the overlay, and the row is exactly
 * `width` columns — a label that comes and goes never reflows the row.
 */
export function layoutRow(
	left: string | RowCandidate[],
	right: string | RowCandidate[],
	width: number,
	overlay?: RowCandidate[],
): string {
	if (width <= 0) return "";
	const { l, r } = placeSegments(left, right, width);
	let lead = `${l}${" ".repeat(Math.max(0, width - visibleWidth(l) - visibleWidth(r)))}`;
	if (overlay && overlay.length > 0) {
		const whole = ({ pre = "", flex = "", post = "" }: RowCandidate): string => pre + flex + post;
		const region = visibleWidth(lead);
		const rung = overlay.find(candidate => visibleWidth(whole(candidate)) <= region - 1);
		// Below its narrowest useful rung the overlay would hard-truncate to a lone
		// "…" in place of the workspace; keep the row as it was instead.
		const avail = region - 1;
		const shown = rung ? whole(rung)
			: avail >= minimumUsefulWidth(overlay) ? resolveSegment([overlay[overlay.length - 1]], avail) : "";
		const shownWidth = visibleWidth(shown);
		if (shownWidth > 0) lead = `${shown}${" ".repeat(Math.max(0, region - shownWidth))}`;
	}
	const line = lead + r;
	// Defense-in-depth: a residual mismeasure must never exceed `width` and wrap the terminal.
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/** Resolve the left and right segments for a `width`-column row with at least one column between them. */
function placeSegments(left: string | RowCandidate[], right: string | RowCandidate[], width: number): { l: string; r: string } {
	const minGap = 1;
	let l: string;
	let r: string;
	if (Array.isArray(left)) {
		// A semantic left ladder (workspace path → repository basename) keeps its
		// narrowest useful rung; the right takes its widest rung beside that floor,
		// and the left then spends what remains on richer labels.
		const rightRoom = Math.max(0, width - minimumUsefulWidth(left) - minGap);
		r = Array.isArray(right) ? resolveSegment(right, rightRoom) : truncateToWidth(right, rightRoom);
		l = resolveSegment(left, Math.max(0, width - visibleWidth(r) - minGap));
	} else {
		l = left;
		const rightFloor = minimumUsefulWidth(right);
		const leftWidth = visibleWidth(l);
		const yieldLeft =
			leftWidth > rightFloor &&
			leftWidth + rightFloor + minGap > width &&
			width - rightFloor - minGap >= MIN_LEFT_LABEL;
		if (yieldLeft) {
			// First keep the widest semantic right rung that fits; then abbreviate only
			// the overlong left metadata to make room for it.
			const rightRoom = width - MIN_LEFT_LABEL - minGap;
			r = Array.isArray(right) ? resolveSegment(right, rightRoom) : truncateToWidth(right, rightRoom);
			l = truncateToWidth(left, width - minGap - visibleWidth(r));
		} else {
			const rightWidth = Math.max(0, width - leftWidth - minGap);
			r = Array.isArray(right) ? resolveSegment(right, rightWidth) : right;
		}
	}
	// Extreme widths only: clip the right segment to what the left leaves, then the
	// left to what remains. The final clamp in layoutRow guarantees no overflow.
	if (visibleWidth(l) + visibleWidth(r) + minGap > width) {
		r = truncateToWidth(r, Math.max(0, width - visibleWidth(l) - minGap));
	}
	if (visibleWidth(l) + visibleWidth(r) + minGap > width) {
		l = truncateToWidth(l, Math.max(0, width - visibleWidth(r) - minGap));
	}
	return { l, r };
}

/** Width needed to preserve the narrowest meaningful label of a segment. */
function minimumUsefulWidth(segment: string | RowCandidate[]): number {
	if (!Array.isArray(segment)) return Math.min(MIN_FLEX, visibleWidth(segment));
	const last = segment[segment.length - 1];
	if (!last) return 0;
	const { pre = "", flex = "", post = "", minFlex = MIN_FLEX } = last;
	return visibleWidth(pre) + visibleWidth(post) + Math.min(minFlex, visibleWidth(flex));
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

	const top = `${pad}${topEdge(style, border, boxWidth, options.borderLabel)}`;
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
	const hasLeft = Array.isArray(options.statusLeft) ? options.statusLeft.length > 0 : !!options.statusLeft;
	const hasRight = Array.isArray(options.statusRight) ? options.statusRight.length > 0 : !!options.statusRight;
	if (below.length === 0 && (hasLeft || hasRight)) {
		const statusLogo = pyramid && content.length === 1 && spinnerRows && spinner ? spinnerRows[1] : "";
		const slotWidth = statusSlotWidth(spinnerColumns, pyramid ? 2 : 1);
		const statusWidth = Math.max(0, INT - slotWidth);
		const interior = layoutRow(options.statusLeft ?? "", options.statusRight ?? "", statusWidth, options.statusOverlay);
		const statusGutter = slotWidth ? fit(`${statusLogo}${down && content.length === 1 ? border(down) : " "}`, slotWidth) : "";
		rows.push(`${pad}${v}${interior}${statusGutter}${v}`);
	}
	rows.push(bottom);
	for (const line of below) {
		rows.push(`${pad}${" ".repeat(1 + GUTTER)}${fit(line, editorWidth)}${" ".repeat(1 + GUTTER)}`);
	}
	return rows;
}
