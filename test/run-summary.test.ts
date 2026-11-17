import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditTool, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	createRunCollector, createRunSummaryRow, MAX_SUMMARY_FILES, parseRunSummary, patchLineCounts, RUN_SUMMARY_VERSION,
	summarySpellings, timingSpellings, type RunSummaryData,
} from "../src/run-summary.ts";
import { stripAnsi, useTerminalMetrics } from "../src/width.ts";

useTerminalMetrics({ visibleWidth, truncateToWidth });

// Each token paints its own 256-color code, so spans can be read back by name.
const TOKENS = ["dim", "muted", "success", "warning", "error", "toolDiffAdded", "toolDiffRemoved", "accent", "toolTitle"];
const theme = {
	fg(token: string, text: string) { return `\x1b[38;5;${100 + TOKENS.indexOf(token)}m${text}\x1b[39m`; },
	bg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
} as unknown as Theme;
/** [token, text] runs of one painted line (the indent is unpainted). */
function spans(line: string): [string, string][] {
	return [...line.matchAll(/\x1b\[38;5;(\d+)m([^\x1b]*)\x1b\[39m/g)].map(m => [TOKENS[Number(m[1]) - 100]!, m[2]!]);
}

const CWD = "/work";
const edit = (patch: string) => ({ content: [{ type: "text", text: "ok" }], details: { diff: "", patch } });
const PATCH = "--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,4 @@\n line\n-old\n+new\n+added\n@@ -10,2 +11,2 @@\n--- not a header\n++++ not a header\n";

function base(patch: Partial<RunSummaryData> = {}): RunSummaryData {
	return {
		v: RUN_SUMMARY_VERSION, outcome: "done", durationMs: 134_000, edited: 0, added: 0, removed: 0, wrote: 0,
		commands: 0, commandsFailed: 0, tools: 0, toolsFailed: 0, cost: 0, files: [], moreFiles: 0, ...patch,
	};
}
const plain = (data: unknown, width = 200, expanded = false) =>
	createRunSummaryRow(data, expanded, theme)!.render(width).map(stripAnsi);

test("patch counts are exact and only count hunk lines, never file headers", () => {
	assert.deepEqual(patchLineCounts(PATCH), { added: 3, removed: 2 });
	assert.deepEqual(patchLineCounts("--- a\n+++ b\n"), { added: 0, removed: 0 }, "headers alone are not changes");
	assert.deepEqual(patchLineCounts(undefined), { added: 0, removed: 0 });
});

test("a real multi-edit is one call, one file, with the host patch's exact counts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi1337-summary-"));
	try {
		writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n");
		const result = await createEditTool(dir).execute("e1", {
			path: "a.ts", edits: [{ oldText: "two\n", newText: "TWO\nTWO-B\n" }, { oldText: "eleven\n", newText: "" }],
		});
		const c = createRunCollector();
		c.start(0);
		c.toolStart("e1", "edit", { path: join(dir, "a.ts") }, dir);
		c.toolEnd("e1", "edit", result, false, false);
		const data = c.finish(5_000, false, 0)!;
		assert.equal(data.tools, 1);
		assert.equal(data.edited, 1);
		assert.deepEqual([data.added, data.removed], [2, 2], "two lines in for one replaced, one deleted");
		assert.deepEqual(data.files, [{ path: "a.ts", kind: "edit", added: 2, removed: 2, lines: 0, script: false }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collector counts files, lines, commands and failures, nested calls included", () => {
	const c = createRunCollector();
	c.start(1_000);
	c.toolStart("1", "edit", { path: "/work/src/a.ts" }, CWD);
	c.toolEnd("1", "edit", edit(PATCH), false, false);
	c.toolStart("2", "edit", { path: "./src/a.ts" }, CWD); // the same file, spelled differently
	c.toolEnd("2", "edit", edit("@@ -1 +1 @@\n-x\n+y\n"), false, false);
	c.toolStart("3", "edit", { path: "src/b.ts" }, CWD);
	c.toolEnd("3", "edit", edit("@@ -1 +1,2 @@\n+z\n"), false, true); // nested
	c.toolStart("4", "write", { path: "src/c.ts", content: "a\nb\nc\n" }, CWD);
	c.toolEnd("4", "write", { content: [] }, false, true);
	c.toolStart("5", "edit", { path: "src/d.ts" }, CWD);
	c.toolEnd("5", "edit", { content: [{ type: "text", text: "no match" }] }, true, false); // failed: no file
	c.toolStart("6", "bash", { command: "npm test" }, CWD);
	c.toolEnd("6", "bash", {}, true, false);
	c.toolStart("7", "powershell", { command: "dir" }, CWD);
	c.toolEnd("7", "powershell", {}, false, true);
	c.toolStart("8", "read", { path: "x" }, CWD);
	c.toolEnd("8", "read", {}, false, false);
	const data = c.finish(9_000, false, 0.5)!;
	assert.equal(data.durationMs, 8_000);
	assert.deepEqual([data.edited, data.added, data.removed], [2, 5, 3]);
	assert.equal(data.wrote, 1);
	assert.deepEqual([data.commands, data.commandsFailed], [2, 1]);
	assert.deepEqual([data.tools, data.toolsFailed], [8, 2]);
	assert.equal(data.cost, 0.5);
	assert.deepEqual(data.files.map(f => [f.path, f.kind, f.added, f.removed, f.lines, f.script]), [
		["src/a.ts", "edit", 4, 3, 0, false],
		["src/b.ts", "edit", 1, 0, 0, true],
		["src/c.ts", "write", 0, 0, 3, true],
	]);
});

test("a path both written and edited counts once, as written, in first-touched order", () => {
	const c = createRunCollector();
	c.start(0);
	c.toolStart("1", "edit", { path: "a.ts" }, CWD);
	c.toolEnd("1", "edit", edit("@@ -1 +1 @@\n-x\n+y\n"), false, false);
	c.toolStart("2", "edit", { path: "b.ts" }, CWD);
	c.toolEnd("2", "edit", edit("@@ -1 +1 @@\n+y\n"), false, false);
	c.toolStart("3", "write", { path: "/work/a.ts", content: "1\n2" }, CWD);
	c.toolEnd("3", "write", {}, false, true);
	const data = c.finish(1, false, 0)!;
	assert.deepEqual([data.edited, data.added, data.removed, data.wrote], [1, 1, 0, 1], "a.ts's edit lines leave the edited totals");
	assert.deepEqual(data.files.map(f => [f.path, f.kind, f.lines, f.script]), [["a.ts", "write", 2, false], ["b.ts", "edit", 0, false]]);
});

test("zero, chat-only and never-started runs record nothing; interrupted and failed runs always do", () => {
	const c = createRunCollector();
	assert.equal(c.finish(10, false, 0), undefined, "no agent_start seen");
	c.start(0);
	c.turnEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(c.finish(10, false, 1), undefined, "a chat-only reply gets no row");
	c.start(0);
	const interrupted = c.finish(62_000, true, 0)!;
	assert.equal(interrupted.outcome, "interrupted");
	assert.equal(interrupted.tools, 0);
	c.start(0);
	c.turnEnd({ role: "assistant", stopReason: "error" });
	assert.equal(c.outcome(false), "failed");
	assert.equal(c.finish(12_000, false, 0)!.outcome, "failed");
	c.start(0);
	c.turnEnd({ role: "assistant", stopReason: "error" });
	c.turnEnd({ role: "toolResult" });
	c.toolStart("1", "read", {}, CWD);
	c.toolEnd("1", "read", {}, false, false);
	c.turnEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(c.finish(1, false, 0)!.outcome, "done", "a later successful turn clears the error");
	c.start(0);
	c.turnEnd({ role: "assistant", stopReason: "error" });
	assert.equal(c.finish(1, true, 0)!.outcome, "interrupted", "an abort outranks the error");
});

test("each run starts from zero", () => {
	const c = createRunCollector();
	c.start(0);
	c.toolStart("1", "write", { path: "a", content: "x" }, CWD);
	c.toolEnd("1", "write", {}, false, false);
	c.toolStart("2", "bash", {}, CWD); // never ends in this run
	c.turnEnd({ role: "assistant", stopReason: "error" });
	c.start(100);
	c.toolStart("3", "read", {}, CWD);
	c.toolEnd("3", "read", {}, false, false);
	c.toolEnd("2", "bash", {}, false, false); // a stray end from the old run is still a call that ended now
	const data = c.finish(200, false, 0)!;
	assert.deepEqual([data.outcome, data.wrote, data.files.length, data.tools, data.durationMs], ["done", 0, 0, 2, 100]);
	assert.equal(c.finish(300, true, 0), undefined, "finish resets too");
});

test("the stored file list is bounded; the counts stay exact", () => {
	const c = createRunCollector();
	c.start(0);
	for (let i = 0; i < MAX_SUMMARY_FILES + 10; i++) {
		c.toolStart(`${i}`, "edit", { path: `f${i}.ts` }, CWD);
		c.toolEnd(`${i}`, "edit", edit("@@ -1 +1 @@\n+a\n"), false, false);
	}
	const data = c.finish(1, false, 0)!;
	assert.equal(data.edited, MAX_SUMMARY_FILES + 10);
	assert.equal(data.added, MAX_SUMMARY_FILES + 10);
	assert.equal(data.files.length, MAX_SUMMARY_FILES);
	assert.equal(data.moreFiles, 10);
	assert.ok(parseRunSummary(JSON.parse(JSON.stringify(data))), "the bounded entry round-trips through JSON");
	assert.match(plain(data, 120, true).at(-1)!, /^ {3}… 10 more$/);
});

test("hostile paths are sanitized and bounded before they are stored", () => {
	const c = createRunCollector();
	c.start(0);
	const hostile = `src/\x1b]0;evil\x07ok‮\r\nFORGED${"x".repeat(100_000)}.ts`;
	c.toolStart("1", "write", { path: hostile, content: "" }, CWD);
	c.toolEnd("1", "write", {}, false, false);
	c.toolStart("2", "edit", { path: 42 }, CWD); // not a path: no file
	c.toolEnd("2", "edit", edit("@@ -1 +1 @@\n+a\n"), false, false);
	const data = c.finish(1, false, 0)!;
	assert.equal(data.files.length, 1);
	const stored = data.files[0]!.path;
	assert.ok(stored.length <= 512);
	assert.doesNotMatch(stored, /[\x00-\x1f\x7f-\x9f‪-‮]|evil/);
	assert.match(stored, /^src\/ok FORGEDx+/);
	for (const line of plain(data, 60, true)) assert.ok(visibleWidth(line) <= 60);
});

test("the four collapsed forms, worded and ordered as specified", () => {
	assert.deepEqual(plain(base({ edited: 3, added: 42, removed: 7, wrote: 1, commands: 6, commandsFailed: 1, tools: 12, toolsFailed: 1, cost: 1.237 })),
		[" ● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24"]);
	assert.deepEqual(plain(base({ outcome: "interrupted", durationMs: 62_000, edited: 1, added: 3, removed: 0, commands: 2, tools: 4 })),
		[" ● Interrupted after 1m 02s · edited 1 file +3 −0 · 2 commands"]);
	assert.deepEqual(plain(base({ outcome: "failed", durationMs: 12_000, commands: 2, commandsFailed: 1, tools: 2, toolsFailed: 1 })),
		[" ● Failed after 12s · 2 commands, 1 failed"]);
	assert.deepEqual(plain(base({ durationMs: 38_000, tools: 9 })), [" ● Done in 38s · 9 tool calls"]);
});

test("zero parts are omitted; tool calls stand in only when nothing more specific was done", () => {
	assert.deepEqual(plain(base({ outcome: "interrupted", durationMs: 4_000 })), [" ● Interrupted after 4.0s"]);
	assert.deepEqual(plain(base({ wrote: 2, tools: 5, toolsFailed: 1 })), [" ● Done in 2m 14s · wrote 2 files · 1 call failed"],
		"a failed call is never left out, even when no command ran, and it is named: not a failed file");
	assert.deepEqual(plain(base({ commands: 5, tools: 8, toolsFailed: 3 })), [" ● Done in 2m 14s · 5 commands · 3 other failed"],
		"failed reads beside passing commands still show");
	assert.deepEqual(plain(base({ commands: 2, commandsFailed: 1, tools: 4, toolsFailed: 2 })), [" ● Done in 2m 14s · 2 commands, 1 failed · 1 other failed"]);
	assert.deepEqual(plain(base({ edited: 1, tools: 1, cost: 0.004 })), [" ● Done in 2m 14s · edited 1 file"], "no counts when +0 −0; sub-cent cost hidden like the status row's delta");
	assert.deepEqual(plain(base({ tools: 3, toolsFailed: 2 })), [" ● Done in 2m 14s · 3 tool calls, 2 failed"]);
});

const widest = base({ edited: 3, added: 42, removed: 7, wrote: 1, commands: 6, commandsFailed: 1, tools: 12, toolsFailed: 1, cost: 1.24 });

test("narrowing is a ladder of whole forms, in order", () => {
	assert.deepEqual(summarySpellings(widest, theme).map(s => s.plain), [
		"● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24",
		"● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 1 command failed · ~$1.24",
		"● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 1 command failed",
		"● Done in 2m 14s · edited 3 files +42 −7 · 1 command failed",
		"● Done in 2m 14s · edited 3 files · 1 command failed",
		"● Done in 2m 14s · edited 3 files",
		"● Done in 2m 14s",
		"● Done",
		"●",
	]);
});

test("every width from 8 to 200 shows one whole form that fits, never narrower at a wider width", () => {
	for (const data of [widest, base({ outcome: "interrupted", durationMs: 62_000, edited: 1, added: 3, commands: 2, tools: 4 }), base({ durationMs: 38_000, tools: 9 })]) {
		const forms = summarySpellings(data, theme).map(s => s.plain);
		let previous = forms.length;
		for (let width = 8; width <= 200; width++) {
			const lines = createRunSummaryRow(data, false, theme)!.render(width);
			assert.equal(lines.length, 1, `one line at ${width}`);
			assert.ok(visibleWidth(lines[0]!) <= width, `fits ${width}`);
			const shown = stripAnsi(lines[0]!).trimStart();
			const rung = forms.indexOf(shown);
			assert.notEqual(rung, -1, `whole form at ${width}: ${JSON.stringify(shown)}`);
			assert.ok(rung <= previous, `width ${width} is not narrower than ${width - 1}`);
			if (rung > 0) assert.ok(visibleWidth(forms[rung - 1]!) > width - 2, `the next wider form does not fit at ${width}`);
			previous = rung;
		}
	}
});

test("colors: outcome dot, muted outcome and cost, dim details, diff counts, failures in error", () => {
	const line = createRunSummaryRow(widest, false, theme)!.render(200)[0]!;
	const runs = spans(line);
	assert.deepEqual(runs.slice(0, 2), [["success", "●"], ["muted", " Done in 2m 14s"]]);
	assert.ok(runs.some(([token, text]) => token === "toolDiffAdded" && text === " +42"));
	assert.ok(runs.some(([token, text]) => token === "toolDiffRemoved" && text === " −7"));
	assert.ok(runs.some(([token, text]) => token === "error" && text === "1 failed"));
	assert.ok(runs.some(([token, text]) => token === "dim" && text === "edited 3 files"));
	assert.ok(runs.some(([token, text]) => token === "dim" && text === " · "));
	assert.deepEqual(runs.at(-1), ["muted", "~$1.24"]);
	assert.deepEqual(spans(createRunSummaryRow(base({ outcome: "interrupted" }), false, theme)!.render(80)[0]!)[0], ["warning", "●"]);
	assert.deepEqual(spans(createRunSummaryRow(base({ outcome: "failed" }), false, theme)!.render(80)[0]!)[0], ["error", "●"]);
});

test("expanded: the same first line, then one row per file in order, bounded to the width", () => {
	const data = base({ edited: 1, added: 12, removed: 3, wrote: 1, tools: 2, files: [
		{ path: "src/a.ts", kind: "edit", added: 12, removed: 3, lines: 0, script: false },
		{ path: "docs/guide.md", kind: "write", added: 0, removed: 0, lines: 40, script: true },
	] });
	const rows = plain(data, 120, true);
	assert.deepEqual(rows, [
		plain(data, 120)[0],
		"   src/a.ts +12 −3",
		"   docs/guide.md wrote 40 lines (script)",
	]);
	assert.ok(spans(createRunSummaryRow(data, true, theme)!.render(120)[1]!).some(([token, text]) => token === "toolDiffAdded" && text === " +12"));
	assert.deepEqual(plain(data, 20, true), [" ● Done in 2m 14s", "   src/a.ts +12 −3", "   docs/guide.md"]);
	for (let width = 1; width <= 40; width++) for (const line of createRunSummaryRow(data, true, theme)!.render(width)) assert.ok(visibleWidth(line) <= width);
	assert.equal(createRunSummaryRow(data, false, theme)!.render(120).length, 1, "collapsed stays one line");
});

test("a row with files to show ends with the dim expand hint, the first thing narrowing drops", () => {
	const files = [{ path: "src/a.ts", kind: "edit" as const, added: 42, removed: 7, lines: 0, script: false }];
	const data = { ...widest, files };
	// The host's keyHint arrives painted; only its sanitized text is shown, in dim.
	const hint = () => "\x1b[38;5;1mctrl+o\x1b[39m\x1b[38;5;2m to expand\x1b[39m";
	const row = (width: number, expanded = false, value: unknown = data) => createRunSummaryRow(value, expanded, theme, 1, hint)!.render(width);
	const full = "● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24";
	assert.deepEqual(row(200).map(stripAnsi), [` ${full} (ctrl+o to expand)`]);
	assert.deepEqual(spans(row(200)[0]!).at(-1), ["dim", " (ctrl+o to expand)"]);
	// One column short of the hint: the command total is still whole.
	assert.deepEqual(row(visibleWidth(full) + 2 + 18).map(stripAnsi), [` ${full}`]);
	assert.deepEqual(row(visibleWidth(full) + 2 + 19).map(stripAnsi), [` ${full} (ctrl+o to expand)`]);
	assert.deepEqual(row(200, true).map(stripAnsi), [` ${full}`, "   src/a.ts +42 −7"], "already expanded: no hint");
	assert.deepEqual(row(200, false, widest).map(stripAnsi), [` ${full}`], "nothing to expand: no hint");
	assert.deepEqual(row(200, false, { ...widest, moreFiles: 3 }).map(stripAnsi), [` ${full} (ctrl+o to expand)`], "unlisted files still expand to a count");
	assert.deepEqual(plain(data), [` ${full}`], "no hint unless the host's is injected");
	const blank = createRunSummaryRow(data, false, theme, 1, () => "")!.render(200).map(stripAnsi);
	assert.deepEqual(blank, [` ${full} (expand)`], "an empty host hint falls back like tool rows");
});

test("malformed or foreign entry data renders nothing", () => {
	const good = JSON.parse(JSON.stringify(widest));
	assert.ok(createRunSummaryRow(good, false, theme));
	for (const bad of [
		undefined, null, "text", 42, [], {},
		{ ...good, v: 2 }, { ...good, v: "1" },
		{ ...good, outcome: "maybe" },
		{ ...good, durationMs: -1 }, { ...good, durationMs: Number.NaN }, { ...good, cost: "1.24" },
		{ ...good, edited: 1.5 }, { ...good, tools: -1 }, { ...good, moreFiles: undefined },
		{ ...good, files: "a.ts" }, { ...good, files: [{ path: "a.ts" }] },
		{ ...good, files: [{ path: "\x1b[2J", kind: "edit", added: 0, removed: 0, lines: 0, script: false }] },
		{ ...good, files: Array.from({ length: MAX_SUMMARY_FILES + 1 }, () => ({ path: "a", kind: "edit", added: 0, removed: 0, lines: 0, script: false })) },
	]) assert.equal(createRunSummaryRow(bad, false, theme), undefined, JSON.stringify(bad)?.slice(0, 80));
});

// ---- a failure count names what failed --------------------------------------

test("a failure count standing alone carries its noun, at every width", () => {
	const narrowest = (data: RunSummaryData) => summarySpellings(data, theme).map(s => s.plain).filter(form => form.includes("failed")).at(-1);
	// Only commands failed: they are named as commands once the total is gone.
	assert.equal(narrowest(base({ edited: 1, added: 1, removed: 1, commands: 3, commandsFailed: 1, tools: 4, toolsFailed: 1 })), "● Done in 2m 14s · edited 1 file · 1 command failed");
	assert.equal(narrowest(base({ commands: 6, commandsFailed: 2, tools: 6, toolsFailed: 2 })), "● Done in 2m 14s · 2 commands failed");
	// A failed read beside passing commands, or beside a failed one: calls.
	assert.equal(narrowest(base({ commands: 5, tools: 8, toolsFailed: 3 })), "● Done in 2m 14s · 3 calls failed");
	assert.equal(narrowest(base({ commands: 2, commandsFailed: 1, tools: 4, toolsFailed: 2 })), "● Done in 2m 14s · 2 calls failed");
	// No command at all: the failed call is a call, in the widest form too.
	assert.deepEqual(summarySpellings(base({ edited: 1, added: 1, removed: 1, tools: 2, toolsFailed: 1 }), theme).map(s => s.plain), [
		"● Done in 2m 14s · edited 1 file +1 −1 · 1 call failed",
		"● Done in 2m 14s · edited 1 file · 1 call failed",
		"● Done in 2m 14s · edited 1 file",
		"● Done in 2m 14s",
		"● Done",
		"●",
	]);
	assert.equal(narrowest(base({ tools: 3, toolsFailed: 2 })), "● Done in 2m 14s · 2 calls failed");
	// The widest forms keep their wording.
	assert.deepEqual(plain(base({ commands: 6, commandsFailed: 1, tools: 6, toolsFailed: 1 })), [" ● Done in 2m 14s · 6 commands, 1 failed"]);
	assert.deepEqual(plain(base({ commands: 5, tools: 8, toolsFailed: 3 })), [" ● Done in 2m 14s · 5 commands · 3 other failed"]);
	// No spelling of any of them ends a part with a bare count.
	for (const data of [widest, base({ edited: 1, tools: 2, toolsFailed: 1 }), base({ wrote: 1, commands: 2, commandsFailed: 2, tools: 5, toolsFailed: 4 })]) {
		for (const { plain: form } of summarySpellings(data, theme)) {
			for (const part of form.split(" · ")) assert.doesNotMatch(part, /^\d+ failed$/, form);
		}
	}
	const runs = spans(createRunSummaryRow(base({ edited: 1, tools: 2, toolsFailed: 1 }), false, theme)!.render(200)[0]!);
	assert.deepEqual(runs.at(-1), ["error", "1 call failed"], "the whole clause is the failure");
});

// ---- background work still running ------------------------------------------

const WAITING = { agents: 3, monitors: 1, timers: 1, scripts: 1 };
const awaited = base({ durationMs: 9_000, tools: 7, cost: 0.08, waiting: WAITING });

test("a run that settles with background work running says so instead of Done", () => {
	assert.deepEqual(plain(awaited), [" ● Turn ended in 9.0s · 7 tool calls · ~$0.08 · waiting on 3 agents, 1 monitor, 1 timer, 1 script"]);
	const runs = spans(createRunSummaryRow(awaited, false, theme)!.render(200)[0]!);
	assert.deepEqual(runs.slice(0, 2), [["muted", "●"], ["muted", " Turn ended in 9.0s"]], "no success dot");
	assert.deepEqual(runs.at(-1), ["muted", "waiting on 3 agents, 1 monitor, 1 timer, 1 script"]);
	assert.ok(!runs.some(([token]) => token === "success"), "nothing on the row claims success");
	// One kind is named with its own plural; zero kinds are left out.
	assert.deepEqual(plain(base({ tools: 1, waiting: { agents: 0, monitors: 0, timers: 1, scripts: 0 } })), [" ● Turn ended in 2m 14s · 1 tool call · waiting on 1 timer"]);
	assert.deepEqual(plain(base({ tools: 1, waiting: { agents: 2, monitors: 0, timers: 0, scripts: 3 } })), [" ● Turn ended in 2m 14s · 1 tool call · waiting on 2 agents, 3 scripts"]);
});

test("interrupted and failed runs keep their word and dot and carry the same clause", () => {
	const interrupted = base({ outcome: "interrupted", durationMs: 62_000, commands: 2, tools: 2, waiting: WAITING });
	assert.deepEqual(plain(interrupted), [" ● Interrupted after 1m 02s · 2 commands · waiting on 3 agents, 1 monitor, 1 timer, 1 script"]);
	assert.deepEqual(spans(createRunSummaryRow(interrupted, false, theme)!.render(200)[0]!)[0], ["warning", "●"]);
	const failed = base({ outcome: "failed", durationMs: 12_000, waiting: { agents: 1, monitors: 0, timers: 0, scripts: 0 } });
	assert.deepEqual(plain(failed), [" ● Failed after 12s · waiting on 1 agent"]);
	assert.deepEqual(spans(createRunSummaryRow(failed, false, theme)!.render(200)[0]!)[0], ["error", "●"]);
});

test("the waiting clause narrows to one count before anything else goes, then outlasts the cost and the work detail", () => {
	const data = { ...widest, waiting: WAITING };
	assert.deepEqual(summarySpellings(data, theme).map(s => s.plain), [
		"● Turn ended in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24 · waiting on 3 agents, 1 monitor, 1 timer, 1 script",
		"● Turn ended in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24 · waiting on 6 background tasks",
		"● Turn ended in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 1 command failed · ~$1.24 · waiting on 6 background tasks",
		"● Turn ended in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 1 command failed · waiting on 6 background tasks",
		"● Turn ended in 2m 14s · edited 3 files +42 −7 · 1 command failed · waiting on 6 background tasks",
		"● Turn ended in 2m 14s · edited 3 files · 1 command failed · waiting on 6 background tasks",
		"● Turn ended in 2m 14s · edited 3 files · waiting on 6 background tasks",
		"● Turn ended in 2m 14s · waiting on 6 background tasks",
		"● Turn ended in 2m 14s",
		"● Turn ended",
		"●",
	]);
	// One kind has no shorter spelling: the ladder is the plain one plus the clause.
	const one = { ...widest, waiting: { agents: 2, monitors: 0, timers: 0, scripts: 0 } };
	const forms = summarySpellings(one, theme).map(s => s.plain);
	assert.equal(forms.length, 10);
	assert.equal(forms.filter(form => form.endsWith("waiting on 2 agents")).length, 7);
	// The single count replaces the breakdown only where it is shorter.
	const short = summarySpellings({ ...widest, waiting: { agents: 1, monitors: 0, timers: 1, scripts: 0 } }, theme).map(s => s.plain);
	assert.equal(short.length, 10);
	assert.ok(short.every(form => !form.includes("background tasks")), "\"1 agent, 1 timer\" is already narrower than \"2 background tasks\"");
	assert.equal(short.filter(form => form.endsWith("waiting on 1 agent, 1 timer")).length, 7);
	// The expand hint still tops the ladder and is the first thing dropped.
	const hinted = summarySpellings(data, theme, "ctrl+o to expand").map(s => s.plain);
	assert.equal(hinted[0], `${hinted[1]} (ctrl+o to expand)`);
	assert.equal(hinted.length, 12);
});

test("with a waiting clause every width from 8 to 200 still shows one whole form, never a clipped clause", () => {
	for (const data of [{ ...widest, waiting: WAITING }, awaited, base({ outcome: "failed", durationMs: 12_000, waiting: { agents: 12, monitors: 0, timers: 0, scripts: 0 } })]) {
		const forms = summarySpellings(data, theme).map(s => s.plain);
		let previous = forms.length;
		for (let width = 8; width <= 200; width++) {
			const lines = createRunSummaryRow(data, false, theme)!.render(width);
			assert.equal(lines.length, 1);
			assert.ok(visibleWidth(lines[0]!) <= width, `fits ${width}`);
			const shown = stripAnsi(lines[0]!).trimStart();
			const rung = forms.indexOf(shown);
			assert.notEqual(rung, -1, `whole form at ${width}: ${JSON.stringify(shown)}`);
			assert.ok(rung <= previous, `width ${width} is not narrower than ${width - 1}`);
			assert.doesNotMatch(shown, /…/, "nothing is clipped");
			if (rung > 0) assert.ok(visibleWidth(forms[rung - 1]!) > width - 2, `the next wider form does not fit at ${width}`);
			previous = rung;
		}
	}
});

test("the collector stores the snapshot it is handed and never lets it decide whether a row exists", () => {
	const c = createRunCollector();
	c.start(0);
	c.turnEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(c.finish(10, false, 0, WAITING), undefined, "a chat-only reply still gets no row");
	c.start(0);
	c.toolStart("1", "read", {}, CWD);
	c.toolEnd("1", "read", {}, false, false);
	const data = c.finish(9_000, false, 0.08, WAITING)!;
	assert.deepEqual(data.waiting, WAITING);
	assert.notEqual(data.waiting, WAITING, "a copy, not the caller's object");
	assert.equal(data.outcome, "done", "the outcome is still the run's own; only the wording changes");
	assert.deepEqual(parseRunSummary(JSON.parse(JSON.stringify(data)))?.waiting, WAITING, "round-trips through the session file");
	c.start(0);
	c.toolStart("1", "read", {}, CWD);
	c.toolEnd("1", "read", {}, false, false);
	assert.ok(!("waiting" in c.finish(1, false, 0)!), "no background work: no field at all");
	for (const bad of [{ agents: 0, monitors: 0, timers: 0, scripts: 0 }, { agents: 1 }, { agents: -1, monitors: 0, timers: 0, scripts: 0 }] as never[]) {
		c.start(0);
		c.toolStart("1", "read", {}, CWD);
		c.toolEnd("1", "read", {}, false, false);
		assert.ok(!("waiting" in c.finish(1, false, 0, bad)!), JSON.stringify(bad));
	}
});

test("entries without the optional fields, or with malformed ones, render byte-identically to before", () => {
	// An entry exactly as the previous version wrote it.
	const old = JSON.parse(JSON.stringify(widest));
	assert.deepEqual(Object.keys(old).sort(), ["added", "commands", "commandsFailed", "cost", "durationMs", "edited", "files", "moreFiles", "outcome", "removed", "tools", "toolsFailed", "v", "wrote"]);
	const files = [{ path: "src/a.ts", kind: "edit", added: 42, removed: 7, lines: 0, script: false }];
	const render = (value: unknown, expanded: boolean, width: number) => createRunSummaryRow(value, expanded, theme, 1, () => "ctrl+o to expand")!.render(width);
	assert.deepEqual(render({ ...old, files }, false, 200).map(stripAnsi), [" ● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24 (ctrl+o to expand)"]);
	assert.deepEqual(render({ ...old, files }, true, 200).map(stripAnsi), [" ● Done in 2m 14s · edited 3 files +42 −7 · wrote 1 file · 6 commands, 1 failed · ~$1.24", "   src/a.ts +42 −7"]);
	assert.deepEqual(spans(render(old, false, 200)[0]!)[0], ["success", "●"]);
	for (const malformed of [
		{ waiting: "agents=3" }, { waiting: null }, { waiting: [] }, { waiting: {} }, { waiting: { agents: 3 } },
		{ waiting: { agents: 0, monitors: 0, timers: 0, scripts: 0 } }, { waiting: { agents: "3", monitors: 0, timers: 0, scripts: 0 } },
		{ waiting: { agents: 1.5, monitors: 0, timers: 0, scripts: 0 } }, { waiting: { agents: -1, monitors: 1, timers: 0, scripts: 0 } },
		{ waiting: { agents: 10_000, monitors: 0, timers: 0, scripts: 0 } }, { waiting: { agents: Number.NaN, monitors: 0, timers: 0, scripts: 0 } },
		{ modelMs: -1 }, { modelMs: "92000" }, { modelMs: Number.POSITIVE_INFINITY }, { modelMs: 134_001 }, { modelMs: null },
		{ outputTokens: 1.5 }, { outputTokens: -4 }, { outputTokens: "4416" },
		{ modelMs: "x", outputTokens: 4416 }, { waiting: 7, modelMs: {}, outputTokens: [] },
	]) {
		for (const expanded of [false, true]) {
			for (const width of [30, 60, 200]) {
				assert.deepEqual(render({ ...old, files, ...malformed }, expanded, width), render({ ...old, files }, expanded, width),
					`${JSON.stringify(malformed)} expanded=${expanded} @${width}`);
			}
		}
	}
});

// ---- where the run's time went ----------------------------------------------

test("model time is the sum of each turn's turn_start → assistant message_end; the rest of the run is tools", () => {
	const c = createRunCollector();
	const assistant = (output: number) => ({ role: "assistant", stopReason: "toolUse", usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output } });
	c.turnStart(500); // before any run: ignored
	c.start(1_000);
	c.turnStart(1_000);
	c.messageEnd({ role: "user", content: "hi" }, 1_010); // the prompt's own message_end is not the model's
	c.messageEnd(assistant(1_000), 31_000); // 30 s
	c.toolStart("1", "bash", { command: "npm test" }, CWD);
	c.toolEnd("1", "bash", {}, false, false);
	c.messageEnd({ role: "toolResult" }, 51_000);
	c.turnEnd(assistant(1_000));
	c.turnStart(51_000);
	c.messageEnd(assistant(2_000), 111_000); // 60 s
	c.messageEnd(assistant(5), 112_000); // a second assistant end with no turn_start: tokens, no time
	c.turnEnd({ role: "assistant", stopReason: "stop" });
	const data = c.finish(121_000, false, 0)!;
	assert.equal(data.durationMs, 120_000);
	assert.equal(data.modelMs, 90_000);
	assert.equal(data.outputTokens, 3_005);
	assert.deepEqual(timingSpellings(data), ["model 1m 30s · tools 30s · 33 tok/s", "model 1m 30s · tools 30s", "model 1m 30s"]);
	assert.ok(parseRunSummary(JSON.parse(JSON.stringify(data))), "round-trips");
	// The next run starts from nothing.
	c.start(0);
	c.toolStart("1", "read", {}, CWD);
	c.toolEnd("1", "read", {}, false, false);
	const next = c.finish(5_000, false, 0)!;
	assert.ok(!("modelMs" in next) && !("outputTokens" in next), "no turn observed: nothing is recorded, not a zero");
	assert.deepEqual(timingSpellings(next), []);
});

test("a figure that is not known is omitted, never guessed", () => {
	const c = createRunCollector();
	const run = (messages: unknown[]) => {
		c.start(0);
		c.toolStart("1", "read", {}, CWD);
		c.toolEnd("1", "read", {}, false, false);
		let now = 0;
		for (const message of messages) {
			c.turnStart(now);
			c.messageEnd(message, now += 10_000);
		}
		return c.finish(now + 5_000, false, 0)!;
	};
	// One message without usage.output makes the sum a guess: no token count, the time stays.
	const partial = run([{ role: "assistant", usage: { output: 400 } }, { role: "assistant" }]);
	assert.equal(partial.modelMs, 20_000);
	assert.ok(!("outputTokens" in partial));
	assert.deepEqual(timingSpellings(partial), ["model 20s · tools 5.0s", "model 20s"]);
	for (const usage of [{ output: "400" }, { output: -1 }, { output: Number.NaN }, null, "x"]) {
		assert.ok(!("outputTokens" in run([{ role: "assistant", usage }])), JSON.stringify(usage));
	}
	assert.equal(run([{ role: "assistant", usage: { output: 0 } }]).outputTokens, 0, "a reported zero is known");
	// A turn_start with no assistant end (cut off) adds no model time.
	c.start(0);
	c.turnStart(0);
	const cut = c.finish(8_000, true, 0)!;
	assert.ok(!("modelMs" in cut));
	// A clock that steps backwards never yields negative time, and model time never exceeds the run.
	c.start(10_000);
	c.turnStart(10_000);
	c.messageEnd({ role: "assistant", usage: { output: 1 } }, 9_000);
	c.turnStart(10_000);
	c.messageEnd({ role: "assistant", usage: { output: 1 } }, 40_000);
	const skewed = c.finish(20_000, true, 0)!;
	assert.deepEqual([skewed.durationMs, skewed.modelMs], [10_000, 10_000]);
	assert.deepEqual(timingSpellings(skewed), ["model 10s"], "tools time is never negative; the rate rounds to zero and is left out");
});

test("the timing line: tools from one second, tok/s only with a second of model time and tokens, nothing when unknown", () => {
	const timed = (patch: Partial<RunSummaryData>) => timingSpellings(base({ durationMs: 134_000, ...patch }));
	assert.deepEqual(timed({ modelMs: 92_000, outputTokens: 4_416 }), ["model 1m 32s · tools 42s · 48 tok/s", "model 1m 32s · tools 42s", "model 1m 32s"]);
	assert.deepEqual(timed({}), [], "model time unknown: no line");
	assert.deepEqual(timed({ outputTokens: 4_416 }), [], "tokens alone say nothing about time");
	assert.deepEqual(timed({ modelMs: 92_000 }), ["model 1m 32s · tools 42s", "model 1m 32s"], "tokens unknown: no rate");
	assert.deepEqual(timed({ modelMs: 92_000, outputTokens: 0 }), ["model 1m 32s · tools 42s", "model 1m 32s"], "no tokens: no rate");
	assert.deepEqual(timed({ durationMs: 92_999, modelMs: 92_000, outputTokens: 4_416 }), ["model 1m 32s · 48 tok/s", "model 1m 32s"], "tools under a second are left out");
	assert.deepEqual(timed({ durationMs: 93_000, modelMs: 92_000, outputTokens: 4_416 })[0], "model 1m 32s · tools 1.0s · 48 tok/s");
	assert.deepEqual(timed({ durationMs: 5_000, modelMs: 999, outputTokens: 500 }), ["model 999ms · tools 4.0s", "model 999ms"], "under a second of model time: no rate");
	assert.deepEqual(timed({ durationMs: 5_000, modelMs: 1_000, outputTokens: 500 })[0], "model 1.0s · tools 4.0s · 500 tok/s");
	assert.deepEqual(timed({ modelMs: 100_000, outputTokens: 49 }), ["model 1m 40s · tools 34s", "model 1m 40s"], "a rate that rounds to zero is not a rate");
	assert.deepEqual(timed({ modelMs: 100_000, outputTokens: 50 })[0], "model 1m 40s · tools 34s · 1 tok/s");
	assert.deepEqual(timed({ modelMs: 0 }), ["model 0ms · tools 2m 14s", "model 0ms"]);
});

test("expanded only: one dim timing line under the headline and above the files; collapsed and its hint are unchanged", () => {
	const files = [
		{ path: "src/a.ts", kind: "edit" as const, added: 12, removed: 3, lines: 0, script: false },
		{ path: "docs/guide.md", kind: "write" as const, added: 0, removed: 0, lines: 40, script: true },
	];
	const untimed = base({ edited: 1, added: 12, removed: 3, wrote: 1, tools: 2, files });
	const data = { ...untimed, modelMs: 92_000, outputTokens: 4_416 };
	const hint = () => "ctrl+o to expand";
	const row = (value: RunSummaryData, expanded: boolean, width: number, withHint = true) => createRunSummaryRow(value, expanded, theme, 1, withHint ? hint : undefined)!.render(width);
	assert.deepEqual(row(data, true, 120).map(stripAnsi), [
		" ● Done in 2m 14s · edited 1 file +12 −3 · wrote 1 file",
		"   model 1m 32s · tools 42s · 48 tok/s",
		"   src/a.ts +12 −3",
		"   docs/guide.md wrote 40 lines (script)",
	]);
	assert.deepEqual(spans(row(data, true, 120)[1]!), [["dim", "  model 1m 32s · tools 42s · 48 tok/s"]], "one dim run");
	// Collapsed: byte-identical to an entry with no timing, at every width, hint included.
	for (let width = 1; width <= 160; width++) {
		assert.deepEqual(row(data, false, width), row(untimed, false, width), `collapsed @${width}`);
		for (const line of row(data, true, width)) assert.ok(visibleWidth(line) <= width, `expanded fits ${width}`);
	}
	// A run with timing but no files gains no hint: the hint's rule is still "files to list".
	const bare = base({ durationMs: 38_000, tools: 9, modelMs: 30_000, outputTokens: 900 });
	assert.deepEqual(row(bare, false, 200).map(stripAnsi), [" ● Done in 38s · 9 tool calls"]);
	assert.deepEqual(row(bare, true, 200).map(stripAnsi), [" ● Done in 38s · 9 tool calls", "   model 30s · tools 8.0s · 30 tok/s"]);
	// Narrowing drops the rate, then the tools time; each form is whole.
	const second = (width: number) => stripAnsi(row(data, true, width)[1]!);
	assert.equal(second(39), "   model 1m 32s · tools 42s · 48 tok/s");
	assert.equal(second(38), "   model 1m 32s · tools 42s");
	assert.equal(second(28), "   model 1m 32s · tools 42s");
	assert.equal(second(27), "   model 1m 32s");
	assert.equal(second(16), "   model 1m 32s");
	// Waiting and timing together: the headline changes, the timing line does not.
	const both = row({ ...data, waiting: WAITING }, true, 160).map(stripAnsi);
	assert.equal(both[0], " ● Turn ended in 2m 14s · edited 1 file +12 −3 · wrote 1 file · waiting on 3 agents, 1 monitor, 1 timer, 1 script");
	assert.equal(both[1], "   model 1m 32s · tools 42s · 48 tok/s");
});

test("the timing line is whole or absent at every width, never clipped inside a number", () => {
	const files = [{ path: "src/a.ts", kind: "edit" as const, added: 12, removed: 3, lines: 0, script: false }];
	for (const patch of [
		{ modelMs: 92_000, outputTokens: 4_416 }, // model 1m 32s · tools 42s · 48 tok/s
		{ modelMs: 63_000 }, // the reported clip: "   model 1m 3…"
		{ durationMs: 5_000, modelMs: 4_200, outputTokens: 900 }, // model 4.2s, tools under a second
		{ modelMs: 92_000, thinkingMs: 40_000, outputTokens: 4_416 },
	]) {
		const data = base({ edited: 1, added: 12, removed: 3, tools: 1, files, ...patch });
		const spellings = timingSpellings(data);
		const narrowest = spellings.at(-1)!;
		const shown = new Set<string>();
		for (let width = 1; width <= 80; width++) {
			const lines = createRunSummaryRow(data, true, theme)!.render(width).map(stripAnsi);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `@${width}: fits`);
			// One cell of indent each side, two more before the text: the narrowest spelling needs its own width plus four.
			const absent = width < narrowest.length + 4;
			// Absent is no line at all: the file row follows the headline, with no indent-only row between.
			assert.equal(lines.length, absent ? 2 : 3, `@${width}: headline, ${absent ? "no timing line" : "timing"}, one file: ${JSON.stringify(lines)}`);
			for (const line of lines) assert.notEqual(line.trim(), "", `@${width}: never a blank row: ${JSON.stringify(lines)}`);
			assert.ok(lines.at(-1)!.includes("src") || width < 8, `@${width}: the last row is the file's`);
			const timing = absent ? "" : lines[1]!.trim();
			if (!absent) assert.ok(spellings.includes(timing), `@${width}: a whole spelling: "${lines[1]}"`);
			for (const line of lines) assert.doesNotMatch(line, /model.*…/, `@${width}: never clipped inside the timing: "${line}"`);
			shown.add(timing);
		}
		assert.deepEqual([...shown].sort(), ["", ...spellings].sort(), "every spelling, and its absence, appears in the sweep");
		// The widths the review named: under about 16 columns the row count drops, nothing is blank.
		assert.deepEqual(createRunSummaryRow(data, true, theme)!.render(narrowest.length + 3).map((line) => stripAnsi(line).trim() === ""), [false, false]);
	}
	// An entry with no timing has no such row to leave blank.
	assert.equal(createRunSummaryRow(base({ edited: 1, tools: 1, files }), true, theme)!.render(10).length, 2);
});

