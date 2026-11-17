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

test("footer render only notices a displaced editor; handing the chrome back waits for a microtask", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
	const body = source.match(/const renderFooter = \(\) => \{([\s\S]*?)\n\s*\};/)?.[1];
	assert.ok(body, "renderFooter body not found");
	assert.match(body, /scheduleDisplacementCheck\s*\(/);
	assert.doesNotMatch(body, /setFooter\s*\(|setWorkingVisible\s*\(|setEditorComponent\s*\(|stopSpinner\s*\(/, "renderFooter mutates chrome during render");
	const scheduled = source.match(/const scheduleDisplacementCheck = [\s\S]*?\n\t\};/)?.[0];
	assert.ok(scheduled?.includes("queueMicrotask("), "the hand-back runs from a microtask");
});

test("quota is pure, read from a cache on the render path, and makes no request or timer of its own", () => {
	const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "src", name), "utf8");
	const quota = read("quota.ts");
	assert.deepEqual([...quota.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]), ["./format.ts"], "quota.ts imports nothing from Pi");
	assert.doesNotMatch(quota, /Date\.now\s*\(|new Date\s*\(|setTimeout\s*\(|setInterval\s*\(|queueMicrotask\s*\(|fetch\s*\(|process\.|node:/, "time is injected; no clock, timer, I/O or network");
	// The editor takes the cached view and nothing else of the module.
	const editor = read("editor.ts");
	assert.deepEqual([...editor.matchAll(/^import (type )?.* from "\.\/quota\.ts";$/gm)].map((match) => match[1]), ["type "]);
	const index = read("index.ts");
	const footer = index.match(/const renderFooter = \(\) => \{([\s\S]*?)\n\s*\};/)?.[1] ?? "";
	assert.doesNotMatch(footer, /quota/i, "the footer's render does not touch the quota");
	assert.match(index, /getQuota: \(\) => cachedQuota,/, "the editor reads the cached view");
	assert.equal([...index.matchAll(/quotaView\s*\(/g)].length, 1, "one place computes the view: refreshQuota, on events");
	assert.doesNotMatch(index, /fetch\s*\(|https?:\/\//, "no request of our own");
	assert.doesNotMatch(index.replace(/timer = setInterval\(/, ""), /setInterval\s*\(|setTimeout\s*\(/, "the spinner's interval is the only timer");
});

test("inline avatar images preserve Pi cursor accounting and re-check live capabilities", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
	assert.match(source, /new Image\s*\(/, "avatar images must reuse Pi's cursor-safe Image component");
	assert.match(source, /getCapabilities\(\)\.images === imageProtocol/, "fullscreen must not replay a cached iTerm2 sequence");
});
