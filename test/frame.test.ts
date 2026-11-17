import assert from "node:assert/strict";
import { test } from "node:test";
import { editorWidthFor, frameEditor, GUTTER, isRuleLine, lastRuleIndex, layoutRow, resolveSegment, ROUNDED, scrollMarker } from "../src/frame.ts";
import { stripAnsi, visibleWidth, useTerminalMetrics } from "../src/width.ts";
import { visibleWidth as hostVisibleWidth, truncateToWidth as hostTruncateToWidth } from "@earendil-works/pi-tui";

const id = (s: string) => s;

test("isRuleLine recognizes Pi's horizontal rules, not content", () => {
	assert.ok(isRuleLine("─".repeat(20)));
	assert.ok(isRuleLine("─── ↑ 3 more ─────────"));
	assert.ok(!isRuleLine("  hello world        "));
	assert.ok(!isRuleLine("                    ")); // empty content line
});

test("lastRuleIndex finds the bottom rule, leaving autocomplete below it", () => {
	const raw = ["─".repeat(10), " content  ", "─".repeat(10), "/init     ", "/clear    "];
	assert.equal(lastRuleIndex(raw), 2);
});

test("autocomplete labels made of rules cannot masquerade as Pi's bottom border", () => {
	const raw = ["─".repeat(12), " input      ", "─".repeat(12), "  /init     ", `  ${"─".repeat(10)}`];
	assert.equal(isRuleLine(raw[4]), false);
	assert.equal(lastRuleIndex(raw), 2);
	const out = frameEditor(raw, { boxWidth: 18, leftMargin: 0, style: ROUNDED, border: id, statusLeft: "~" });
	assert.ok(out[4].includes("──────────"), "rule-like suggestion remains below the box");
});

test("isRuleLine recognizes the degraded '↓ N more' scroll indicator despite few dashes", () => {
	assert.ok(isRuleLine("──── ↓ 12 more")); // < 40% dashes, but unmistakably a scroll rule
	assert.ok(isRuleLine("─...")); // Pi truncates a scroll rule to this at editor width 4
	assert.ok(isRuleLine("──...")); // and to this at editor width 5
	assert.ok(!isRuleLine("──── 12 apples")); // real content with dashes is not a rule
});

test("layoutRow spans exactly width with a left-aligned left and a right-aligned right", () => {
	const line = layoutRow(" left ", " right ", 40);
	assert.equal(visibleWidth(line), 40);
	assert.ok(line.startsWith(" left ") && line.endsWith(" right "));
});

test("layoutRow truncates side segments rather than overflowing", () => {
	const line = layoutRow("a-very-long-left-label", "and-right", 16);
	assert.ok(visibleWidth(line) <= 16);
});

test("layoutRow lets long left metadata yield to useful right metadata", () => {
	const left = " ~/…/project/src · feature/" + "long-branch/".repeat(8) + " · session-name";
	for (const width of [40, 80, 120]) {
		const line = layoutRow(left, withPersona, width);
		const plain = stripAnsi(line);
		assert.equal(visibleWidth(line), width);
		assert.ok(plain.includes("Elite"), `persona should survive at ${width} columns: ${plain}`);
		assert.ok(plain.includes("94%"), `usage should remain at ${width} columns: ${plain}`);
		assert.ok(plain.includes("…"), `oversized left metadata should be visibly abbreviated at ${width} columns: ${plain}`);
	}
});

test("layoutRow preserves the workspace identity while the right group keeps its widest fitting rung", () => {
	const left = [
		{ pre: " …/Sources/pi-persona", flex: " · feature/restore-context-indicator · Fix session resume status" },
		{ pre: " …/Sources/pi-persona" },
		{ pre: " …/pi-persona" },
	];
	const right = [
		{ pre: "182.0k · 91% · ~$0.250 · 1337 " },
		{ pre: "91% · ", flex: "1337", post: " " },
		{ pre: "91% " },
	];

	for (const width of [20, 40, 60, 80, 90, 120]) {
		const line = layoutRow(left, right, width);
		const plain = stripAnsi(line);
		assert.equal(visibleWidth(line), width);
		assert.ok(plain.includes("pi-persona"), `workspace identity should survive at ${width} columns: ${plain}`);
	}
});

// The status row's right group degrades semantically, not char-by-char: the
// editor hands layoutRow a ladder of candidates (widest first). `flex` marks
// the persona as the only part allowed to trim with `…`; pre/post stay verbatim.
const withPersona = [
	{ pre: "1.2M · 94% · ~$0.250 · Elite Operator " }, // full
	{ pre: "1.2M · 94% · Elite Operator " }, // cost dropped
	{ pre: "94% · ", flex: "Elite Operator", post: " " }, // tokens dropped; persona may trim
	{ pre: "94% " }, // tightest: the percentage alone
];
const LEFT = "~/x · main"; // 10 cols

test("layoutRow keeps the full right group while it fits", () => {
	const line = layoutRow(LEFT, withPersona, 60);
	assert.equal(visibleWidth(line), 60);
	assert.ok(line.includes("~$0.250") && line.includes("Elite Operator"));
});