// ---- thinking time: a part of the model time ---------------------------------

/** A collector with one run open and one read behind it, so the run is worth an entry. */
function openRun(startedAt = 0) {
	const c = createRunCollector();
	c.start(startedAt);
	c.toolStart("1", "read", {}, CWD);
	c.toolEnd("1", "read", {}, false, false);
	return c;
}
const ASSISTANT = { role: "assistant", usage: { output: 100 } };

test("thinking time sums thinking_start → thinking_end across the run's messages; a message's end closes a block left open", () => {
	const c = createRunCollector();
	c.streamEvent({ type: "thinking_start", contentIndex: 0 }, 500); // before any run: ignored
	c.start(1_000);
	c.toolStart("1", "bash", { command: "npm test" }, CWD);
	c.toolEnd("1", "bash", {}, false, false);
	c.turnStart(1_000);
	c.streamEvent({ type: "thinking_start", contentIndex: 0 }, 2_000);
	c.streamEvent({ type: "thinking_delta", contentIndex: 0, delta: "hm" }, 5_000);
	c.streamEvent({ type: "thinking_end", contentIndex: 0, content: "hm" }, 12_000); // 10 s
	c.streamEvent({ type: "text_start", contentIndex: 1 }, 12_000);
	c.streamEvent({ type: "text_delta", contentIndex: 1, delta: "ok" }, 15_000);
	c.streamEvent({ type: "thinking_start", contentIndex: 2 }, 20_000);
	c.streamEvent({ type: "thinking_end", contentIndex: 2, content: "" }, 25_000); // 5 s
	c.messageEnd(ASSISTANT, 31_000); // 30 s of model time
	c.turnStart(41_000);
	c.streamEvent({ type: "thinking_start", contentIndex: 0 }, 42_000);
	c.messageEnd(ASSISTANT, 50_000); // the stream was cut off mid-thought: 8 s, closed here; 9 s of model time
	c.streamEvent({ type: "thinking_end", contentIndex: 0 }, 55_000); // a late end with nothing open adds nothing
	const data = c.finish(61_000, false, 0)!;
	assert.deepEqual([data.durationMs, data.modelMs, data.thinkingMs], [60_000, 39_000, 23_000]);
	assert.deepEqual(timingSpellings(data), [
		"model 39s (23s thinking) · tools 21s · 5 tok/s",
		"model 39s (23s thinking) · tools 21s",
		"model 39s · tools 21s",
		"model 39s",
	]);
	assert.deepEqual(parseRunSummary(JSON.parse(JSON.stringify(data))), data, "round-trips");
	// The next run starts from nothing.
	c.start(0);
	c.toolStart("1", "read", {}, CWD);
	c.toolEnd("1", "read", {}, false, false);
	c.turnStart(0);
	c.messageEnd(ASSISTANT, 5_000);
	assert.ok(!("thinkingMs" in c.finish(6_000, false, 0)!), "no thinking observed: nothing is recorded, not a zero");
});

