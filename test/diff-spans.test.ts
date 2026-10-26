import assert from "node:assert/strict";
import { test } from "node:test";
import { changedSpans } from "../src/diff-spans.ts";

const changed = (text: string, spans: Array<{ start: number; end: number }>) => spans.map(span => text.slice(span.start, span.end));

test("separate changed words leave the common middle and punctuation unmarked", () => {
	const before = "const first = 'red'; const last = 'small';";
	const after = "const first = 'green'; const last = 'large';";
	const spans = changedSpans(before, after);
	assert.deepEqual(changed(before, spans.before), ["red", "small"]);
	assert.deepEqual(changed(after, spans.after), ["green", "large"]);
});

test("refines replacement edges and handles insertion, deletion, and identical input", () => {
	for (const [before, after, old, next] of [
		["older", "newer", ["old"], ["new"]],
		["value = 1;", "value = 10;", [], ["0"]],
		["a + extra + z", "a + z", ["extra + "], []],
		["same", "same", [], []],
		["", "new", [], ["new"]],
	] as const) {
		const spans = changedSpans(before, after);
		assert.deepEqual(changed(before, spans.before), old);
		assert.deepEqual(changed(after, spans.after), next);
	}
});

test("span boundaries preserve composed characters, emoji sequences, and CJK", () => {
	const before = "let é = '👩‍💻'; // 赤";
	const after = "let è = '👨‍💻'; // 青";
	const spans = changedSpans(before, after);
	assert.deepEqual(changed(before, spans.before), ["é", "👩‍💻", "赤"]);
	assert.deepEqual(changed(after, spans.after), ["è", "👨‍💻", "青"]);
	for (const [text, ranges] of [[before, spans.before], [after, spans.after]] as const) {
		const boundaries = new Set([0, text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), part => part.index)]);
		for (const range of ranges) assert.ok(boundaries.has(range.start) && boundaries.has(range.end));
	}
});

test("oversized input and token budgets fall back without an expensive comparison", () => {
	assert.deepEqual(changedSpans("x".repeat(8193), "y".repeat(8193)), { before: [], after: [] });
	assert.deepEqual(changedSpans("a ".repeat(300), "b ".repeat(300)), { before: [], after: [] });
});