test("layoutRow drops the right group's detail rung by rung when narrowing", () => {
	const noCost = stripAnsi(layoutRow(LEFT, withPersona, 40));
	assert.ok(!noCost.includes("~$") && noCost.includes("1.2M · 94% · Elite Operator"));
	const trimmed = stripAnsi(layoutRow(LEFT, withPersona, 24));
	assert.equal(visibleWidth(trimmed), 24);
	assert.ok(!trimmed.includes("1.2M") && trimmed.includes("94% · Elite") && trimmed.includes("…"), trimmed);
	assert.ok(trimmed.includes(LEFT), "the path stays while the persona trims");
	const bare = stripAnsi(layoutRow(LEFT, withPersona, 16));
	assert.ok(bare.endsWith(" 94% ") && !bare.includes("Elite"), bare);
});

test("layoutRow keeps trimming the last rung's flex below the usual floor", () => {
	const ladder = [{ pre: "anthropic/opus-4-8 " }, { flex: "opus-4-8", post: " " }];
	const line = layoutRow("~/x", ladder, 8);
	assert.equal(visibleWidth(line), 8);
	assert.ok(stripAnsi(line).includes("op…")); // below the usual floor: last candidate still trims
});

test("a rung with its own minFlex is whole, trimmed to no fewer than that, or skipped, as the last rung too", () => {
	const ladder = [{ pre: "repo · ", flex: "review session", minFlex: 10 }, { pre: "repo" }];
	assert.equal(resolveSegment(ladder, 21), "repo · review session");
	assert.equal(stripAnsi(resolveSegment(ladder, 20)), "repo · review sessi…");
	assert.equal(stripAnsi(resolveSegment(ladder, 17)), "repo · review se…", "ten columns of the name: nine characters and the ellipsis");
	assert.equal(resolveSegment(ladder, 16), "repo", "one column short of its floor the rung is skipped whole");
	// A flex part no wider than its floor cannot trim at all.
	assert.equal(resolveSegment([{ pre: "repo · ", flex: "wip", minFlex: 10 }, { pre: "repo" }], 9), "repo");
	// The last rung normally trims to a single column; with a floor it does not.
	const overlay = [{ pre: " ", flex: "Running npm test…", minFlex: 8 }];
	for (let width = 6; width <= 40; width++) {
		const plain = stripAnsi(layoutRow([{ pre: " …/x" }], "", width, overlay));
		assert.equal(visibleWidth(plain), width);
		// The overlay resolves against its cells less one, after its own leading space.
		if (width - 2 >= 8) assert.match(plain, /^ Running.*… /, `@${width}: ${plain}`);
		else assert.equal(plain.trimEnd(), " …/x", `@${width}: too few cells keep the row as it was`);
		assert.doesNotMatch(plain, /^ R[a-z]{0,5}…/, `@${width}: never a stub of the label: ${plain}`);
	}
});

test("a last rung with minFlex is never hard-truncated: resolveSegment and fitSegment agree it is absent below its floor", () => {
	const floored = [{ pre: " ", flex: "Running npm test…", post: " 14s", minFlex: 8 }];
	const full = " Running npm test… 14s";
	assert.equal(resolveSegment(floored, full.length), full);
	// Trimmed down to exactly its floor: pre (1) + eight columns of flex + post (4).
	assert.equal(stripAnsi(resolveSegment(floored, 13)), " Running… 14s");
	for (let avail = 1; avail < 13; avail++) assert.equal(resolveSegment(floored, avail), "", `@${avail}: absent, not a stub`);
	// The same rung without a floor keeps the old contract: it trims to one column, then hard-truncates.
	const free = [{ pre: " ", flex: "Running npm test…", post: " 14s" }];
	assert.equal(stripAnsi(resolveSegment(free, 6)), " … 14s");
	for (let avail = 1; avail < 6; avail++) {
		const out = resolveSegment(free, avail);
		assert.equal(visibleWidth(out), avail, `@${avail}: hard-truncated to fit`);
	}
	// A flex part shorter than its floor cannot trim: whole or absent.
	const short = [{ pre: "repo · ", flex: "wip", minFlex: 10 }];
	assert.equal(resolveSegment(short, 10), "repo · wip");
	for (let avail = 1; avail < 10; avail++) assert.equal(resolveSegment(short, avail), "", `@${avail}`);
	// Only the last rung decides: a floored rung above an unfloored last one still falls through to it.
	assert.equal(stripAnsi(resolveSegment([...floored, { pre: "repo" }], 3)), "re…");
	// In a row, an absent floored segment leaves its cells blank and the row exact.
	for (let width = 4; width <= 30; width++) {
		const row = layoutRow(floored, "", width);
		assert.equal(visibleWidth(row), width, `@${width}`);
		assert.doesNotMatch(stripAnsi(row), /^ R[a-z]{0,5}…/, `@${width}: never a stub: ${row}`);
	}
});

test("resolveSegment hard-truncates the last candidate when nothing fits", () => {
	const out = resolveSegment([{ pre: "94% · ", post: "Elite " }], 6);
	assert.ok(visibleWidth(out) <= 6);
	assert.equal(resolveSegment(withPersona, 0), "");
});

test("resolveSegment keeps an ellipsis on a hard-truncated numeric label", () => {
	const out = resolveSegment([{ pre: "1337" }], 2);
	assert.equal(visibleWidth(out), 2);
	assert.notEqual(out, "13", "a clipped numeric model must not read like a different model id");
	assert.ok(stripAnsi(out).endsWith("…"), `hard truncation should be visibly marked: ${out}`);
});