test("thinking time is omitted rather than guessed: under a second, past the model time, or with no model time at all", () => {
	const think = (c: ReturnType<typeof openRun>, from: number, to: number) => {
		c.streamEvent({ type: "thinking_start" }, from);
		c.streamEvent({ type: "thinking_end" }, to);
	};
	let c = openRun();
	c.turnStart(0);
	think(c, 0, 999);
	c.messageEnd(ASSISTANT, 10_000);
	assert.ok(!("thinkingMs" in c.finish(10_000, false, 0)!), "under a second is not worth a place");

	c = openRun();
	c.turnStart(0);
	think(c, 0, 1_000);
	c.messageEnd(ASSISTANT, 1_000);
	assert.equal(c.finish(1_000, false, 0)!.thinkingMs, 1_000, "a second is; all of the model time may be thinking");

	// A clock that stepped: more thinking than model time is a mismeasure, never printed.
	c = openRun(10_000);
	c.turnStart(10_000);
	think(c, 1_000, 9_000);
	c.messageEnd(ASSISTANT, 12_000);
	const skewed = c.finish(20_000, false, 0)!;
	assert.equal(skewed.modelMs, 2_000);
	assert.ok(!("thinkingMs" in skewed));

	// No turn measured: no model time, so nothing for the thinking to be a part of.
	c = openRun();
	think(c, 0, 5_000);
	c.messageEnd(ASSISTANT, 6_000);
	const unmeasured = c.finish(8_000, false, 0)!;
	assert.ok(!("modelMs" in unmeasured) && !("thinkingMs" in unmeasured));

	// A block whose message never ended is not carried into the next turn.
	c = openRun();
	c.turnStart(0);
	c.streamEvent({ type: "thinking_start" }, 1_000);
	c.turnStart(60_000);
	c.messageEnd(ASSISTANT, 65_000);
	assert.ok(!("thinkingMs" in c.finish(65_000, false, 0)!));

	// Only an assistant message closes a block; a repeated start keeps the first; a bad clock opens none.
	c = openRun();
	c.turnStart(0);
	c.streamEvent({ type: "thinking_start" }, 1_000);
	c.streamEvent({ type: "thinking_start" }, 3_000);
	c.messageEnd({ role: "toolResult" }, 2_000);
	c.streamEvent({ type: "thinking_end" }, 4_000); // 3 s, from the first start
	c.streamEvent({ type: "thinking_start" }, Number.NaN);
	c.streamEvent({ type: "thinking_end" }, 9_000);
	for (const foreign of [undefined, null, "thinking_start", 7, {}, { type: 1 }, { type: "thinking" }]) c.streamEvent(foreign, 9_500);
	c.messageEnd(ASSISTANT, 10_000);
	assert.equal(c.finish(10_000, false, 0)!.thinkingMs, 3_000);
});

