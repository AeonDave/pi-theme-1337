import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth as hostVisibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULT_SPINNER, parseSpinner, spinnerFrame } from "../src/spinner.ts";
import { useTerminalMetrics } from "../src/width.ts";

test("default spinner and valid themed profiles retain fixed host-measured geometry", () => {
	useTerminalMetrics({ visibleWidth: hostVisibleWidth, truncateToWidth });
	try {
		assert.equal(DEFAULT_SPINNER.intervalMs, 90);
		assert.equal(DEFAULT_SPINNER.columns, 1);
		assert.equal(DEFAULT_SPINNER.frames.length, 10);
		for (const input of [
			{ frames: ["|", "/", "\\", "-"], intervalMs: 120 },
			{ frames: [[" ▲ ", "△ △"], [" △ ", "▲ △"], [" △ ", "△ ▲"]], intervalMs: 180 },
		]) {
			const profile = parseSpinner(input);
			assert.ok(profile);
			assert.equal(profile.columns, Array.isArray(input.frames[0]) ? 3 : 1);
			assert.ok(profile.frames.every((frame) => hostVisibleWidth(frame) === profile.columns));
		}
		for (const theme of ["1337", "1337-amber", "1337-ice", "1337-cyber", "1337-neon", "1337-split", "1337-fallout", "1337-skynet"]) {
			const sidecar = JSON.parse(readFileSync(new URL(`../themes/${theme}.pi1337`, import.meta.url), "utf8"));
			const profile = parseSpinner(sidecar.spinner);
			assert.ok(profile, `${theme}: bundled spinner profile parses`);
			assert.ok(profile.frames.every((frame) => hostVisibleWidth(frame) === profile.columns), `${theme}: every bundled frame matches host width`);
			if (theme === "1337-skynet") {
				assert.equal(profile.height, 2);
				assert.deepEqual(profile.frameRows(0), [" ▲ ", "△ △"]);
				assert.deepEqual(profile.color, { kind: "rgb", r: 213, g: 31, b: 42 });
				assert.doesNotMatch(JSON.stringify(profile.frames), /▲△△|△▲△|△△▲/);
			} else {
				assert.equal(profile.height, 1, `${theme}: legacy profile stays single-row`);
				assert.equal(profile.color, undefined, `${theme}: semantic accent remains default`);
			}
		}
	} finally {
		useTerminalMetrics();
	}
});

test("malformed, controlled, overlong, and variably sized profiles are rejected", () => {
	for (const frames of [[], Array(33).fill("x"), [""], ["   "], ["x\ny"], ["x\ty"], ["\x1b[31mx"], ["\u202e"], ["x", "xx"], ["x".repeat(257)], [["x", ""], ["y", "z"]], [["x", "y"], ["z"]], [["x", "y", "z"], ["a", "b", "c"]], [["x", "y"], ["z", "bb"]], [["x", "\u202e"]]]) {
		assert.equal(parseSpinner({ frames }), undefined, JSON.stringify(frames));
	}
	assert.equal(parseSpinner({ frames: ["x"], intervalMs: 59 }), undefined);
	assert.equal(parseSpinner({ frames: ["x"], intervalMs: 501 }), undefined);
	for (const color of ["red", "#fff", "#gg0000", "#d51f2a\n", "\u001b[31m#d51f2a"]) assert.equal(parseSpinner({ frames: ["x"], color }), undefined);
	assert.deepEqual(parseSpinner({ frames: ["x"], color: "#D51F2A" })?.color, { kind: "rgb", r: 213, g: 31, b: 42 });
	assert.equal(parseSpinner(null), undefined);
});

test("frame selection safely wraps arbitrary modular indexes", () => {
	assert.equal(spinnerFrame(DEFAULT_SPINNER, -1), DEFAULT_SPINNER.frames.at(-1));
	assert.equal(spinnerFrame(DEFAULT_SPINNER, 10), DEFAULT_SPINNER.frames[0]);
});