test("frameEditor accepts a degradation ladder for the status right segment", () => {
	const ew = 30 - 2 * GUTTER - 2;
	const raw = ["─".repeat(ew), ` hi${" ".repeat(ew - 3)}`, "─".repeat(ew)];
	const out = frameEditor(raw, {
		boxWidth: 30,
		leftMargin: 0,
		style: ROUNDED,
		border: id,
		prompt: "›",
		statusLeft: " ~/x",
		statusRight: [{ pre: "anthropic/opus-4-8 · Elite " }, { pre: "Elite " }],
	});
	const status = out[out.length - 2];
	assert.ok(status.includes("Elite") && !status.includes("anthropic"));
	for (const line of out) assert.equal(visibleWidth(line), 30);
});

test("frameEditor drops the rules and builds a clean rounded box with chrome inside", () => {
	// boxWidth 14 → interior 12 → editor width 12 − 2·GUTTER = 8.
	const ew = 14 - 2 * GUTTER - 2;
	assert.equal(ew, 8);
	const raw = ["─".repeat(ew), " hello  ", "─".repeat(ew)];
	const out = frameEditor(raw, {
		boxWidth: 14,
		leftMargin: 3,
		style: ROUNDED,
		border: id,
		prompt: "›",
		spinner: "⠹",
		statusLeft: "L",
		statusRight: "R",
	});

	assert.equal(out.length, 4); // top + 1 content + status + bottom
	for (const line of out) assert.equal(visibleWidth(line), 3 + 14); // margin + box

	assert.ok(/^ {3}╭─+╮$/.test(out[0])); // continuous top border, no labels cut in
	assert.ok(/^ {3}╰─+╯$/.test(out[out.length - 1]));
	assert.ok(out[1].includes("›") && out[1].includes("hello") && out[1].includes("⠹")); // chrome + content inside
	assert.ok(out[2].includes("L") && out[2].includes("R")); // status row
	assert.ok(!out.slice(1, 3).some((l) => l.includes("─"))); // original rules gone from body
	assert.ok(out[1].startsWith("   │") && out[1].endsWith("│"));
});

test("editor width and right gutter reserve a fixed one- or three-cell spinner through idle and working states", () => {
	for (const columns of [1, 3]) {
		for (const boxWidth of Array.from({ length: 121 }, (_, width) => width)) {
			const editorWidth = editorWidthFor(boxWidth, columns);
			assert.equal(editorWidth, Math.max(0, boxWidth - 2 - GUTTER - 1 - columns));
			const raw = ["─".repeat(editorWidth), "界🙂é".padEnd(editorWidth), "─".repeat(editorWidth)];
			for (const spinner of ["", columns === 3 ? "▲△△" : "⠹"]) {
				const out = frameEditor(raw, { boxWidth, leftMargin: 0, style: ROUNDED, border: id, spinner, spinnerColumns: columns });
				assert.ok(out.every((line) => visibleWidth(line) <= boxWidth), `width ${boxWidth}, cols ${columns}`);
			}
		}
	}
});

test("frameEditor shows no spinner glyph when idle", () => {
	const ew = 14 - 2 * GUTTER - 2;
	const raw = ["─".repeat(ew), " hi     ", "─".repeat(ew)];
	const out = frameEditor(raw, { boxWidth: 14, leftMargin: 0, style: ROUNDED, border: id, prompt: "›", spinner: "" });
	assert.ok(out[1].includes("›") && !out[1].includes("⠹"));
	for (const line of out) assert.equal(visibleWidth(line), 14);
});

test("frameEditor keeps the cursor row full width despite pi-tui's cursor marker", () => {
	// Regression: pi-tui embeds a BEL-terminated APC marker (`\x1b_pi:c\x07`) at the
	// cursor position. If it's miscounted as printable, fit() under-pads that row by
	// 5 columns and the right rail pulls in (seen on first idle render).
	const MARKER = "\x1b_pi:c\x07";
	const ew = 20 - 2 * GUTTER - 2;
	const cursorLine = ` ${MARKER}${" ".repeat(ew - 1)}`; // empty editor: padding + marker + fill
	const raw = ["─".repeat(ew), cursorLine, "─".repeat(ew)];
	const out = frameEditor(raw, {
		boxWidth: 20,
		leftMargin: 2,
		style: ROUNDED,
		border: id,
		prompt: "›",
		spinner: "", // idle — exactly the reported scenario
		statusLeft: "~/x",
		statusRight: "model",
	});
	// Measure what the terminal actually renders: the TUI strips the marker before
	// drawing, so rendered width = visibleWidth of the line with the marker removed.
	// (Measuring the marker-bearing line with visibleWidth would reuse the same
	// ruler fit() used — a miscount would cancel out and hide the bug.)
	for (const line of out) assert.equal(visibleWidth(line.replaceAll(MARKER, "")), 22); // margin + box, every row
	assert.ok(out[1].includes(MARKER)); // marker survives for the TUI to consume
});