test("the timing line carries thinking in parentheses after the model time; the rate goes first, then the parenthesis, then tools", () => {
	const timed = (patch: Partial<RunSummaryData>) => timingSpellings(base({ durationMs: 134_000, ...patch }));
	assert.deepEqual(timed({ modelMs: 92_000, thinkingMs: 40_000, outputTokens: 4_416 }), [
		"model 1m 32s (40s thinking) · tools 42s · 48 tok/s",
		"model 1m 32s (40s thinking) · tools 42s",
		"model 1m 32s · tools 42s",
		"model 1m 32s",
	]);
	assert.deepEqual(timed({ modelMs: 92_000, thinkingMs: 40_000 }), ["model 1m 32s (40s thinking) · tools 42s", "model 1m 32s · tools 42s", "model 1m 32s"], "no rate");
	assert.deepEqual(timed({ durationMs: 92_500, modelMs: 92_000, thinkingMs: 40_000, outputTokens: 4_416 }),
		["model 1m 32s (40s thinking) · 48 tok/s", "model 1m 32s (40s thinking)", "model 1m 32s"], "no tools time");
	assert.equal(timed({ modelMs: 92_000, thinkingMs: 4_200 })[0], "model 1m 32s (4.2s thinking) · tools 42s");
	assert.equal(timed({ modelMs: 92_000, thinkingMs: 65_000 })[0], "model 1m 32s (1m 05s thinking) · tools 42s");
	assert.equal(timed({ modelMs: 40_000, thinkingMs: 40_000 })[0], "model 40s (40s thinking) · tools 1m 34s", "all of it may be thinking");
	// Never an addend: the terms of the line are model and tools, and they add up to the run.
	assert.ok(timed({ modelMs: 92_000, thinkingMs: 40_000 }).every(spelling => !/· \S+ thinking|thinking \d/.test(spelling)));
	// Passed in directly (not through the parser), an impossible figure is still not printed.
	for (const thinkingMs of [999, 92_001, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.deepEqual(timed({ modelMs: 92_000, thinkingMs }), ["model 1m 32s · tools 42s", "model 1m 32s"], String(thinkingMs));
	}
	assert.deepEqual(timed({ thinkingMs: 40_000 }), [], "no model time: no line at all");
});

test("an entry with thinking time: one dim line expanded, the collapsed row untouched, malformed values read as absent", () => {
	const files = [{ path: "src/a.ts", kind: "edit" as const, added: 12, removed: 3, lines: 0, script: false }];
	const timed = base({ edited: 1, added: 12, removed: 3, tools: 1, files, modelMs: 92_000, outputTokens: 4_416 });
	const data = { ...timed, thinkingMs: 40_000 };
	const hint = () => "ctrl+o to expand";
	const row = (value: unknown, expanded: boolean, width: number) => createRunSummaryRow(value, expanded, theme, 1, hint)!.render(width);
	assert.deepEqual(row(data, true, 120).map(stripAnsi), [
		" ● Done in 2m 14s · edited 1 file +12 −3",
		"   model 1m 32s (40s thinking) · tools 42s · 48 tok/s",
		"   src/a.ts +12 −3",
	]);
	assert.deepEqual(spans(row(data, true, 120)[1]!), [["dim", "  model 1m 32s (40s thinking) · tools 42s · 48 tok/s"]], "one dim run");
	// Narrowing, widest first, each form whole: rate, then the parenthesis, then tools, then nothing.
	const order: string[] = [];
	for (let width = 120; width >= 1; width--) {
		assert.deepEqual(row(data, false, width), row(timed, false, width), `collapsed @${width}: byte-identical to an entry without it`);
		// Too narrow for any form, the line is gone: headline and file only.
		const rows = row(data, true, width);
		const second = rows.length === 3 ? stripAnsi(rows[1]!).trim() : "";
		if (order.at(-1) !== second) order.push(second);
	}
	assert.deepEqual(order, [...timingSpellings(data), ""]);
	// Older entries have no such field and render as they did; a malformed one is dropped on its own.
	assert.ok(!("thinkingMs" in parseRunSummary(JSON.parse(JSON.stringify(timed)))!));
	for (const thinkingMs of [-1, 999, 92_001, "40000", null, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
		const parsed = parseRunSummary({ ...timed, thinkingMs })!;
		assert.ok(parsed && !("thinkingMs" in parsed), `${String(thinkingMs)}: read as absent`);
		for (const expanded of [false, true]) {
			assert.deepEqual(row({ ...timed, thinkingMs }, expanded, 120), row(timed, expanded, 120), `${String(thinkingMs)} expanded=${expanded}`);
		}
	}
	// Without the model time it is a part of, it is not read at all.
	const { modelMs: _modelMs, ...untimed } = timed;
	assert.ok(!("thinkingMs" in parseRunSummary({ ...untimed, thinkingMs: 40_000 })!));
	assert.ok(!("thinkingMs" in parseRunSummary({ ...timed, modelMs: "x", thinkingMs: 40_000 })!));
});
