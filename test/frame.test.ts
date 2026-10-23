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

test("layoutRow spans exactly width with left, center, and right segments", () => {
	const line = layoutRow(" left ", " 12.3k · 6% ", " right ", 40);
	assert.equal(visibleWidth(line), 40);
	assert.ok(line.includes(" left ") && line.includes(" right ") && line.includes(" 12.3k · 6% "));
	const before = line.indexOf("1") - line.indexOf("left"); // fill exists on the left of center
	assert.ok(before > 2);
});

test("layoutRow drops the center segment when there's no room", () => {
	const line = layoutRow(" left ", " center ", " right ", 16);
	assert.equal(visibleWidth(line), 16);
	assert.ok(!line.includes("center"));
	assert.ok(line.includes("left") && line.includes("right"));
});

test("layoutRow truncates side segments rather than overflowing", () => {
	const line = layoutRow("a-very-long-left-label", "", "and-right", 16);
	assert.ok(visibleWidth(line) <= 16);
});

test("layoutRow bounds long left metadata without starving context and useful right metadata", () => {
	const left = " ~/…/project/src · feature/" + "long-branch/".repeat(8) + " · session-name";
	const right = [
		{ pre: "3 agents  anthropic/opus-4-8 · Elite " },
		{ pre: "3 agents  ", flex: "opus-4-8", post: " · Elite " },
		{ pre: "3 agents  ", post: "Elite " },
	];

	for (const width of [80, 120]) {
		const line = layoutRow(left, "1.2M · 94%", right, width);
		const plain = stripAnsi(line);
		assert.equal(visibleWidth(line), width);
		assert.ok(plain.includes("94%"), `context percentage should survive at ${width} columns: ${plain}`);
		assert.ok(plain.includes("Elite"), `a useful right-side label should survive at ${width} columns: ${plain}`);
		assert.ok(plain.includes("opus-4-8"), `the model should remain identifiable at ${width} columns: ${plain}`);
		assert.ok(plain.includes("…"), `oversized left metadata should be visibly abbreviated at ${width} columns: ${plain}`);
	}
});

test("layoutRow lets long left metadata yield to useful right metadata when center is empty", () => {
	const left = " ~/…/project/src · feature/" + "long-branch/".repeat(8) + " · session-name";
	for (const width of [80, 120]) {
		const line = layoutRow(left, "", withPersona, width);
		const plain = stripAnsi(line);
		assert.equal(visibleWidth(line), width);
		assert.ok(plain.includes("Elite"), `persona should survive at ${width} columns: ${plain}`);
		assert.ok(plain.includes("opus-4-8"), `model should remain identifiable at ${width} columns: ${plain}`);
		assert.ok(plain.includes("…"), `oversized left metadata should be visibly abbreviated at ${width} columns: ${plain}`);
	}
});

test("layoutRow drops an unfit center before allowing long left metadata to starve the right", () => {
	const line = layoutRow("~/project · " + "long-branch/".repeat(8), "this center can never fit here", withPersona, 40);
	const plain = stripAnsi(line);
	assert.equal(visibleWidth(line), 40);
	assert.ok(plain.includes("Elite") && plain.includes("opus-4-8"), `useful right rung should survive: ${plain}`);
	assert.ok(plain.includes("…"), `oversized left metadata should yield: ${plain}`);
	assert.ok(!plain.includes("this center"), `unfit center should remain optional: ${plain}`);
});

test("layoutRow preserves the workspace identity when provider detail becomes affordable", () => {
	const left = [
		{ pre: " …/Sources/pi-persona", flex: " · feature/restore-context-indicator · Fix session resume status" },
		{ pre: " …/Sources/pi-persona" },
		{ pre: " …/pi-persona" },
	];
	const right = [
		{ pre: "3 agents  claude-pro-max-native/opus-4-8 · 1337 " },
		{ pre: "3 agents  ", flex: "opus-4-8", post: " · 1337 " },
		{ pre: "3 agents  ", post: "1337 " },
	];

	for (const width of [40, 60, 80, 90, 120]) {
		const line = layoutRow(left, "182.0k · 91% · ~$0.250", right, width);
		const plain = stripAnsi(line);
		assert.equal(visibleWidth(line), width);
		assert.ok(plain.includes("pi-persona"), `workspace identity should survive at ${width} columns: ${plain}`);
	}
});

// The status row's right segment degrades semantically, not char-by-char: the
// editor hands layoutRow a ladder of candidates (widest first). `flex` marks
// the model as the only part allowed to trim with `…`; pre/post stay verbatim.
const withPersona = [
	{ pre: "3 agents  anthropic/opus-4-8 · Elite " }, // full: provider slug + persona
	{ pre: "3 agents  ", flex: "opus-4-8", post: " · Elite " }, // provider hidden; model may trim
	{ pre: "3 agents  ", post: "Elite " }, // tightest: persona only
];
const LEFT = "~/x · main"; // 10 cols

test("layoutRow keeps the full provider slug while it fits", () => {
	const line = layoutRow(LEFT, "", withPersona, 60);
	assert.equal(visibleWidth(line), 60);
	assert.ok(line.includes("anthropic/opus-4-8") && line.includes("Elite"));
});

test("layoutRow hides the provider first when narrowing", () => {
	const line = layoutRow(LEFT, "", withPersona, 40);
	assert.equal(visibleWidth(line), 40);
	assert.ok(!line.includes("anthropic/"));
	assert.ok(line.includes("opus-4-8") && line.includes("Elite")); // model still whole
});

test("layoutRow then trims the model with … keeping the persona intact", () => {
	const line = layoutRow(LEFT, "", withPersona, 36);
	assert.equal(visibleWidth(line), 36);
	const plain = stripAnsi(line);
	assert.ok(!plain.includes("opus-4-8")); // model no longer whole …
	assert.ok(plain.includes("…")); // … but trimmed, not dropped
	assert.ok(plain.includes("Elite") && plain.includes(LEFT)); // persona + path untouched
});

test("layoutRow finally keeps the path left and the persona right, model hidden", () => {
	const line = layoutRow(LEFT, "", withPersona, 30);
	assert.equal(visibleWidth(line), 30);
	const plain = stripAnsi(line);
	assert.ok(!plain.includes("opus") && !plain.includes("…")); // model gone entirely
	assert.ok(plain.includes("Elite") && plain.includes(LEFT));
});

test("layoutRow without a persona keeps trimming the model as the last resort", () => {
	const noPersona = [{ pre: "anthropic/opus-4-8 " }, { flex: "opus-4-8", post: " " }];
	const line = layoutRow("~/x", "", noPersona, 8);
	assert.equal(visibleWidth(line), 8);
	assert.ok(stripAnsi(line).includes("op…")); // below the usual floor: last candidate still trims
});

test("resolveSegment hard-truncates the last candidate when nothing fits", () => {
	const out = resolveSegment([{ pre: "3 agents  ", post: "Elite " }], 6);
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
	const options = { boxWidth, leftMargin: 0, style: ROUNDED, border: id, spinnerColumns: 3, spinnerHeight: 2, spinner: " ▲ ", spinnerRows: [" ▲ ", "△ △"], statusLeft: "WORKSPACE", statusCenter: "USAGE", statusRight: "MODEL" };
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