test("scrollMarker only fires on Pi's 'N more' rules, not on plain ones", () => {
	assert.equal(scrollMarker("─── ↑ 3 more ──────", "↑"), "↑");
	assert.equal(scrollMarker("─── ↓ 12 more ─────", "↓"), "↓");
	assert.equal(scrollMarker("─── ↑ 3 more ──────", "↓"), ""); // wrong direction
	assert.equal(scrollMarker("─".repeat(20), "↑"), ""); // ordinary rule
	assert.equal(scrollMarker(undefined, "↓"), "");
});

test("frameEditor re-hangs the editor's scroll indicators in the side gutters", () => {
	// Pi renders "more content above/below" *into* the rules we drop. Without this
	// the box would silently hide the fact that the buffer continues.
	const ew = 20 - 2 * GUTTER - 2;
	const row = (s: string) => s.padEnd(ew);
	const raw = [`── ↑ 3 more ${"─".repeat(ew - 12)}`, row(" one"), row(" two"), `── ↓ 7 more ${"─".repeat(ew - 12)}`];
	const out = frameEditor(raw, { boxWidth: 20, leftMargin: 0, style: ROUNDED, border: id, prompt: "›", statusLeft: "~" });
	assert.ok(out[1].includes("↑")); // first content row: more above
	assert.ok(out[2].includes("↓")); // last content row: more below
	assert.ok(!out.some((l) => l.includes("more"))); // the rules themselves stay dropped
	for (const line of out) assert.equal(visibleWidth(line), 20);
});

test("frameEditor lets the spinner win row 0's gutter over the ↑ marker", () => {
	const ew = 20 - 2 * GUTTER - 2;
	const row = (s: string) => s.padEnd(ew);
	const raw = [`── ↑ 3 more ${"─".repeat(ew - 12)}`, row(" one"), "─".repeat(ew)];
	const out = frameEditor(raw, { boxWidth: 20, leftMargin: 0, style: ROUNDED, border: id, prompt: "›", spinner: "⠹" });
	assert.ok(out[1].includes("⠹") && !out[1].includes("↑")); // motion beats the hint
	for (const line of out) assert.equal(visibleWidth(line), 20);
});

test("colored two-row status rows exactly fill the host-measured spinner slot at every supported width", () => {
	useTerminalMetrics({ visibleWidth: hostVisibleWidth, truncateToWidth: hostTruncateToWidth });
	try {
		for (const columns of [1, 2, 3]) {
			const boxWidth = 50;
			const ew = editorWidthFor(boxWidth, columns);
			const color = (s: string) => `\u001b[38;2;213;31;42m${s}\u001b[39m`;
			const spinnerRows = [color("x".repeat(columns)), color("y".repeat(columns))];
			for (const spinner of ["", color("?"), color("x".repeat(columns))]) {
				const out = frameEditor(["─".repeat(ew), " input".padEnd(ew), "─".repeat(ew)], {
					boxWidth, leftMargin: 0, style: ROUNDED, border: color, spinnerColumns: columns,
					spinnerHeight: 2, spinnerRows, spinner, statusLeft: color("workspace"),
				});
				assert.equal(hostVisibleWidth(out[1]), boxWidth, `body width, columns=${columns}, spinner=${JSON.stringify(spinner)}`);
				assert.equal(hostVisibleWidth(out[2]), boxWidth, `status width, columns=${columns}, spinner=${JSON.stringify(spinner)}`);
			}
		}
	} finally {
		useTerminalMetrics();
	}
});

test("two-row logo uses status slot for one input row and content row for multiline input", () => {
	const boxWidth = 50;
	const ew = editorWidthFor(boxWidth, 3);
	const options = { boxWidth, leftMargin: 0, style: ROUNDED, border: id, spinnerColumns: 3, spinnerHeight: 2, spinner: " ▲ ", spinnerRows: [" ▲ ", "△ △"], statusLeft: "WORKSPACE", statusRight: "USAGE", borderLabel: [{ pre: "anthropic/opus-4-8 · high" }] };
	const single = frameEditor(["─".repeat(ew), " input".padEnd(ew), "─".repeat(ew)], options);
	assert.equal(stripAnsi(single[1]).slice(-5, -1), " ▲  ");
	assert.equal(stripAnsi(single[2]).slice(-5, -1), "△ △ ");
	assert.ok(stripAnsi(single[2]).includes("WORKSPACE"));
	const multi = frameEditor(["─".repeat(ew), " input".padEnd(ew), " second".padEnd(ew), "─".repeat(ew)], options);
	assert.equal(stripAnsi(multi[2]).slice(-5, -1), "△ △ ");
	assert.equal(multi.length, 5, "logo consumes existing content/status rows only");
	assert.equal(visibleWidth(stripAnsi(single[2])), boxWidth);
});

test("down-scroll marker uses the fourth gutter cell beside the lower triangle", () => {
	const boxWidth = 50;
	const ew = editorWidthFor(boxWidth, 3);
	const out = frameEditor(["─".repeat(ew), " input".padEnd(ew), " second".padEnd(ew), "──── ↓ 3 more"], {
		boxWidth, leftMargin: 0, style: ROUNDED, border: id, spinnerColumns: 3, spinnerHeight: 2,
		spinner: " ▲ ", spinnerRows: [" ▲ ", "△ △"], statusLeft: "status",
	});
	assert.ok(stripAnsi(out[2]).endsWith("△ △↓│"));
	for (const line of out) assert.ok(visibleWidth(line) <= boxWidth);
});

