import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { createToolView, isPolishedTool } from "../src/tool-view.ts";
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
	return { args: {}, toolCallId: "test", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/work", executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: true, isError: false, durationMs: 123, outputPad: 1, ...patch };
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
	assert.match(plain(call("read", { path: "/work/src/a.ts" })), /● Read src\/a.ts.*123ms/);
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

test("collapsed large errors show three diagnostic rows plus expansion hint; expanded retains all", () => {
	const diagnostics = ["Permission denied", "Cannot open file", "Check permissions", ...Array.from({ length: 100 }, (_, i) => `diagnostic-${i}`)];
	for (const name of ["bash", "read", "edit", "write", "unknown"]) {
		const text = "\n\n" + diagnostics.join("\n");
		const collapsed = output(name, text, { isError: true });
		assert.equal(collapsed.render(80).length, 4);
		assert.match(plain(collapsed), /Permission denied/);
		assert.match(plain(collapsed), /Check permissions/);
		assert.match(plain(collapsed), /ctrl\+o expand/);
		assert.doesNotMatch(plain(collapsed), /diagnostic-99/);
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
		const additions = rows.filter(row => stripAnsi(row).includes("+1 first") || stripAnsi(row).includes("+2 second"));
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
		assert.match(text, new RegExp(`File-content preview: ${n} line`));
		if (n === 0) assert.doesNotMatch(text, /\+1/);
		else assert.match(text, /\+1 /);
		assert.doesNotMatch(text, /Added|actual diff|Wrote/);
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
