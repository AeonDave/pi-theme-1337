import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseBox } from "../src/width.ts";

test("chooseBox centers a capped box on a wide terminal", () => {
	const g = chooseBox(120, 100, 2);
	assert.equal(g.fallback, false);
	assert.equal(g.boxWidth, 100); // capped at maxWidth
	assert.equal(g.leftMargin, 10); // (120 - 100) / 2
});

test("chooseBox keeps the side margin while the box stays wide enough", () => {
	const g = chooseBox(30, 100, 2);
	// width - 2*margin = 26 (>= 24), so the box keeps its 2-col margins
	assert.equal(g.fallback, false);
	assert.equal(g.boxWidth, 26);
	assert.equal(g.leftMargin, 2);
});

test("chooseBox trades the margin for width when the box would get too thin", () => {
	const g = chooseBox(25, 100, 2);
	// width - 2*margin = 21 (< 24) → boxWidth = min(width - 2, maxWidth) = 23, margin collapses to 1
	assert.equal(g.fallback, false);
	assert.equal(g.boxWidth, 23);
	assert.equal(g.leftMargin, 1);
});

test("chooseBox falls back to the bare editor when the terminal is too tiny to frame", () => {
	assert.equal(chooseBox(7, 100, 2).fallback, true);
	assert.equal(chooseBox(4, 100, 2).fallback, true);
});