test("two-row logo compact autocomplete fallback keeps original suggestion index and only top row", () => {
	const boxWidth = 50;
	const ew = editorWidthFor(boxWidth, 3);
	const out = frameEditor(["─".repeat(ew), " input".padEnd(ew), "─".repeat(ew), "suggest".padEnd(ew)], {
		boxWidth, leftMargin: 0, style: ROUNDED, border: id, spinnerColumns: 3, spinnerHeight: 2,
		spinner: " ▲ ", spinnerRows: [" ▲ ", "△ △"], statusLeft: "STATUS",
	});
	assert.equal(out.length, 4);
	assert.ok(stripAnsi(out[1]).includes(" ▲ "));
	assert.ok(!stripAnsi(out[1]).includes("▲△△"));
	assert.ok(stripAnsi(out[3]).includes("suggest"));
	assert.ok(out[3].trimStart().startsWith("suggest"), "first suggestion remains at its original framed row");
});

test("pyramid frames never overflow for all terminal widths 0 through 120", () => {
	const rows = [" ▲ ", "△ △"];
	for (let width = 0; width <= 120; width++) {
		const boxWidth = Math.min(width, 60);
		const ew = editorWidthFor(boxWidth, 3);
		const raw = ["─".repeat(ew), "input".padEnd(ew), "second".padEnd(ew), "─".repeat(ew)];
		const out = frameEditor(raw, { boxWidth, leftMargin: 0, style: ROUNDED, border: id, spinnerColumns: 3, spinnerHeight: 2, spinner: rows[0], spinnerRows: rows, statusLeft: "x" });
		for (const line of out) assert.ok(visibleWidth(line) <= width, `width=${width}: ${JSON.stringify(stripAnsi(line))}`);
	}
});

test("frameEditor places autocomplete below the box at the base editor's row", () => {
	// boxWidth 12 → interior 10 → editor width 6.
	const ew = 12 - 2 * GUTTER - 2;
	assert.equal(ew, 6);
	const raw = ["─".repeat(ew), " text ", "─".repeat(ew), "/init ", "/clear"];
	const out = frameEditor(raw, { boxWidth: 12, leftMargin: 0, style: ROUNDED, border: id, prompt: "›", statusLeft: "~" });
	// While suggestions are open the status yields its row to the bottom border:
	// top 0, content 1, bottom 2, first suggestion 3 (base: V + 2).
	assert.equal(out.length, 5);
	assert.equal(out[2], "╰──────────╯");
	assert.ok(out[3].includes("/init") && out[4].includes("/clear"));
	assert.ok(!out[3].includes("│") && !out[4].includes("│"), "suggestions must be outside the rails");
	for (const line of out) assert.equal(visibleWidth(line), 12);
});

test("frameEditor preserves autocomplete after Pi's width-4 truncated scroll rule", () => {
	const raw = ["─...", " x  ", "─...", " zz "];
	const out = frameEditor(raw, { boxWidth: 10, leftMargin: 0, style: ROUNDED, border: id, prompt: "›", statusLeft: "~" });
	assert.ok(out.some((line) => line.includes("zz")), "autocomplete row survives below the truncated rule");
	assert.ok(!out.some((line) => line.includes("─...")), "the truncated rule itself is still removed");
	for (const line of out) assert.equal(visibleWidth(line), 10);
});

// Overlay: left uses only lowercase/punctuation; the right carries digits or
// uppercase, so the first such column marks where the protected suffix starts.
const PROTECTED = /[0-9A-Z$%|]/;
const OVERLAY_LEFTS: (string | { pre?: string; flex?: string; post?: string }[])[] = [
	" ~/…/work/repo · main · review",
	" ~/projects/" + "very-long-branch-name/".repeat(4),
	[{ pre: " ~/work/repo", flex: " · main · review" }, { pre: " ~/work/repo" }, { pre: " …/repo" }],
];
const OVERLAY_RIGHTS: (string | { pre?: string; flex?: string; post?: string }[])[] = [
	"70% ",
	[{ pre: "[####-] 70.0K/100K · 70% · $0.25 +$0.10 · ELITE " }, { pre: "70.0K · 70% · $0.25 · ELITE " }, { pre: "70% · ", flex: "ELITE", post: " " }, { pre: "70% " }],
];
const OVERLAYS = [
	[{ pre: " ", flex: "Reading a.ts…" }],
	[{ pre: " ", flex: `Running ${"npm test --watch ".repeat(12)}…` }],
	[{ pre: " ", flex: "Running npm test…", post: " +2" }],
];

