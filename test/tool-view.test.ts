import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { isPolishedTool } from "../src/tool-lexicon.ts";
import { createRunSummaryView, createToolView, flatInnerWidth, flatRow, resultRole, safeExpandedText, safeOutput, statusRole } from "../src/tool-view.ts";
import { stripAnsi, useTerminalMetrics } from "../src/width.ts";

useTerminalMetrics({ visibleWidth, truncateToWidth });
type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
const tokens = ["dim", "accent", "success", "error", "toolTitle", "toolOutput", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext"];
function palette() {
	let generation = 0;
	const theme = {
		fg(token: string, text: string) { return `\x1b[38;5;${20 + tokens.indexOf(token) + generation}m${text}\x1b[39m`; },
		bg(token: string, text: string) { return `\x1b[48;5;${token === "toolSuccessBg" ? 40 + generation : 50 + generation}m${text}\x1b[49m`; },
		bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
	} as Theme;
	return { theme, change() { generation += 10; } };
}
const theme = palette().theme;
function context(patch: Partial<Context> = {}): Context {
	return { keyText: () => "", keyHint: (_keybinding, description) => description, args: {}, toolCallId: "test", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/work", executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: true, isError: false, durationMs: 123, outputPad: 1, ...patch };
}
function result(text: string, details?: unknown): Result {
	return { content: [{ type: "text", text }], details };
}
function call(name: string, args: Record<string, unknown> = {}, patch: Partial<Context> = {}, th = theme): Component {
	return createToolView(name, () => "ctrl+o expand").renderCall!(args, th, context({ args, ...patch }));
}
function output(name: string, text: string, patch: Partial<Context> = {}, details?: unknown, th = theme, dependencies?: { highlightCode?: (code: string, path: string) => string[] }): Component {
	const ctx = context(patch);
	return createToolView(name, () => "ctrl+o expand", dependencies).renderResult!(result(text, details), { expanded: ctx.expanded, isPartial: ctx.isPartial }, th, ctx);
}
const plain = (component: Component, width = 120) => component.render(width).map(stripAnsi).join("\n");

test("exports builtin predicate and self-rendering contract, generic fallback works", () => {
	for (const name of ["bash", "read", "grep", "find", "ls", "edit", "write"]) assert.equal(isPolishedTool(name), true);
	for (const name of ["unknown", "BASH", "toString", "__proto__"]) assert.equal(isPolishedTool(name), false);
	const view = createToolView("custom_tool", () => "expand");
	assert.equal(view.renderShell, "self");
	assert.match(plain(call("custom_tool")), /●.*custom_tool/);
	assert.match(plain(output("custom_tool", "actual custom result")), /actual custom result/);
});

test("one-line headers use cwd, duration and bounded safe human labels", () => {
	assert.match(plain(call("read", { path: "/work/src/a.ts" }, { durationMs: 4210 })), /● Read src\/a.ts · 4.2s/);
	assert.match(plain(call("read", { path: "/workspace/a.ts" })), /\/workspace\/a.ts/);
	assert.match(plain(call("read", { path: "C:\\WORK\\src\\a.ts" }, { cwd: "c:\\work" })), /src\/a.ts/);
	assert.match(plain(call("grep", { pattern: "needle", path: "/work/src" })), /Search.*needle.*src/);
	assert.match(plain(call("ls")), /List \./);
	const unsafe = "ok\nFORGED\r\x1b[2J\x1b]52;c;evil\x07\x1b_Ga=T;evil\x1b\\\u202e\u2066end";
	const rows = call("read", { path: unsafe }).render(120);
	assert.equal(rows.length, 1);
	assert.doesNotMatch(stripAnsi(rows[0]), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|evil/);
	assert.ok(call("bash", { command: "x".repeat(1_000_000) }).render(120)[0].length < 500);
});

test("dot states distinguish waiting, running, success, error, and historical completion", () => {
	for (const [patch, token] of [
		[{ isPartial: true, executionStarted: false }, "dim"],
		[{ isPartial: true, executionStarted: true }, "accent"],
		[{ isPartial: false }, "success"],
		[{ isPartial: false, executionStarted: false, durationMs: undefined }, "success"],
		[{ isPartial: true, isError: true }, "error"],
	] as const) assert.ok(call("read", {}, patch).render(80)[0].includes(theme.fg(token, "●")), token);
});

test("successful routine tools keep collapsed output in the header, while generic tools retain previews", () => {
	for (const name of ["bash", "read", "grep", "find", "ls"]) {
		const header = plain(call(name, { command: "run", path: "/work/a.ts" }));
		assert.match(header, /ctrl\+o expand/, name);
		const component = output(name, "first useful line\nsecond useful line");
		assert.doesNotMatch(plain(component), /first useful line|second useful line|No text output/);
		assert.equal(component.render(80).length, 0, name);
	}
	assert.match(plain(output("unknown", "first useful line")), /first useful line/);
});

test("errors retain diagnostics even collapsed, partial file results do not pretend completion", () => {
	for (const name of ["bash", "read", "grep", "find", "ls", "edit", "write", "unknown"]) {
		const error = output(name, "\n\nPermission denied\nexplanation\nlast diagnostic", { isError: true });
		assert.match(plain(error), /Permission denied/);
		assert.match(plain(error), /last diagnostic/);
		assert.ok(error.render(120).some(row => row.includes("\x1b[38;5;23m")));
		const partial = output(name, "still processing", { isPartial: true, args: { content: "not yet written" } }, { diff: "+1 not yet committed" });
		assert.match(plain(partial), /still processing/);
		assert.doesNotMatch(plain(partial), /Added|removed|File.content preview|Wrote|not yet committed|not yet written/);
	}
});

test("collapsed large errors show the expansion hint above the last three diagnostic rows; expanded retains all", () => {
	const diagnostics = [...Array.from({ length: 100 }, (_, i) => `diagnostic-${i}`), "Permission denied", "Cannot open file", "Check permissions"];
	for (const name of ["bash", "read", "edit", "write", "unknown"]) {
		const text = "\n\n" + diagnostics.join("\n") + "\n\n";
		const collapsed = output(name, text, { isError: true });
		assert.equal(collapsed.render(80).length, 4);
		assert.equal(plain(collapsed), " └ … earlier output (ctrl+o expand)\n   Permission denied\n   Cannot open file\n   Check permissions");
		assert.doesNotMatch(plain(collapsed), /diagnostic-/);
		const expanded = plain(output(name, text, { isError: true, expanded: true }));
		for (const diagnostic of diagnostics) assert.ok(expanded.includes(diagnostic), diagnostic);
		for (let width = 0; width <= 120; width++) {
			const rows = collapsed.render(width);
			assert.ok(rows.length <= 4);
			for (const row of rows) assert.ok(visibleWidth(row) <= width);
		}
	}
});

test("image-only results identify attachment counts independently of host image support", () => {
	for (const count of [1, 2]) for (const expanded of [false, true]) for (const showImages of [false, true]) {
		const res: Result = {
			content: [{ type: "text", text: "" }, ...Array.from({ length: count }, () => ({ type: "image" as const, data: "SECRET-IMAGE-PAYLOAD", mimeType: "image/png" }))],
			details: undefined,
		};
		const ctx = context({ expanded, showImages });
		const component = createToolView("read", () => "expand").renderResult!(res, { expanded, isPartial: false }, theme, ctx);
		assert.match(plain(component), new RegExp(`${count} image attachment${count === 1 ? "" : "s"}`));
		assert.doesNotMatch(plain(component), /No text output|SECRET-IMAGE-PAYLOAD/);
		assert.doesNotMatch(component.render(120).join(""), /\x1b_G|1337;File/);
		for (let width = 0; width <= 120; width++) for (const row of component.render(width)) assert.ok(visibleWidth(row) <= width);
	}
});

test("expanded text retains every line, long line tail, whitespace, and every text block without image escapes", () => {
	const lines = Array.from({ length: 85 }, (_, i) => `line-${i}`);
	const component = output("read", lines.join("\n"), { expanded: true });
	const rendered = plain(component, 40);
	for (const line of lines) assert.ok(rendered.includes(line), line);
	const long = "abc ".repeat(1200) + "TAIL";
	const wrapped = output("read", long, { expanded: true, outputPad: 0 }).render(37).map(stripAnsi).join("");
	assert.equal(wrapped, long);
	const blocks: Result = { content: [{ type: "text", text: "first" }, { type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "last" }], details: undefined };
	const ctx = context({ expanded: true });
	const out = createToolView("read", () => "expand").renderResult!(blocks, { expanded: true, isPartial: false }, theme, ctx);
	assert.match(plain(out), /first[\s\S]*last/);
	assert.doesNotMatch(out.render(80).join(""), /\x1b_G|1337;File|ignored/);
});

test("expanded arguments that cannot be serialized show a fixed placeholder instead of throwing from render", () => {
	const circular: Record<string, unknown> = { path: "/work/file.ts" };
	circular.self = circular;
	const cases: readonly (readonly [string, Record<string, unknown>])[] = [
		["read", { path: "/work/file.ts", offset: 10n }],
		["read", circular],
		["grep", { pattern: "needle", path: "/work", context: 2n }],
		["custom_tool", { nested: { deep: [1n] } }],
		["custom_tool", { toJSON() { throw new Error("hostile"); } }],
		// bash prints its command as text and serializes only the other arguments.
		["bash", { command: "npm test", timeout: 30n }],
	];
	for (const [name, args] of cases) {
		for (const width of [8, 20, 100]) {
			let text = "";
			assert.doesNotThrow(() => { text = plain(call(name, args, { expanded: true, outputPad: 0 }), width); }, `${name} @${width}`);
			if (width === 100) assert.ok(text.includes("[unavailable arguments]"), `${name}: ${text}`);
		}
		// Collapsed rows never serialize the arguments at all.
		assert.doesNotThrow(() => call(name, args, { outputPad: 0 }).render(100), `${name} collapsed`);
	}
	assert.ok(plain(call("bash", { command: "npm test", timeout: 30n }, { expanded: true, outputPad: 0 }), 100).includes("npm test"), "the command still prints");
	// Serializable arguments are unchanged, and `undefined` from JSON.stringify prints nothing rather than "undefined".
	assert.ok(plain(call("custom_tool", { depth: 3 }, { expanded: true, outputPad: 0 }), 100).includes('"depth": 3'));
});

test("expanded calls expose complete sanitized arguments while collapsed headers stay compact", () => {
	const nested = { path: "/work/" + "p".repeat(9000) + "PATH-TAIL", options: { depth: 3, enabled: true }, list: ["one", { two: "nested" }] };
	const generic = plain(call("custom_tool", nested, { expanded: true, outputPad: 0 }), 100);
	for (const value of ["PATH-TAIL", '"depth": 3', '"enabled": true', '"two": "nested"']) assert.ok(generic.includes(value), value);
	const readArgs = plain(call("read", { path: "/work/file.ts", offset: 120, limit: 40 }, { expanded: true, outputPad: 0 }));
	assert.match(readArgs, /"offset": 120[\s\S]*"limit": 40/);
	const grepArgs = plain(call("grep", { pattern: "needle".repeat(1500) + "PATTERN-TAIL", path: "/work", literal: true, ignoreCase: true, glob: "*.ts" }, { expanded: true, outputPad: 0 }), 100);
	for (const value of ['"literal": true', '"ignoreCase": true', '"glob": "*.ts"', "PATTERN-TAIL"]) assert.ok(grepArgs.includes(value), value);
	const unsafe = plain(call("custom_tool", { value: "ok\\n\u202ehidden\u2066flip\u2069\x1b[31m" }, { expanded: true, outputPad: 0 }));
	assert.match(unsafe, /\\\\n/);
	assert.match(unsafe, /\\u202e[\s\S]*\\u2066[\s\S]*\\u2069/);
	assert.ok(!Array.from(unsafe, char => char.codePointAt(0)!).some(cp => (cp < 0x20 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)));
	const collapsed = call("custom_tool", nested, { outputPad: 0 });
	assert.equal(collapsed.render(100).length, 1);
	assert.ok(plain(collapsed, 100).length < 200);
});

test("expanded bash reveals entire multiline command even before a result exists", () => {
	const command = "first command\nsecond command\n" + "x".repeat(3000) + "LAST-COMMAND";
	const component = call("bash", { command }, { expanded: true, isPartial: true, outputPad: 0 });
	const out = plain(component, 70);
	assert.match(out, /second command/);
	assert.ok(out.replaceAll("\n", "").includes("LAST-COMMAND"));
	assert.equal(call("bash", { command }).render(70).length, 1);
	const unsafeCommand = plain(call("bash", { command: "echo ok\n\u202ehidden\x1b[2J" }, { expanded: true, outputPad: 0 }));
	assert.match(unsafeCommand, /\\u202e/);
	assert.match(unsafeCommand, /\\u001b/);
	assert.doesNotMatch(unsafeCommand, /[\u202a-\u202e\u2066-\u2069\x1b]/);
});

test("edit uses only authoritative multi-edit numbered diff, 16 preview rows and an explicit remainder", () => {
	const diff = [" 1 context", "-2 old", "+2 new", "...", ...Array.from({ length: 20 }, (_, i) => `+${i + 10} added-${i}`), "-99 final old"].join("\n");
	const collapsed = output("edit", "Updated file", { args: { edits: [{ oldText: "FAKE", newText: "FABRICATED" }] } }, { diff });
	const text = plain(collapsed);
	assert.match(text, /Added 21 lines, removed 2 lines/);
	assert.match(text, /9 more lines.*ctrl\+o expand/);
	assert.equal(collapsed.render(120).length, 18);
	assert.doesNotMatch(text, /FABRICATED/);
	const expanded = plain(output("edit", "Updated file", { expanded: true }, { diff }));
	assert.match(expanded, /99 - final old/);
	assert.match(expanded, /Updated file/);
});

test("missing or invalid edit diff shows actual output, never invented zero stats", () => {
	for (const details of [undefined, {}, { diff: null }, { diff: 42 }, { diff: "" }]) {
		const text = plain(output("edit", "Could not obtain diff; actual result", { args: { oldText: "before", newText: "after" } }, details));
		assert.match(text, /Could not obtain diff; actual result/);
		assert.doesNotMatch(text, /Added 0|removed 0|before|after/);
	}
});

test("write preview rows use added foreground and success background in collapsed and expanded views", () => {
	for (const expanded of [false, true]) {
		const rows = output("write", "Saved", { expanded, args: { content: "first\nsecond" } }).render(120);
		const additions = rows.filter(row => stripAnsi(row).includes("1 + first") || stripAnsi(row).includes("2 + second"));
		assert.equal(additions.length, 2);
		for (const row of additions) {
			assert.ok(row.includes("\x1b[38;5;26m"), JSON.stringify(row));
			assert.ok(row.includes("\x1b[48;5;40m"), JSON.stringify(row));
		}
	}
});

test("write shows numbered file-content preview (not actual diff), with correct empty and trailing-newline counts", () => {
	for (const [content, n] of [["", 0], ["a", 1], ["a\n", 1], ["a\nb\n", 2], ["\n", 1]] as const) {
		const text = plain(output("write", "Saved", { args: { content } }));
		assert.match(text, new RegExp(`└ Wrote ${n} line${n === 1 ? "" : "s"}(\n|$)`));
		if (n === 0) assert.doesNotMatch(text, / 1 \+/);
		else assert.match(text, /   1 \+ /);
		assert.doesNotMatch(text, /Added|actual diff|File-content preview/);
	}
	assert.match(plain(output("write", "Saved", { args: {} })), /Saved/);
	assert.match(plain(output("write", "Saved", { expanded: true, args: { content: "a\nb" } })), /Saved/);
});

test("semantic diff colors, clipped +/- and line numbers, theme invalidation and repeat render", () => {
	const mutable = palette();
	const component = output("edit", "ok", {}, { diff: "+12 " + "界".repeat(20) + "\n-13 removed\n 14 context" }, mutable.theme);
	const before = component.render(18);
	assert.ok(before.some(row => row.includes("\x1b[48;5;40m") && row.includes("\x1b[38;5;26m")));
	assert.ok(before.some(row => row.includes("\x1b[48;5;50m") && row.includes("\x1b[38;5;27m")));
	assert.ok(before.some(row => row.includes("\x1b[38;5;28m")));
	assert.match(before.map(stripAnsi).join("\n"), /12 \+ .*…/);
	assert.deepEqual(component.render(18), before);
	mutable.change();
	component.invalidate();
	assert.notDeepEqual(component.render(18), before);
	assert.deepEqual(component.render(18).map(stripAnsi), before.map(stripAnsi));
});

test("plain, absent, and failed context highlighting falls back to semantic theme color", () => {
	const diff = " 1 plain-context-identity";
	const cases: Array<[string, { highlightCode?: (code: string) => string[] } | undefined]> = [
		["missing", undefined],
		["throwing", { highlightCode() { throw new Error("offline"); } }],
		["plain", { highlightCode(code) { return [code]; } }],
	];
	for (const [name, dependencies] of cases) {
		const rows = output("edit", "ok", { expanded: true, outputPad: 0 }, { diff }, theme, dependencies).render(80);
		const row = rows.find(item => stripAnsi(item).includes("plain-context-identity"));
		assert.ok(row, name);
		assert.ok(row.includes("\x1b[38;5;28m"), `${name}: ${JSON.stringify(row)}`);
		assert.ok(stripAnsi(row).includes("plain-context-identity"), name);
	}
});

test("successful context highlighting retains syntax ANSI, semantic gutter, width, and expanded tail", () => {
	const body = "context-" + "x".repeat(200) + "CONTEXT-TAIL";
	const component = output("edit", "ok", { expanded: true, outputPad: 0, args: { path: "/work/a.ts" } },
		{ diff: ` 1 ${body}` }, theme, { highlightCode(code) { return [`\x1b[35m${code}\x1b[39m`]; } });
	const renderedRows = component.render(24);
	const rendered = renderedRows.map(stripAnsi).join("\n");
	const flattened = rendered.replaceAll("\n", "");
	assert.ok(flattened.includes("CONTEXT-TAIL"));
	assert.equal(flattened.split("CONTEXT-TAIL").length - 1, 1);
	assert.ok(renderedRows.some(row => row.includes("\x1b[35m")), "syntax ANSI retained");
	assert.ok(renderedRows.some(row => row.includes("\x1b[38;5;28m")), "semantic gutter base retained");
	for (const row of renderedRows) assert.ok(visibleWidth(row) <= 24);
});

test("aligned gutters preserve diff sign coloring and replacement emphasis for mixed digit widths", () => {
	const component = output("edit", "ok", {}, { diff: "-2 old\n+2 new\n-100 older\n+100 newer\n 10 context" });
	const rendered = component.render(100);
	assert.ok(rendered.some(row => row.includes("\x1b[48;5;50m") && row.includes("old")));
	assert.ok(rendered.some(row => row.includes("\x1b[48;5;40m") && row.includes("new")));
	assert.ok(rendered.some(row => row.includes(theme.bold("new"))));
	assert.ok(rendered.some(row => row.includes(theme.bold("new")) && row.includes("er")));
	assert.ok(rendered.some(row => row.includes("\x1b[38;5;28m") && row.includes("context")));
});

test("expanded JSON and multiline bash arguments visibly escape C1, bidi, and separators", () => {
	const specials = "\u061c\u200e\u200f\u2028\u2029";
	const generic = plain(call("custom_tool", { value: `before${specials}TAIL`, after: "KEEP" }, { expanded: true, outputPad: 0 }));
	for (const cp of ["061c", "200e", "200f", "2028", "2029"]) assert.ok(generic.includes(`\\u${cp}`), cp);
	assert.ok(generic.includes("before") && generic.includes("TAIL") && generic.includes("KEEP"));
	assert.doesNotMatch(generic, /[\u061c\u200e\u200f\u2028\u2029]/);
	const bash = plain(call("bash", { command: `before${specials}TAIL\nnext\u007fEND` }, { expanded: true, outputPad: 0 }));
	for (const cp of ["061c", "200e", "200f", "2028", "2029"]) assert.ok(bash.includes(`\\u${cp}`), cp);
	assert.ok(bash.includes("before") && bash.includes("TAIL") && bash.includes("next") && bash.includes("END"));
	assert.doesNotMatch(bash, /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029]/);
});

test("expanded edit rendering handles 150k numbered rows without spreading line widths", () => {
	const diff = Array.from({ length: 150_000 }, (_, i) => ` ${i + 1} line-${i}`).join("\n");
	const component = output("edit", "ok", { expanded: true, outputPad: 0 }, { diff });
	const rows = component.render(80);
	assert.ok(rows.length > 150_000);
	assert.match(rows.map(stripAnsi).join("\n"), /line-149999/);
});

test("edit diffs align numbered gutters and highlight only sanitized context bodies", () => {
	const seen: Array<[string, string]> = [];
	const dependencies = { highlightCode(code: string, path: string) { seen.push([code, path]); return [`\x1b[35m${code}\x1b[39m`]; } };
	const diff = " 1 const before = 1;\n-2 const old = 2;\n+2 const next = 2;\n 10 const after = 3;";
	const text = plain(output("edit", "ok", { args: { path: "/work/src/file.ts" } }, { diff }, theme, dependencies));
	assert.match(text, /   1   const before = 1;/);
	assert.match(text, /   2 - const old = 2;/);
	assert.match(text, /   2 \+ const next = 2;/);
	assert.match(text, /  10   const after = 3;/);
	assert.deepEqual(seen, [["const before = 1;", "/work/src/file.ts"], ["const after = 3;", "/work/src/file.ts"]]);
	const sanitized: string[] = [];
	const unsafeContext = output("edit", "ok", { args: { path: "/work/a.ts" } }, { diff: " 1 safe\n 2 hostile\u001b[2J" }, theme, { highlightCode(code) { sanitized.push(code); return [`\x1b[35m${code}\x1b[39m`]; } });
	assert.match(plain(unsafeContext), /safe/);
	assert.deepEqual(sanitized, ["safe", "hostile"]);
	for (let width = 0; width <= 50; width++) for (const row of unsafeContext.render(width)) assert.ok(visibleWidth(row) <= width);
	let highlightGeneration = 0;
	const cached = output("edit", "ok", { args: { path: "/work/a.ts" } }, { diff: " 1 const x = 1;" }, theme, { highlightCode(code) { return [`\x1b[${highlightGeneration ? 36 : 35}m${code}\x1b[39m`]; } });
	const before = cached.render(120);
	highlightGeneration++;
	cached.invalidate();
	assert.notDeepEqual(cached.render(120), before);
	const fallback = plain(output("edit", "ok", { args: { path: "/work/a.ts" } }, { diff: " 1 plain context" }, theme, { highlightCode() { throw new Error("unavailable"); } }));
	assert.match(fallback, /plain context/);
});

test("expanded result caches final render by effective width and padding, and invalidation rebuilds it", () => {
	let highlights = 0;
	let measurements = 0;
	const dependencies = { highlightCode(code: string) { highlights++; return [`\x1b[35m${code}\x1b[39m`]; } };
	const ctx = context({ args: { path: "/work/a.ts" }, expanded: true, outputPad: 1 });
	const component = createToolView("edit", () => "expand", dependencies).renderResult!(
		result("ok", { diff: " 1 const first = 1;\n 2 const second = 2;" }), { expanded: true, isPartial: false }, theme, ctx);
	const measuredWidth = visibleWidth;
	const measuredTruncate = truncateToWidth;
	useTerminalMetrics({
		visibleWidth(text) { measurements++; return measuredWidth(text); },
		truncateToWidth(text, width, ellipsis) { measurements++; return measuredTruncate(text, width, ellipsis); },
	});
	try {
		assert.deepEqual(component.render(0), []);
		assert.deepEqual(component.render(Number.NaN), []);
		assert.deepEqual(component.render(Number.POSITIVE_INFINITY), []);
		assert.equal(highlights, 0, "zero and nonfinite widths do not build output rows");
		const first = component.render(40);
		assert.equal(highlights, 2);
		const firstWork = measurements;
		assert.deepEqual(component.render(40), first);
		assert.equal(highlights, 2, "unchanged render must not highlight again");
		assert.equal(measurements, firstWork, "unchanged render must not wrap or measure again");

		const narrower = component.render(30);
		assert.equal(highlights, 4, "a width switch rebuilds highlighted rows");
		assert.notDeepEqual(narrower, first);
		for (const row of narrower) assert.ok(visibleWidth(row) <= 30);

		ctx.outputPad = 3;
		const repadded = component.render(30);
		assert.equal(highlights, 6, "a changed effective padding rebuilds the render");
		assert.ok(repadded.every(row => stripAnsi(row).startsWith("   ")));

		component.invalidate();
		component.render(30);
		assert.equal(highlights, 8, "invalidate clears both rows and the final-render cache");
	} finally {
		useTerminalMetrics({ visibleWidth: measuredWidth, truncateToWidth: measuredTruncate });
	}
});

test("updated tool results receive a fresh component and render current content", () => {
	const first = output("read", "old result", { expanded: true });
	assert.match(plain(first), /old result/);
	const updated = output("read", "new result", { expanded: true });
	assert.match(plain(updated), /new result/);
	assert.doesNotMatch(plain(updated), /old result/);
});

test("replacement lines emphasize the changed middle without dependencies", () => {
	const rows = output("edit", "ok", {}, { diff: "-12 const color = 'red';\n+12 const color = 'green';" }).render(80);
	assert.ok(rows.some(row => row.includes(theme.bold("red"))));
	assert.ok(rows.some(row => row.includes(theme.bold("green"))));
});

test("replacement rows emphasize disjoint spans rather than their unchanged middle", () => {
	const rows = output("edit", "ok", {}, { diff: "-1 red + stable + small\n+1 green + stable + large" }).render(100);
	for (const word of ["red", "small", "green", "large"]) assert.ok(rows.some(row => row.includes(theme.bold(word))), word);
	assert.ok(rows.every(row => !row.includes(theme.bold("stable"))));
	assert.ok(rows.every(row => !/\x1b\[1m[^\x1b]*stable/.test(row)));
});

test("replacement groups pair by position after line shifts and never across context or uneven groups", () => {
	const shifted = output("edit", "ok", {}, { diff: "+1 insertion\n 1 anchor\n-2 const old = 1;\n+3 const new = 1;" }).render(100);
	for (const word of ["old", "new"]) assert.ok(shifted.some(row => row.includes(theme.bold(word))), word);
	for (const diff of ["-2 old\n 3 context\n+2 new", "-1 old\n+1 new\n+2 extra", "-1 old\n ...\n+1 new"]) {
		assert.ok(output("edit", "ok", {}, { diff }).render(100).every(row => !row.includes("\x1b[1m")), diff);
	}
});

test("changed spans survive wrapping and sanitization without bolding truncation markers", () => {
	const diff = "-1 old + stable + red👩‍💻\n+1 new\u001b[2J + stable + green👨‍💻";
	const component = output("edit", "ok", { expanded: true, outputPad: 0 }, { diff });
	const rows = component.render(12);
	assert.ok(rows.every(row => visibleWidth(row) <= 12));
	const bolded = rows.flatMap(row => Array.from(row.matchAll(/\x1b\[1m([^\x1b]*)\x1b\[22m/g), match => match[1])).join("");
	assert.equal(bolded, "oldred👩‍💻newgreen👨‍💻");
	const clipped = output("edit", "ok", {}, { diff: "-1 abcdefghij\n+1 uvwxyzabcd" }).render(10);
	assert.ok(clipped.every(row => !/\x1b\[1m[^\x1b]*…/.test(row)));
});

test("clipped preview groups and line bodies never invent an intra-line pairing", () => {
	const prefix = Array.from({ length: 14 }, (_, i) => ` ${i + 1} context`).join("\n");
	const cutGroup = output("edit", "ok", {}, { diff: `${prefix}\n-15 old\n+15 new\n+16 extra` }).render(100);
	assert.ok(cutGroup.every(row => !row.includes("\x1b[1m")));
	const cutBody = output("edit", "ok", {}, { diff: `-1 ${"a".repeat(9000)}\n+1 new` }).render(100);
	assert.ok(cutBody.every(row => !row.includes("\x1b[1m")));
});

test("all rows fit actual installed Pi ruler at widths 0..120, Unicode and pathological output padding", () => {
	const text = "界 👩‍💻 का မြန်မာ é ✓ \x1b[2J\u202e safe";
	for (const outputPad of [0, 1, 8, 200]) {
		for (const expanded of [false, true]) {
			for (const name of ["bash", "read", "grep", "find", "ls", "edit", "write", "unknown"]) {
				const args = { path: text, command: `${text}\n${text}`, content: `${text}\n${text}`, pattern: text };
				const components = [call(name, args, { outputPad, expanded }), output(name, `${text}\n${text}\nend`, { outputPad, expanded, args }, { diff: `+123 ${text}\n-124 ${text}` })];
				for (let width = 0; width <= 120; width++) for (const component of components) {
					for (const row of component.render(width)) {
						assert.ok(visibleWidth(row) <= width, `${name} width=${width} pad=${outputPad}: ${JSON.stringify(row)}`);
						assert.doesNotMatch(stripAnsi(row), /[\x00-\x1f\x7f-\x9f\u202a-\u202e]/);
					}
				}
			}
		}
	}
});

test("expanded output is not limited by JavaScript call-argument limits", () => {
	const text = "x\n".repeat(150_000) + "LAST";
	for (const component of [
		output("read", text, { expanded: true }),
		call("bash", { command: text }, { expanded: true }),
		output("write", text, { expanded: true, args: { content: "a" } }),
	]) {
		const rows = component.render(80);
		assert.ok(rows.length >= 150_001);
		assert.match(stripAnsi(rows.at(-1)!), /LAST/);
	}
});

test("large collapsed content is bounded and input args/results are untouched", () => {
	const content = "a".repeat(1_000_000) + "\n" + "line\n".repeat(100_000);
	const args = Object.freeze({ path: "/work/large", content });
	const res = Object.freeze({ content: Object.freeze([{ type: "text" as const, text: content }]), details: undefined });
	const ctx = context({ args });
	const renderer = createToolView("write", () => "expand");
	const component = renderer.renderResult!(res as unknown as Result, { expanded: false, isPartial: false }, theme, ctx);
	assert.ok(component.render(80).length <= 18);
	assert.match(plain(component), /100001 lines/);
	assert.equal(args.content, content);
	assert.equal(res.content[0].text, content);
});

test("header metadata recedes: dim duration and hint after a toolTitle heading", () => {
	const row = call("read", { path: "/work/a.ts" }, { durationMs: 4210 }).render(120);
	assert.deepEqual(row, [` ${theme.fg("success", "●")}${theme.fg("toolTitle", " Read a.ts")}${theme.fg("dim", " · 4.2s (ctrl+o expand)")}`]);
	assert.deepEqual(call("read", { path: "/work/a.ts" }, { durationMs: 4210, expanded: true }).render(120)[0],
		` ${theme.fg("success", "●")}${theme.fg("toolTitle", " Read a.ts")}${theme.fg("dim", " · 4.2s")}`, "expanded rows keep the duration");
	for (const durationMs of [0, 123, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
		const text = plain(call("read", { path: "/work/a.ts" }, { durationMs }));
		assert.equal(text, " ● Read a.ts (ctrl+o expand)", `${durationMs}ms prints no timing`);
	}
	assert.doesNotMatch(plain(call("read", {}, { durationMs: 4210 })), /4210ms/);
	assert.doesNotMatch(plain(call("read", {}, { durationMs: 4210, isPartial: true })), /4\.2s/, "unsettled calls print no timing");
	assert.equal(plain(call("edit", { path: "/work/a.ts" }, { durationMs: 61_000 })), " ● Update a.ts · 1m 01s", "loud tools carry no hint");
});

test("header metadata yields in whole rungs — hint first, then the duration — and is never clipped", () => {
	const component = call("read", { path: "/work/src/components/a-rather-long-file-name.ts" }, { durationMs: 4210 });
	const title = " ● Read src/components/a-rather-long-file-name.ts";
	const timed = `${title} · 4.2s`;
	const full = `${timed} (ctrl+o expand)`;
	assert.equal(plain(component, 120), full);
	for (let width = 1; width <= 120; width++) {
		const [row, ...rest] = component.render(width);
		assert.deepEqual(rest, [], `one line at ${width}`);
		assert.ok(visibleWidth(row ?? "") <= width, `fits ${width}`);
		const text = stripAnsi(row ?? "");
		if (text.includes("(")) assert.equal(text, full, `the hint is whole or absent at ${width}`);
		else if (text.includes("·")) assert.equal(text, timed, `the duration is whole or absent at ${width}`);
		else assert.ok(!row?.includes("\x1b[38;5;20m"), `no clipped (dim) meta at ${width}`);
	}
	assert.equal(plain(component, 40), " ● Read src/components/a-rather-long-f…");
	assert.equal(plain(component, 52), title, "title alone fits");
	assert.equal(plain(component, 58), timed, "a slow call keeps its time after the boilerplate hint has gone");
});

test("unpaired surrogates in tool output are painted as the cell they occupy", () => {
	const text = plain(output("bash", "ok \udc00\udc00 done", { expanded: true }));
	assert.ok(text.includes("ok \ufffd\ufffd done"), text);
	assert.ok(!/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")), "no lone surrogate reaches the terminal");
});

test("partial previews show the output line itself, the empty fallback still says Running", () => {
	assert.equal(plain(output("bash", "compiling src\nlinking", { isPartial: true })), " └ compiling src\n   linking");
	assert.equal(plain(output("bash", "", { isPartial: true })), " └ Running…");
});

test("only errors that omitted output carry an expansion hint row", () => {
	const short = output("bash", "Permission denied", { isError: true });
	assert.equal(plain(short), " └ Permission denied");
	const long = output("bash", "one\ntwo\nthree\nfour", { isError: true });
	assert.equal(long.render(80).length, 4);
	assert.equal(plain(long), " └ … earlier output (ctrl+o expand)\n   two\n   three\n   four");
});

const testRun = (count: number) => Array.from({ length: count }, (_, i) => `ok ${i + 1} - case ${i + 1}`).join("\n");

test("a running command previews its newest output, and the preview follows it", () => {
	const early = output("bash", `\n> pi-1337 test\n${testRun(2)}`, { isPartial: true });
	assert.equal(plain(early), " └ … earlier output (ctrl+o expand)\n   ok 1 - case 1\n   ok 2 - case 2");
	const four = output("bash", testRun(4), { isPartial: true });
	const fortyFour = output("bash", testRun(44), { isPartial: true });
	assert.equal(plain(four), " └ … earlier output (ctrl+o expand)\n   ok 3 - case 3\n   ok 4 - case 4");
	assert.equal(plain(fortyFour), " └ … earlier output (ctrl+o expand)\n   ok 43 - case 43\n   ok 44 - case 44");
	assert.notEqual(plain(four), plain(fortyFour), "more output must change the preview");
	const rows = fortyFour.render(80);
	assert.ok(rows[0]!.includes(theme.fg("dim", "└ … earlier output (ctrl+o expand)")), "the omission row recedes, dim");
	assert.ok(rows[1]!.includes(theme.fg("accent", "  ok 43 - case 43")), "the tail keeps the running row color");
});

test("a failed command keeps the exception and exit status, the lines that say what went wrong", () => {
	const traceback = [
		"Traceback (most recent call last):",
		"  File \"/work/stats.py\", line 12, in <module>",
		"    main()",
		"  File \"/work/stats.py\", line 9, in main",
		"    total = sum(values) / len(values)",
		"ZeroDivisionError: division by zero",
		"",
		"Command exited with code 1",
		"",
	].join("\n");
	const rows = output("bash", traceback, { isError: true }).render(80);
	assert.deepEqual(rows.map(stripAnsi), [
		" └ … earlier output (ctrl+o expand)",
		"       total = sum(values) / len(values)",
		"   ZeroDivisionError: division by zero",
		"   Command exited with code 1",
	], "indentation survives; blank lines are not preview rows");
	assert.ok(rows.slice(1).every(row => row.includes("\x1b[38;5;23m")), "the tail keeps the error color");
});

test("short output has no omission row, and trailing blank lines are skipped", () => {
	assert.equal(plain(output("bash", "compiling\n\n\n", { isPartial: true })), " └ compiling");
	assert.equal(plain(output("bash", "\n\nbuild failed\nexit 2\n\n", { isError: true })), " └ build failed\n   exit 2");
	assert.equal(plain(output("bash", "  indented\n", { isPartial: true })), " └   indented");
});

test("a settled successful preview shows the head, and leading blank lines spend no row", () => {
	assert.equal(plain(output("unknown", "\n\n> pi-1337 build\n> tsc\nemitted 3 files")), " └ > pi-1337 build\n   > tsc\n   … more output (ctrl+o expand)");
	assert.equal(plain(output("unknown", "first\nsecond\n")), " └ first\n   second", "a trailing newline is not more output");
	assert.equal(plain(output("unknown", "first\nsecond\n \n\n")), " └ first\n   second");
	assert.equal(plain(output("unknown", "\n  indented first\nsecond")), " └   indented first\n   second", "only whole blank lines go");
	assert.equal(plain(output("unknown", "\n \n\t\n")), " └ No text output");
});

test("running and failed previews read only a bounded suffix of huge output", () => {
	const huge = "x".repeat(5_000_000);
	const lines = testRun(100_000);
	for (const [text, isPartial, tail] of [
		[huge, true, /^ {3}…x+$/],
		[`${huge}\nlast words`, false, /^ {3}last words$/],
		[lines, true, /^ {3}ok 100000 - case 100000$/],
		[lines, false, /^ {3}ok 100000 - case 100000$/],
	] as const) {
		const res = Object.freeze({ content: Object.freeze([{ type: "text" as const, text }]), details: undefined });
		const view = createToolView("bash", () => "ctrl+o expand");
		const started = performance.now();
		const component = view.renderResult!(res as unknown as Result, { expanded: false, isPartial }, theme, context({ isPartial, isError: !isPartial }));
		const rows = component.render(80).map(stripAnsi);
		assert.ok(performance.now() - started < 250, "the preview is built from a bounded suffix");
		assert.equal(rows[0], " └ … earlier output (ctrl+o expand)");
		assert.match(rows.at(-1)!, tail);
		assert.ok(rows.length <= 4);
		assert.equal(res.content[0].text, text, "the result is untouched");
	}
	// A one-line window is the end of the line; a lone low surrogate at the cut is not painted.
	const split = `${"😀".repeat(3_000_000)}!`; // odd length: the window opens on a low surrogate
	const rows = output("bash", split, { isPartial: true }).render(80);
	assert.ok(rows.length === 2 && !rows.some(row => row.includes("�")), "no split pair at the window's start");
});

test("the tail window never opens inside an escape sequence when a line boundary exists", () => {
	// Every line hides a long OSC 8 link target, so the window holds about two
	// lines and its cut lands inside one: without the line-boundary rule that
	// fragment is one of the three error rows.
	const osc = `\x1b]8;;https://example.test/${"p".repeat(3500)}\x07`;
	const lines = Array.from({ length: 50 }, (_, i) => `${osc}line ${i}\x1b]8;;\x07`);
	let cuts = 0;
	for (let pad = 0; pad < 40; pad++) {
		const text = `${lines.join("\n")} ${"z".repeat(pad * 90)}`;
		const rows = output("bash", text, { isError: true }).render(400).map(stripAnsi);
		assert.equal(rows[0], " └ … earlier output (ctrl+o expand)");
		for (const row of rows.slice(1)) assert.match(row, /^ {3}line \d+(?: z*…?)?$/, `pad ${pad}: a fragment leaked: ${JSON.stringify(row)}`);
		cuts += Number(rows.length < 4);
	}
	assert.ok(cuts > 0, "the sweep exercised windows whose first line was dropped");
});

test("output of only control sequences falls back to the empty-output text", () => {
	const controls = "\x1b[2K\x1b[1G\r\x1b[?25l\x07".repeat(10);
	assert.equal(plain(output("bash", controls, { isPartial: true })), " └ Running…");
	assert.equal(plain(output("bash", controls, { isError: true })), " └ Failed (no diagnostic text)");
	assert.equal(plain(output("bash", `\n \n${controls}\n\n`, { isPartial: true })), " └ Running…");
});

test("write previews say what was written and align their line-number gutter", () => {
	const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
	const rows = output("write", "Saved", { args: { content } }).render(80).map(row => stripAnsi(row).trimEnd());
	assert.equal(rows[0], " └ Wrote 10 lines");
	assert.equal(rows[1], "    1 + line-1");
	assert.equal(rows[10], "   10 + line-10");
	assert.equal(plain(output("write", "Saved", { args: { content: "solo" } })).split("\n")[0], " └ Wrote 1 line");
});

test("run summary rows share the tool rows' indent, single line, sanitizing and cache", () => {
	const styledHint = () => "\x1b[2mctrl+o\x1b[22m\x1b[90m to expand\x1b[39m";
	const summary = createRunSummaryView("Read 3 files, searched 2 patterns", theme, context({ outputPad: 2 }), styledHint);
	assert.deepEqual(summary.render(120), [
		`  ${theme.fg("success", "●")}${theme.fg("toolTitle", " Read 3 files, searched 2 patterns")}${theme.fg("dim", " (ctrl+o to expand)")}`,
	], "the keyHint's SGR never lands inside the title span");
	for (let width = 8; width <= 120; width++) {
		const rows = summary.render(width);
		assert.equal(rows.length, 1, `one line at ${width}`);
		assert.ok(visibleWidth(rows[0]!) <= width, `fits ${width}`);
		assert.ok(stripAnsi(rows[0]!).startsWith("  ●"), `indent equals outputPad at ${width}`);
	}
	assert.equal(summary.render(64), summary.render(64), "an unchanged width reuses the cached lines");
	assert.equal(plain(createRunSummaryView("Read\x1b[2J 1 file\u202e", theme, context(), () => "")), " ● Read 1 file (expand)");
});

// Seeded corpus dense in escape-grammar bytes; the forbidden set is spelled out
// here, independently of src, so a weakened predicate there cannot pass.
function corpus(seed: number, count: number): string[] {
	let s = seed >>> 0;
	const next = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), s | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const alphabet = [
		"\x1b", "\x1b", "[", "]", "P", "_", "^", "X", "\\", "\x07", "\x9c", "\x9b", "\x90", "\x98", "\x9d", "\x9e", "\x9f",
		"\x85", "\x7f", "\x00", "\x0b", "\x1f", "0", ";", "?", " ", "m", "H", "@", "~", "\n", "\r", "\t", " ", " ",
		"؜", "‎", "‮", "⁦", "⁩", "\ud800", "\udfff", "😀", "\ud83d", "\ude00", "漢", "a",
	];
	return Array.from({ length: count }, () =>
		Array.from({ length: Math.floor(next() * 24) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""));
}

/** First code unit that must not reach the terminal; a newline is the one C0 these views keep. */
function forbidden(text: string): number | undefined {
	for (let i = 0; i < text.length; i++) {
		const cu = text.charCodeAt(i);
		if (cu >= 0xd800 && cu <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
			i++;
			continue;
		}
		if (cu >= 0xd800 && cu <= 0xdfff) return cu;
		if (cu === 0x0a) continue;
		if (cu < 0x20 || (cu >= 0x7f && cu <= 0x9f) || cu === 0x061c || cu === 0x200e || cu === 0x200f ||
			(cu >= 0x202a && cu <= 0x202e) || (cu >= 0x2066 && cu <= 0x2069) || cu === 0x2028 || cu === 0x2029) return cu;
	}
	return undefined;
}

test("tool output and expanded arguments never carry a control, bidi override or unpaired surrogate", () => {
	for (const input of corpus(2600, 20_000)) {
		const output = safeOutput(input);
		assert.equal(forbidden(output), undefined, `safeOutput ${JSON.stringify(input)} -> ${JSON.stringify(output)}`);
		assert.equal(safeOutput(output), output, `safeOutput is idempotent on ${JSON.stringify(input)}`);
		const expanded = safeExpandedText(input);
		assert.equal(forbidden(expanded), undefined, `safeExpandedText ${JSON.stringify(input)} -> ${JSON.stringify(expanded)}`);
	}
});

test("tool output keeps printable text and line breaks between terminated sequences, in order", () => {
	const sequences = [
		"\x1b[1;31m", "\x1b[?25h", "\x9b2J", "\x1b]0;title\x07", "\x1b]8;;u\x9c", "\x1b]2;t\x1b\\", "\x1b_Ga=T\x1b\\",
		"\x1bP+q\x1b\\", "\x1b^pm\x07", "\x1bXsos\x9c", "\x90dcs\x9c", "\x98sos\x07", "\x9d0;t\x1b\\", "\x9eapc\x9c", "\x9fpm\x07",
		"\x1b7", "\x1bc", "\x1b]x\x1b\x1b\\", "\x1b]x\x1b\x07", "\x1b[3~", "\x1b[2@",
	];
	const tokens = ["alpha", " ", "\n", "漢字", "👍🏽", "x 9", "[", "]", "\\", "P_^X"];
	let s = 11;
	const pick = <T>(xs: readonly T[]) => xs[((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) % xs.length];
	for (let round = 0; round < 2000; round++) {
		let input = "";
		let expected = "";
		for (let k = 0; k < 12; k++) {
			const token = pick(tokens);
			input += pick(sequences) + token;
			expected += token;
		}
		assert.equal(safeOutput(input), expected, JSON.stringify(input));
	}
});

test("tool output grammar: terminator forms, split and truncated sequences, whitespace mapping", () => {
	assert.equal(safeOutput("a\x1b]0;t\x07b\x1b]0;t\x9cc\x1b]0;t\x1b\\d"), "abcd", "BEL, C1 ST and ESC \\ all end a string");
	assert.equal(safeOutput("ok\n\x1b]52;c;evil"), "ok\n", "an unterminated string owns the rest");
	assert.equal(safeOutput("a\x1b[1\n2mb"), "ab", "a newline inside a CSI is part of it");
	assert.equal(safeOutput("a\x1b"), "a", "ESC at the end");
	assert.equal(safeOutput("a\x1b\x1b[31mb"), "a[31mb", "ESC ESC is one two-char escape");
	assert.equal(safeOutput("a\x1b😀b"), "ab", "ESC drops a whole astral code point");
	assert.equal(safeOutput("a\tb c d\r\ne"), "a   b\nc\nd\ne");
	assert.equal(safeOutput("x\ud800y 😀"), "x�y 😀");
});

test("expanded arguments spell an unpaired surrogate like every other hidden code point", () => {
	// Resolved disagreement: the strippers already painted it as U+FFFD, but this
	// view let it through raw; it is now named, matching what JSON.stringify emits.
	assert.equal(safeExpandedText("a\ud800b\udfff"), "a\\ud800b\\udfff");
	assert.equal(safeExpandedText("pair 😀\nnext"), "pair 😀\nnext");
	assert.equal(safeExpandedText("\x1b[2J‮ \t"), "\\u001b[2J\\u202e\\u2028\\u0009");
});

test("output and expanded text never read a pair across the end of a slice", () => {
	// Same engine hazard as the inline sanitizer's test: previews are slices of tool output.
	const parent = `${"x".repeat(20)}\u{1F600}tail`;
	let leaked = 0;
	for (let n = 0; n < 150_000; n++) {
		const cut = parent.slice(n % 3, 21);
		if (!safeOutput(cut).endsWith("\ufffd")) leaked++;
		if (!safeExpandedText(cut).endsWith("\\ud83d")) leaked++;
	}
	assert.equal(leaked, 0);
});

test("a progress meter rewritten with carriage returns previews its newest value", () => {
	const meter = Array.from({ length: 101 }, (_, n) => `Downloading ${n}%`).join("\r");
	assert.equal(plain(output("bash", meter, { isPartial: true })), " └ Downloading 100%");
	assert.equal(plain(output("bash", `resolving\n${meter}\r`, { isPartial: true })), " └ resolving\n   Downloading 100%", "a trailing carriage return does not blank the line");
	assert.equal(plain(output("bash", "one\r\ntwo\r\n", { isError: true })), " └ one\n   two", "CRLF line ends are not rewrites");
	// A meter that outgrows the preview window without ever printing a newline.
	const long = Array.from({ length: 2000 }, (_, n) => `Downloading ${String(n).padStart(4, "0")}/1999`).join("\r");
	assert.ok(long.length > 8192);
	assert.equal(plain(output("bash", long, { isPartial: true })), " └ … earlier output (ctrl+o expand)\n   Downloading 1999/1999");
});

test("one line longer than the preview window shows its end, not the window's opening", () => {
	const huge = `${"x".repeat(20_000)} the end`;
	const rows = plain(output("bash", huge, { isPartial: true }), 40).split("\n");
	assert.equal(rows[0], " └ … earlier output (ctrl+o expand)");
	assert.match(rows[1]!, /^ {3}…x+ the end$/, "cut from the left, the newest text stays");
	for (let width = 6; width <= 120; width++) {
		const [, row = ""] = output("bash", huge, { isPartial: true }).render(width);
		assert.ok(visibleWidth(row) <= width, `fits ${width}`);
		if (width >= 16) assert.ok(stripAnsi(row).endsWith("the end"), `the end survives at ${width}`);
	}
	// The window opens inside a long OSC payload whose introducer was cut off: the
	// payload is not output, so only what follows its terminator may show.
	const payload = `\x1b]52;c;${"QUJD".repeat(5000)}\x07after the clipboard write`;
	assert.equal(plain(output("bash", payload, { isPartial: true })).split("\n")[1], "   after the clipboard write");
	const st = `\x1b]8;;${"u".repeat(20_000)}\x1b\\linked`;
	assert.equal(plain(output("bash", st, { isPartial: true })).split("\n")[1], "   linked");
	const wide = `${"界".repeat(9000)}終`;
	const [, wideRow = ""] = output("bash", wide, { isPartial: true }).render(31);
	assert.ok(visibleWidth(wideRow) <= 31 && stripAnsi(wideRow).endsWith("終"), stripAnsi(wideRow));
});

/** One host row: both renderers share its `context.state`, as the host's rendererState is shared. */
function hostRow(name: string, args: Record<string, unknown> = {}, base: Partial<Context> = {}) {
	const state = {};
	const view = createToolView(name, () => "ctrl+o expand");
	return {
		header: (patch: Partial<Context> = {}) => view.renderCall!(args, theme, context({ args, state, ...base, ...patch })),
		settle(text: string | Result, details?: unknown, patch: Partial<Context> = {}) {
			const ctx = context({ args, state, ...base, ...patch });
			return view.renderResult!(typeof text === "string" ? result(text, details) : text, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx);
		},
	};
}
/** The header a settled, successful row shows once its result is in. */
function settledHeader(name: string, args: Record<string, unknown>, text: string, details?: unknown): string {
	const row = hostRow(name, args);
	row.settle(text, details);
	return plain(row.header());
}
const lines = (count: number, line: (i: number) => string) => Array.from({ length: count }, (_, i) => line(i)).join("\n");

test("a settled quiet row says what it found: counts, zero, singular, and limits as a lower bound", () => {
	const grep = { pattern: "needle", path: "/work/src" };
	const search = " ● Search “needle” in src";
	for (const [name, args, text, details, outcome] of [
		["grep", grep, lines(6, i => `a.ts:${i + 1}: needle`), undefined, "6 matches"],
		["grep", grep, "a.ts:1: needle", undefined, "1 match"],
		["grep", grep, "No matches found", undefined, "no matches"],
		["grep", grep, `${lines(100, i => `a.ts:${i + 1}: needle`)}\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]`, { matchLimitReached: 100 }, "100+ matches"],
		["grep", grep, `${lines(3, i => `a.ts:${i + 1}: needle`)}\n\n[50.0KB limit reached]`, { truncation: { truncated: true, totalLines: 2345 } }, "2345 matches"],
		["grep", grep, "a.ts:1: needle\nb.ts:2: needle\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]", { linesTruncated: true }, "2 matches"],
		["grep", { ...grep, context: 0 }, "a.ts:1: needle\nb.ts:2: needle", undefined, "2 matches"],
		["grep", { ...grep, context: 2 }, `${lines(4, i => `a.ts:${i + 1}: needle`)}\n\n[4 matches limit reached. Use limit=8 for more, or refine pattern]`, { matchLimitReached: 4 }, "4+ matches"],
		["grep", { ...grep, context: 2 }, "No matches found", undefined, "no matches"],
		["find", { pattern: "*.ts" }, lines(27, i => `src/f${i}.ts`), undefined, "27 results"],
		["find", { pattern: "*.ts" }, "src/a.ts", undefined, "1 result"],
		["find", { pattern: "*.ts" }, "No files found matching pattern", undefined, "no results"],
		["find", { pattern: "*.ts" }, `${lines(1000, i => `f${i}.ts`)}\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]`, { resultLimitReached: 1000 }, "1000+ results"],
		["ls", {}, lines(12, i => `entry${i}`), undefined, "12 entries"],
		["ls", {}, "src/", undefined, "1 entry"],
		["ls", {}, "(empty directory)", undefined, "empty"],
		["ls", {}, `${lines(500, i => `e${i}`)}\n\n[500 entries limit reached. Use limit=1000 for more]`, { entryLimitReached: 500 }, "500+ entries"],
		["bash", { command: "git log --oneline" }, `${lines(12, i => `c${i} commit`)}\n`, undefined, "12 lines"],
		["bash", { command: "git status --short" }, " M src/a.ts", undefined, "1 line"],
		["bash", { command: "tail -n 2000 big.log" }, `${lines(2000, i => `l${i}`)}\n\n[Showing lines 3001-5000 of 5000. Full output: /tmp/x]`, { truncation: { truncated: true, totalLines: 5000 }, fullOutputPath: "/tmp/x" }, "5000 lines"],
	] as const) {
		const header = settledHeader(name, args, text, details);
		assert.ok(header.endsWith(` · ${outcome} (ctrl+o expand)`), `${name} ${JSON.stringify(args)}: ${header}`);
	}
	assert.equal(settledHeader("grep", grep, "a.ts:1: needle\na.ts:2: needle"), `${search} · 2 matches (ctrl+o expand)`);
	for (const [name, args, text, details] of [
		["bash", { command: "true" }, "(no output)", undefined],
		["grep", { ...grep, context: 2 }, "a.ts-1- before\na.ts:2: needle\na.ts-3- after", undefined],
		["grep", { ...grep, context: "3" }, "a.ts:2: needle", undefined],
		["read", { path: "/work/a.ts" }, "line one\nline two", undefined],
	] as const) assert.doesNotMatch(settledHeader(name, args, text, details), / · /, `${name}: nothing it cannot say reliably`);
	const images: Result = { content: [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }], details: undefined };
	const withImage = hostRow("bash", { command: "plot" });
	withImage.settle(images);
	assert.doesNotMatch(plain(withImage.header()), / · /, "a result of another shape is not counted");
});

test("errors, partial results, expanded rows and loud or foreign tools show no outcome", () => {
	const text = "a.ts:1: x\nb.ts:2: y";
	const failed = hostRow("grep", { pattern: "x" }, { isError: true });
	failed.settle(text);
	assert.doesNotMatch(plain(failed.header()), /match/);
	const running = hostRow("grep", { pattern: "x" });
	running.settle(text, undefined, { isPartial: true });
	assert.doesNotMatch(plain(running.header()), /match/, "a partial result is not what the call found");
	assert.doesNotMatch(plain(running.header({ isPartial: true })), /match/);
	const expanded = hostRow("grep", { pattern: "x" });
	expanded.settle(text, undefined, { expanded: true });
	assert.doesNotMatch(plain(expanded.header({ expanded: true })), /match/, "the expanded row shows the output itself");
	assert.match(plain(expanded.header()), /· 2 matches/, "collapsing it again shows the outcome");
	for (const name of ["edit", "write", "unknown"]) {
		const row = hostRow(name, { path: "/work/a.ts", content: "x" });
		row.settle("one\ntwo\nthree");
		assert.doesNotMatch(plain(row.header()), /lines|entries|matches/, name);
	}
});

test("the header shows a result that arrives after it rendered, and follows the result as it changes", () => {
	const row = hostRow("bash", { command: "npm test" });
	const header = row.header();
	assert.equal(plain(header), " ● $ npm test (ctrl+o expand)", "nothing is known before the result");
	row.settle("one\ntwo\nthree");
	assert.equal(plain(header), " ● $ npm test · 3 lines (ctrl+o expand)", "the same component, rendered again, has it");
	row.settle("one");
	assert.equal(plain(header), " ● $ npm test · 1 line (ctrl+o expand)", "a new result replaces it");
	row.settle("one\ntwo", undefined, { isPartial: true });
	assert.equal(plain(header), " ● $ npm test (ctrl+o expand)", "a partial result withdraws it");
	row.settle("one\ntwo", undefined, { isError: true });
	assert.equal(plain(header), " ● $ npm test (ctrl+o expand)", "an error withdraws it");
	const before = hostRow("ls", {});
	before.settle("a\nb");
	assert.equal(plain(before.header()), " ● List . · 2 entries (ctrl+o expand)", "result first, header second");
});

test("header metadata yields hint, then duration, then outcome — each whole or absent", () => {
	const row = hostRow("grep", { pattern: "needle", path: "/work/src/components" }, { durationMs: 4210 });
	row.settle(lines(6, i => `a.ts:${i}: needle`));
	const component = row.header();
	const title = " ● Search “needle” in src/components";
	const found = `${title} · 6 matches`;
	const timed = `${found} · 4.2s`;
	const full = `${timed} (ctrl+o expand)`;
	assert.equal(plain(component, 120), full);
	assert.equal(plain(component, visibleWidth(full) - 1), timed, "the boilerplate hint goes first");
	assert.equal(plain(component, visibleWidth(timed) - 1), found, "then the duration");
	assert.equal(plain(component, visibleWidth(found) - 1), title, "then the outcome, leaving the title alone");
	assert.equal(plain(component, 30), " ● Search “needle” in src/co…", "only the title ever truncates");
	for (let width = 1; width <= 120; width++) {
		const [line, ...rest] = component.render(width);
		assert.deepEqual(rest, [], `one line at ${width}`);
		assert.ok(visibleWidth(line ?? "") <= width, `fits ${width}`);
		const text = stripAnsi(line ?? "");
		assert.ok([full, timed, found].includes(text) || !text.includes(" · "), `meta is whole or absent at ${width}: ${text}`);
	}
});

test("a read names its range exactly as stock Pi does", async () => {
	const { formatReadLineRange } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/render-utils.js") as { formatReadLineRange: (offset: unknown, limit: unknown) => string };
	const values = [undefined, null, 0, 1, 110, 22, -1, 1.5, "12", " ", "x", Number.NaN, Number.POSITIVE_INFINITY];
	let ranged = 0;
	for (const offset of values) for (const limit of values) {
		const range = formatReadLineRange(offset, limit);
		ranged += Number(range !== "");
		assert.equal(plain(call("read", { path: "/work/a.ts", offset, limit }, { expanded: true })).split("\n")[0], ` ● Read a.ts${range}`, `offset ${String(offset)}, limit ${String(limit)}`);
	}
	assert.ok(ranged > 50, "the sweep covers ranges, not only their absence");
	assert.equal(plain(call("read", { path: "/work/src/a.ts", offset: 110, limit: 22 })), " ● Read src/a.ts:110-131 (ctrl+o expand)");
	assert.equal(plain(call("read", { path: "/work/src/a.ts", offset: 110 })), " ● Read src/a.ts:110 (ctrl+o expand)");
	assert.equal(plain(call("read", { path: "/work/src/a.ts", limit: 40 })), " ● Read src/a.ts:1-40 (ctrl+o expand)");
});

test("hostile result text and details never reach the header", () => {
	const hostile = "\x1b]52;c;evil\x07\x1b[2J‮⁦evil";
	for (const [name, details] of [
		["grep", { matchLimitReached: hostile }],
		["grep", { truncation: { truncated: true, totalLines: hostile } }],
		["find", { resultLimitReached: 1.5, truncation: { truncated: true, totalLines: -3 } }],
		["ls", { entryLimitReached: Number.POSITIVE_INFINITY }],
		["bash", { truncation: { truncated: true, totalLines: { toString: () => hostile } } }],
	] as const) {
		const row = hostRow(name, { pattern: "p", command: "c" });
		row.settle(`${hostile}\n${hostile}`, details);
		const rendered = row.header().render(200).join("");
		assert.doesNotMatch(stripAnsi(rendered), /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]|evil/, name);
		assert.match(stripAnsi(rendered), / · 2 (matches|results|entries|lines) /, `${name}: malformed details fall back to the counted rows`);
	}
});

test("a multi-line command shows its first line and says more follows", () => {
	const title = (command: string) => plain(call("bash", { command }, { expanded: false })).replace(/ \(ctrl\+o expand\)$/, "");
	assert.equal(title("set -e\nfor f in src/*.ts; do\n  wc -l \"$f\"\ndone"), " ● $ set -e …");
	assert.equal(title("\n\n  \t\n  npm run build\nnpm test"), " ● $ npm run build …", "leading blank lines are not the first line");
	assert.equal(title("# rebuild the bundle\nnpm run build"), " ● $ # rebuild the bundle …", "a comment is still the first line");
	assert.equal(title("npm test"), " ● $ npm test", "a single line is unchanged");
	assert.equal(title("npm test\n\n \n"), " ● $ npm test", "trailing blank lines are not more lines");
	assert.equal(title("npm test\r\n"), " ● $ npm test", "nor is a CRLF ending");
	assert.equal(title("\x1b[2J\nnpm test"), " ● $ npm test", "a line of nothing but controls is blank");
	assert.equal(title(`echo one\n${"x".repeat(20_000)}`), " ● $ echo one …", "more follows even past the inspected head");
	assert.equal(title(`echo ${"y".repeat(20_000)}`).length < 500, true);
	const expanded = plain(call("bash", { command: "set -e\nnpm test" }, { expanded: true }));
	assert.match(expanded, /set -e …\n.*set -e\n.*npm test/, "the expanded row still prints the whole command");
});

const running = { isPartial: true, durationMs: undefined } as const;

test("a running command names the timeout it was given, as one dim rung; a settled row does not", () => {
	const args = { command: "npm test", timeout: 30 };
	assert.deepEqual(call("bash", args, running).render(120),
		[` ${theme.fg("accent", "●")}${theme.fg("toolTitle", " $ npm test")}${theme.fg("dim", " (timeout 30s)")}`]);
	assert.equal(plain(call("bash", args, { ...running, executionStarted: false })), " ● $ npm test (timeout 30s)", "pending, before execution starts");
	assert.equal(plain(call("bash", args, { ...running, expanded: true })).split("\n")[0], " ● $ npm test (timeout 30s)", "expanded while running");
	assert.equal(plain(call("bash", { command: "set -e\nnpm test", timeout: 30 }, running)), " ● $ set -e … (timeout 30s)", "after the whole title");
	// Gone with the final result, whatever it was: the row then carries its outcome, time and hint instead.
	assert.equal(plain(call("bash", args)), " ● $ npm test (ctrl+o expand)");
	assert.equal(plain(call("bash", args, { durationMs: 4210 })), " ● $ npm test · 4.2s (ctrl+o expand)");
	assert.equal(plain(call("bash", args, { isError: true, durationMs: 30_000 })), " ● $ npm test · 30s");
	assert.equal(plain(call("bash", args, { expanded: true })).split("\n")[0], " ● $ npm test");
	const settled = hostRow("bash", args);
	assert.equal(plain(settled.header(running)), " ● $ npm test (timeout 30s)");
	settled.settle("ok 1\nok 2");
	assert.equal(plain(settled.header()), " ● $ npm test · 2 lines (ctrl+o expand)");
	// Only the shell tool has a timeout argument this package knows the meaning of.
	for (const name of ["read", "grep", "find", "ls", "edit", "write", "custom_tool", "constructor"]) {
		assert.doesNotMatch(plain(call(name, { path: "/work/a.ts", pattern: "x", timeout: 30 }, running)), /timeout/, name);
	}
	// Spelled here, in seconds, to the millisecond the host schedules.
	for (const [timeout, text] of [[1, "1s"], [0.5, "0.5s"], [600, "600s"], [1.23456, "1.235s"], [0.1 + 0.2, "0.3s"], [0.001, "0.001s"],
		[86_400, "86400s"], [2_147_483.647, "2147483.647s"]] as const) {
		assert.equal(plain(call("bash", { command: "npm test", timeout }, running)), ` ● $ npm test (timeout ${text})`, String(timeout));
	}
});

test("a timeout that is not a number of seconds the host would run is never printed", () => {
	const hostile = "30s\x1b[2J‮) FORGED";
	for (const timeout of ["30", "", " ", hostile, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, -0.001, 0, -0,
		0.0001, 2_147_483.648, 1e12, Number.MAX_VALUE, {}, { valueOf: () => 30, toString: () => hostile }, [30], [], null, undefined, true, false, 30n,
		Symbol("30"), () => 30]) {
		const rows = call("bash", { command: "npm test", timeout }, running).render(120);
		assert.deepEqual(rows.map(stripAnsi), [" ● $ npm test"], `ignored: ${typeof timeout} ${String(typeof timeout === "object" && timeout ? JSON.stringify(timeout) : String(timeout))}`);
		assert.ok(!rows[0]!.includes("\x1b[38;5;20m"), "and no empty dim rung is painted");
	}
	assert.equal(plain(call("bash", { command: "npm test" }, running)), " ● $ npm test", "no timeout argument");
});

test("the timeout rung is the first thing a narrow row gives up: whole or absent, before the title truncates", () => {
	const component = call("bash", { command: "node --import tsx --test test/frame.test.ts", timeout: 120 }, running);
	const title = " ● $ node --import tsx --test test/frame.test.ts";
	const full = `${title} (timeout 120s)`;
	assert.equal(plain(component, 120), full);
	// The row keeps one column of side padding on the right as on the left.
	assert.equal(plain(component, visibleWidth(full) + 1), full, "shown when it fits exactly");
	assert.equal(plain(component, visibleWidth(full)), title, "one column short: the rung goes whole, the title stays whole");
	assert.equal(plain(component, visibleWidth(title) + 1), title);
	assert.equal(plain(component, 30), " ● $ node --import tsx --tes…", "only the title ever truncates");
	// A running row has no time, outcome or hint yet, and a settled one no timeout: the rung never competes with them for room.
	assert.doesNotMatch(plain(component, 120), / · |ctrl\+o/);
	const unicode = "界 👩‍💻 का မြန်မာ é ✓ \x1b[2J‮ safe";
	for (const outputPad of [0, 1, 8, 200]) {
		for (const expanded of [false, true]) {
			for (const command of ["node --import tsx --test test/frame.test.ts", unicode, `${unicode}\n${unicode}`, ""]) {
				const row = call("bash", { command, timeout: 120 }, { ...running, outputPad, expanded });
				for (let width = 0; width <= 120; width++) {
					const rendered = row.render(width);
					for (const line of rendered) {
						assert.ok(visibleWidth(line) <= width, `width=${width} pad=${outputPad}: ${JSON.stringify(line)}`);
						assert.doesNotMatch(stripAnsi(line), /[\x00-\x1f\x7f-\x9f‪-‮]/);
					}
					const header = stripAnsi(rendered[0] ?? "");
					assert.ok(header.endsWith(" (timeout 120s)") || !rendered[0]?.includes("\x1b[38;5;20m"),
						`the rung is whole or absent at width=${width} pad=${outputPad}: ${header}`);
				}
			}
		}
	}
});

test("a 5 MB result is counted once, and the header render stays cached", () => {
	let reads = 0;
	const huge = "x".repeat(4).concat("\n").repeat(1_000_000);
	const content = Object.freeze([{ type: "text" as const, get text() { reads++; return huge; } }]);
	const row = hostRow("bash", { command: "cat big" });
	const started = performance.now();
	row.settle({ content, details: undefined } as unknown as Result);
	const header = row.header();
	const first = header.render(120);
	assert.equal(stripAnsi(first[0]!), " ● $ cat big · 1000000 lines (ctrl+o expand)");
	// The host passes a fresh { content, details } wrapper on every display update.
	for (let i = 0; i < 20; i++) row.settle({ content, details: undefined } as unknown as Result);
	row.settle({ content, details: undefined } as unknown as Result, undefined, { expanded: true });
	for (let i = 0; i < 20; i++) assert.equal(header.render(120), first, "an unchanged width reuses the cached lines");
	assert.equal(reads, 1, "the result text is read once, when it arrives");
	assert.ok(performance.now() - started < 250, "counting is one linear pass");
});

test("the flat shell gives a third-party renderer the row minus padding and lead, and marks it in this package's roles", () => {
	assert.deepEqual([100, 60, 40, 5, 4, 3, 2, 1].map(width => flatInnerWidth(width, 1)), [96, 56, 36, 1, 1, 1, 1, 1]);
	assert.deepEqual([flatInnerWidth(100, 0), flatInnerWidth(100, 4), flatInnerWidth(100, 400), flatInnerWidth(100, Number.NaN), flatInnerWidth(100, "2")],
		[98, 90, 1, 98, 98], "padding yields before content; a malformed setting is no padding");
	assert.equal(statusRole(context({ isPartial: true, executionStarted: false })), "dim");
	assert.equal(statusRole(context({ isPartial: true })), "accent");
	assert.equal(statusRole(context()), "success");
	assert.equal(statusRole(context({ isError: true, isPartial: true })), "error");
	assert.equal(resultRole(context({ isPartial: true })), "accent");
	assert.equal(resultRole(context()), "toolOutput");
	assert.equal(resultRole(context({ isError: true })), "error");
});

test("flatRow keeps third-party lines as they are: lead, alignment, dropped edge padding, clip without wrap", () => {
	const styled = "\x1b[1mmonitor arm\x1b[22m";
	const row = flatRow([styled], ["armed", "  deadline in 9m"], 40, 1, "●", "└");
	assert.deepEqual(row.lines, [` ● ${styled}`, " └ armed", "     deadline in 9m"]);
	assert.deepEqual({ left: row.left, inner: row.inner, call: row.call, result: row.result },
		{ left: 3, inner: 36, call: { skipped: 0, count: 1, total: 1 }, result: { skipped: 0, count: 2, total: 2 } });

	// Rows a slot opens or closes with are its padding; one inside its content is content.
	const padded = flatRow(["", " \x1b[0m ", "call"], ["   ", "one", "", "three", "", ""], 40, 2, "●", "└");
	assert.deepEqual(padded.lines, ["  ● call", "  └ one", "    ", "    three"]);
	assert.deepEqual([padded.call, padded.result], [{ skipped: 2, count: 1, total: 3 }, { skipped: 1, count: 3, total: 6 }]);

	assert.deepEqual(flatRow([], ["alone", "second"], 40, 1, "●", "└").lines, [" ● alone", "   second"], "a row always leads with its dot");
	assert.deepEqual(flatRow([], ["alone", "second"], 40, 1, "●", "└", true).lines, [" └ alone", "   second"], "the exporter's result slot hangs under the connector");
	assert.deepEqual(flatRow(["", " "], [], 40, 1, "●", "└").lines, []);

	for (let width = 1; width <= 60; width++) for (const pad of [0, 1, 3, 50]) {
		const wide = flatRow(["界".repeat(40)], ["x".repeat(200), "\x1b[31m" + "y".repeat(200) + "\x1b[39m"], width, pad, "●", "└");
		assert.equal(wide.lines.length, 3, `never wrapped at ${width}`);
		assert.ok(wide.lines.every(line => visibleWidth(line) <= width), `width=${width}, pad=${pad}`);
		if (width >= 3) assert.ok(wide.lines.every(line => visibleWidth(line) <= wide.left + wide.inner));
	}
	assert.equal(stripAnsi(flatRow(["c".repeat(99)], [], 12, 1, "●", "└").lines[0]!), ` ● ${"c".repeat(8)}`, "cut at the inner width, no ellipsis");
});
