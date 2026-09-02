import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("footer render only detects a theme switch; I/O and UI mutation stay outside render", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
	const body = source.match(/const renderFooter = \(\) => \{([\s\S]*?)\n\s*\};/)?.[1];
	assert.ok(body, "renderFooter body not found");
	assert.doesNotMatch(body, /refreshThemeConfig\s*\(/, "renderFooter performs synchronous config I/O and widget mutation");
	assert.match(body, /scheduleThemeConfigRefresh\s*\(/, "theme switches still need a deferred refresh");
});

test("inline avatar images preserve Pi cursor accounting and re-check live capabilities", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
	assert.match(source, /new Image\s*\(/, "avatar images must reuse Pi's cursor-safe Image component");
	assert.match(source, /getCapabilities\(\)\.images === imageProtocol/, "fullscreen must not replay a cached iTerm2 sequence");
});