test("an overlay never moves the right group at any width", () => {
	let shownSomewhere = 0;
	for (const left of OVERLAY_LEFTS) {
		for (const right of OVERLAY_RIGHTS) {
			for (const overlay of OVERLAYS) {
				for (let width = 10; width <= 160; width++) {
					// Truncation may emit SGR resets; these shapes are one code unit per column once stripped.
					const base = stripAnsi(layoutRow(left, right, width));
					const lit = stripAnsi(layoutRow(left, right, width, overlay));
					const shape = `${JSON.stringify(left)} / ${JSON.stringify(right)} @${width}`;
					assert.equal(visibleWidth(base), width, shape);
					assert.equal(visibleWidth(lit), width, `overlay row is exactly width: ${shape}`);
					const found = base.search(PROTECTED);
					const rightStart = found === -1 ? base.length : found;
					assert.equal(lit.slice(rightStart), base.slice(rightStart), `right moved: ${shape}\n${base}\n${lit}`);
					if (lit.startsWith(` ${overlay[0].flex.slice(0, 4)}`)) {
						shownSomewhere++;
						assert.equal(lit.charAt(rightStart - 1), " ", `one space separates the overlay: ${shape}\n${lit}`);
					}
				}
			}
		}
	}
	assert.ok(shownSomewhere > 1000, `the sweep must exercise visible overlays (${shownSomewhere})`);
});

test("a colored overlay keeps the colored right group byte-identical", () => {
	const color = (s: string) => `\u001b[38;2;1;2;3m${s}\u001b[39m`;
	const left = [{ pre: color(" ~/work/repo"), flex: color(" · main") }, { pre: color(" ~/work/repo") }];
	const right = [{ pre: color("70.0K · 70% · $0.25 ") }, { pre: color("70% ") }];
	for (let width = 20; width <= 120; width++) {
		const base = layoutRow(left, right, width);
		const lit = layoutRow(left, right, width, [{ pre: " ", flex: color("Running npm test…"), post: color(" +2") }]);
		assert.equal(visibleWidth(lit), width);
		const anchor = base.includes(color("70.0K · 70% · $0.25 ")) ? color("70.0K · 70% · $0.25 ") : color("70% ");
		const at = base.indexOf(anchor);
		assert.notEqual(at, -1);
		assert.ok(lit.endsWith(base.slice(at)), `width ${width}: suffix changed`);
		assert.equal(visibleWidth(lit.slice(0, lit.length - (base.length - at))), visibleWidth(base.slice(0, at)), `width ${width}: suffix shifted`);
	}
});

test("a long overlay trims its flex with … and keeps its post", () => {
	const overlay = [{ pre: " ", flex: `Running ${"x".repeat(100)}…`, post: " +2" }];
	const line = stripAnsi(layoutRow(" ~/work/repo", "OPUS-4-8 ", 40, overlay));
	assert.equal(visibleWidth(line), 40);
	assert.match(line, /^ Running x+… \+2 +OPUS-4-8 $/);
	assert.ok(!line.includes("repo"), "the overlay takes the workspace's cells");
});

test("an overlay too narrow to show leaves the normal left segment", () => {
	const overlay = [{ pre: " ", flex: "Running npm test…", post: " +2" }];
	// Region 9 cells → 8 for the overlay, one short of " " + 5 flex cells + " +2".
	assert.equal(layoutRow(" ~/repo", "OPUS-4-8 ", 18, overlay), layoutRow(" ~/repo", "OPUS-4-8 ", 18));
	assert.equal(stripAnsi(layoutRow(" ~/repo", "OPUS-4-8 ", 19, overlay)), " Runn… +2 OPUS-4-8 ");
	assert.equal(layoutRow("", "", 1, overlay), " ");
	assert.equal(layoutRow(" ~/repo", "OPUS ", 20, []), layoutRow(" ~/repo", "OPUS ", 20), "an empty ladder is no overlay");
	// Rungs with no flex part (the run clock) are whole or nothing: never a clipped "Worki…".
	const clock = [{ pre: " Working… 45s" }, { pre: " Working…" }];
	const seen = new Set<string>();
	for (let width = 1; width <= 60; width++) {
		const plain = layoutRow(" ~/work/repo", "OPUS-4-8 ", width);
		const lit = layoutRow(" ~/work/repo", "OPUS-4-8 ", width, clock);
		const shown = lit.startsWith(" Working… 45s ") ? "timed" : lit.startsWith(" Working… ") ? "bare" : "none";
		seen.add(shown);
		if (shown === "none") assert.equal(lit, plain, `@${width}: no room leaves the row exactly as it was`);
		assert.equal(visibleWidth(lit), width);
		assert.doesNotMatch(lit, /W[a-z]*…(?<!Working…)|Working… \d*…/, `@${width}: ${lit}`);
	}
	assert.deepEqual([...seen].sort(), ["bare", "none", "timed"], "every rung appears in the sweep");
});

test("frameEditor paints statusOverlay over the workspace without moving the rest", () => {
	const ew = editorWidthFor(60);
	const raw = ["─".repeat(ew), " hi".padEnd(ew), "─".repeat(ew)];
	const options = { boxWidth: 60, leftMargin: 0, style: ROUNDED, border: id, statusLeft: " ~/work/repo", statusRight: "70% | $0.25 ", borderLabel: [{ pre: "OPUS" }] };
	const idle = frameEditor(raw, options);
	const busy = frameEditor(raw, { ...options, statusOverlay: [{ pre: " ", flex: "Running npm test…", post: " +1" }] });
	assert.deepEqual(busy.slice(0, -2), idle.slice(0, -2));
	assert.equal(busy.at(-1), idle.at(-1));
	const status = busy.at(-2)!;
	assert.ok(status.startsWith("│ Running npm test… +1 "));
	const tail = idle.at(-2)!.slice(idle.at(-2)!.indexOf("70%"));
	assert.ok(status.endsWith(tail));
	assert.equal(visibleWidth(status), 60);
	const none = frameEditor(raw, { boxWidth: 60, leftMargin: 0, style: ROUNDED, border: id, statusOverlay: [{ flex: "Running…" }] });
	assert.equal(none.length, 3, "an overlay alone never adds a status row");
});

test("the sibling count is the first thing to go: it never outlives the label", () => {
	const left = [{ pre: " ~/work/repo", flex: " · main" }, { pre: " …/repo" }];
	const named = { pre: " ", flex: "Running npm test…" };
	const counted = [{ ...named, post: " +2" }, named];
	let exercised = 0;
	for (let width = 20; width <= 120; width++) {
		const base = stripAnsi(layoutRow(left, "70.0K | 70% ", width));
		const rightStart = base.indexOf("70.0K");
		const lit = stripAnsi(layoutRow(left, "70.0K | 70% ", width, counted));
		const bareFits = visibleWidth(" Running npm test…") <= rightStart - 1;
		const countedFits = visibleWidth(" Running npm test… +2") <= rightStart - 1;
		if (bareFits && !countedFits) {
			exercised++;
			assert.ok(lit.startsWith(" Running npm test… ") && !lit.includes("+2"), `width ${width}: the count yields first\n${lit}`);
		}
		if (countedFits) assert.ok(lit.startsWith(" Running npm test… +2 "), `width ${width}: both fit\n${lit}`);
	}
	assert.ok(exercised > 0, "the sweep must hit the widths where only the bare label fits");
	// Too narrow for either rung whole: the count goes, the label trims.
	const cramped = stripAnsi(layoutRow(" ~/repo", "OPUS-4-8 ", 22, counted));
	assert.equal(cramped, " Running np… OPUS-4-8 ");
});

// ---- the top border's one label ----------------------------------------------

const BOX_RAW = (boxWidth: number) => {
	const ew = editorWidthFor(boxWidth);
	return ["─".repeat(ew), " hi".padEnd(ew), "─".repeat(ew)];
};
const tint = (s: string) => `\u001b[38;2;9;8;7m${s}\u001b[39m`;
const muted = (s: string) => `\u001b[2m${s}\u001b[22m`;
const LABEL_LADDERS: Record<string, { pre?: string; flex?: string; post?: string }[]> = {
	short: [{ pre: "gpt" }],
	long: [{ pre: "openai/gpt-6.1-sol · xhigh" }, { flex: "gpt-6.1-sol", post: " · xhigh" }, { flex: "gpt-6.1-sol" }],
	cjk: [{ pre: "提供者/模型名称-界 · 高" }, { flex: "模型名称-界", post: " · 高" }, { flex: "模型名称-界" }],
	ansi: [{ pre: `${muted("openai/")}${tint("gpt-6.1-sol")}${muted(" · ")}${tint("xhigh")}` }, { flex: tint("gpt-6.1-sol"), post: `${muted(" · ")}${tint("xhigh")}` }, { flex: tint("gpt-6.1-sol") }],
	emoji: [{ pre: "🧑‍💻/model-🎯 · max" }, { flex: "model-🎯" }],
	unfit: [{ pre: "x".repeat(300) }],
};

test("the top border is exactly the box width for every width and label ladder, host ruler included", () => {
	for (const metrics of ["mirror", "host"] as const) {
		if (metrics === "host") useTerminalMetrics({ visibleWidth: hostVisibleWidth, truncateToWidth: hostTruncateToWidth });
		try {
			let labelled = 0;
			for (const [name, ladder] of Object.entries(LABEL_LADDERS)) {
				for (let boxWidth = 8; boxWidth <= 200; boxWidth++) {
					for (const border of [id, muted]) {
						const out = frameEditor(BOX_RAW(boxWidth), { boxWidth, leftMargin: 3, style: ROUNDED, border, borderLabel: ladder });
						if (out.length === 0) continue; // below the frame's own minimum
						const at = `${metrics} ${name} @${boxWidth}`;
						for (const row of out) assert.equal(hostVisibleWidth(row), boxWidth + 3, `${at}: ${JSON.stringify(row)}`);
						const top = stripAnsi(out[0]).slice(3);
						if (/[^─╭╮]/.test(top)) {
							labelled++;
							assert.match(top, /^╭─{2,} \S.*\S ──╮$/u, `${at}: corner, ≥2 rules, space, label, space, two rules, corner: ${top}`);
						} else assert.equal(top, `╭${"─".repeat(boxWidth - 2)}╮`, `${at}: plain`);
					}
				}
			}
			assert.ok(labelled > 1500, `the sweep must exercise labelled borders (${labelled})`);
		} finally {
			useTerminalMetrics();
		}
	}
});

test("the label sits between single spaces with exactly two rule cells before the corner", () => {
	const out = frameEditor(BOX_RAW(40), { boxWidth: 40, leftMargin: 0, style: ROUNDED, border: id, borderLabel: [{ pre: "openai/gpt-6.1-sol · xhigh" }] });
	assert.equal(out[0], `╭${"─".repeat(8)} openai/gpt-6.1-sol · xhigh ──╮`);
	// The narrowest box that still keeps two rule cells on the left: 26 label + 6 fixed + 2.
	const tight = frameEditor(BOX_RAW(34), { boxWidth: 34, leftMargin: 0, style: ROUNDED, border: id, borderLabel: [{ pre: "openai/gpt-6.1-sol · xhigh" }] });
	assert.equal(tight[0], "╭── openai/gpt-6.1-sol · xhigh ──╮");
	const over = frameEditor(BOX_RAW(33), { boxWidth: 33, leftMargin: 0, style: ROUNDED, border: id, borderLabel: [{ pre: "openai/gpt-6.1-sol · xhigh" }] });
	assert.equal(over[0], `╭${"─".repeat(31)}╮`, "one column short of the left floor → the plain rule");
	// Only the rule pieces are border-colored; the label keeps its own colors.
	const colored = frameEditor(BOX_RAW(40), { boxWidth: 40, leftMargin: 0, style: ROUNDED, border: muted, borderLabel: LABEL_LADDERS.ansi });
	assert.equal(colored[0], `${muted(`╭${"─".repeat(8)}`)} ${LABEL_LADDERS.ansi[0].pre} ${muted("──╮")}`);
});

test("the border picks the widest rung that fits and trims only the flex part", () => {
	const ladder = LABEL_LADDERS.long;
	const top = (boxWidth: number) => stripAnsi(frameEditor(BOX_RAW(boxWidth), { boxWidth, leftMargin: 0, style: ROUNDED, border: id, borderLabel: ladder })[0]);
	assert.ok(top(34).includes(" openai/gpt-6.1-sol · xhigh "));
	assert.ok(top(33).includes(" gpt-6.1-sol · xhigh ") && !top(33).includes("openai"), top(33));
	assert.ok(top(27).includes(" gpt-6.1-sol · xhigh "), top(27));
	assert.match(top(26), / gpt-6\.1-s… · xhigh ──╮$/, "the model trims while the level stays");
	// The flex floor (5 columns) reached: the level yields and the model stands alone.
	assert.match(top(20), /─ gpt-6\.1-sol ──╮$/);
	assert.equal(top(14), "╭── gpt-6… ──╮", "the last rung trims below the floor");
	assert.equal(top(10), "╭── g… ──╮");
	const widths = new Set<number>();
	for (let w = 10; w <= 120; w++) widths.add(visibleWidth(top(w)) - w);
	assert.deepEqual([...widths], [0]);
});

test("no fitting rung leaves the border byte-identical to a frame without a label", () => {
	for (let boxWidth = 8; boxWidth <= 120; boxWidth++) {
		const base = { boxWidth, leftMargin: 2, style: ROUNDED, border: muted, statusLeft: " ~/x", statusRight: "70% " };
		const plain = frameEditor(BOX_RAW(boxWidth), base);
		assert.deepEqual(frameEditor(BOX_RAW(boxWidth), { ...base, borderLabel: LABEL_LADDERS.unfit }), plain, `@${boxWidth}`);
		assert.deepEqual(frameEditor(BOX_RAW(boxWidth), { ...base, borderLabel: [] }), plain, `empty ladder @${boxWidth}`);
		assert.deepEqual(frameEditor(BOX_RAW(boxWidth), { ...base, borderLabel: undefined }), plain);
		// A label with no visible content is no label: never "╭──────  ──╮".
		for (const blank of [[{ flex: muted("") }], [{ pre: "   " }], [{ pre: muted(""), post: " " }], [{ flex: "" }]]) {
			assert.deepEqual(frameEditor(BOX_RAW(boxWidth), { ...base, borderLabel: blank }), plain, `blank ${JSON.stringify(blank)} @${boxWidth}`);
		}
		// Everything below the top edge is unaffected by any label.
		assert.deepEqual(frameEditor(BOX_RAW(boxWidth), { ...base, borderLabel: LABEL_LADDERS.long }).slice(1), plain.slice(1), `body @${boxWidth}`);
	}
	// A last rung that could only show a lone "…" is no label either.
	const lone = frameEditor(BOX_RAW(9), { boxWidth: 9, leftMargin: 0, style: ROUNDED, border: id, spinnerColumns: 1, borderLabel: [{ flex: "model" }] });
	assert.equal(lone[0], `╭${"─".repeat(7)}╮`);
});

test("the bottom border stays plain and the label never enters the body, scroll markers or autocomplete rows", () => {
	const ew = editorWidthFor(40);
	const raw = [`── ↑ 3 more ${"─".repeat(ew - 12)}`, " one".padEnd(ew), " two".padEnd(ew), `── ↓ 7 more ${"─".repeat(ew - 12)}`, "  /init".padEnd(ew)];
	const out = frameEditor(raw, { boxWidth: 40, leftMargin: 0, style: ROUNDED, border: id, prompt: "›", statusLeft: "~", borderLabel: LABEL_LADDERS.long });
	assert.match(out[0], / openai\/gpt-6\.1-sol · xhigh ──╮$/);
	assert.ok(out[1].includes("↑") && out[2].includes("↓"));
	assert.equal(out[3], `╰${"─".repeat(38)}╯`);
	assert.ok(out[4].includes("/init"), "autocomplete keeps its row below the box");
	assert.equal(out.filter(row => row.includes("gpt")).length, 1);
});
