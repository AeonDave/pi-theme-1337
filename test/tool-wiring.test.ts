import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import pi1337 from "../src/index.ts";
import { stripAnsi, visibleWidth } from "../src/width.ts";

initTheme("dark", false);

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	const resolvers: ToolRendererResolver[] = [];
	let toggle: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	let invalidations = 0;
	const tui = {
		terminal: { write() {} },
		invalidate() { invalidations++; },
		requestRender() {},
	};
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerShortcut() {},
		registerCommand(_name: string, command: { handler: typeof toggle }) { toggle = command.handler; },
		registerToolRenderer(resolver: ToolRendererResolver) { resolvers.push(resolver); },
		registerEntryRenderer() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const theme = { name: "1337", fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
	const footerData = { getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {} };
	const ui = {
		theme,
		setFooter(factory: unknown) { if (typeof factory === "function") factory(tui, theme, footerData); },
		setEditorComponent() {}, setWorkingVisible() {}, setHiddenThinkingLabel() {}, setWidget() {}, notify() {},
	};
	const ctx = {
		hasUI: true, mode: "tui", ui, cwd: "D:/work", isIdle: () => true,
		sessionManager: { getSessionName: () => undefined, getEntries: () => [] },
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	pi1337(api);
	const emit = (name: string, fields: Record<string, unknown> = {}) => handlers.get(name)?.({ type: name, ...fields }, ctx);
	/** A real host row for a settled call, announced through the same events Pi emits. */
	const settledCall = async (toolName: string, id: string, args: Record<string, unknown>, options: { isError?: boolean; parent?: string; deferResult?: boolean; baseline?: ToolRenderers } = {}) => {
		const row = new ToolExecutionComponent(toolName, id, args, { outputPad: 1 }, resolvers[0]!(toolName, () => options.baseline),
			{ requestRender() {} } as TUI, "D:/work");
		const lineage = options.parent ? { parentToolCallId: options.parent } : {};
		await emit("tool_execution_start", { toolCallId: id, toolName, args, ...lineage });
		await emit("tool_execution_end", { toolCallId: id, toolName, result: {}, isError: options.isError ?? false, ...lineage });
		// Pi updates the row only after every extension has handled the end event.
		const showResult = () => row.updateResult({ content: [{ type: "text", text: `${id} output` }], details: undefined, isError: options.isError ?? false });
		if (!options.deferResult) showResult();
		return { text: (width = 80) => stripAnsi(row.render(width).join("\n")).trim(), lines: (width: number) => row.render(width), showResult };
	};
	return { handlers, resolvers, ctx, emit, settledCall, toggle: () => toggle?.("", ctx), invalidations: () => invalidations };
}

async function isolated(body: () => Promise<void>) {
	const keys = ["PI_1337_STATE_DIR", "PI_1337_DISABLE", "PI_1337_THEME", "PI_1337_BG", "PI_1337_POLISH", "PI_1337_GROUPS"];
	const saved = keys.map(key => process.env[key]);
	const dir = mkdtempSync(join(tmpdir(), "pi1337-tools-"));
	process.env.PI_1337_STATE_DIR = dir;
	delete process.env.PI_1337_DISABLE;
	process.env.PI_1337_THEME = "off";
	process.env.PI_1337_BG = "off";
	delete process.env.PI_1337_POLISH;
	delete process.env.PI_1337_GROUPS;
	try { await body(); } finally {
		keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("tool presentation registers once, preserves custom tools, and invalidates existing rows on toggles", async () => isolated(async () => {
	const h = harness();
	try {
		assert.equal(h.resolvers.length, 1);
		const resolve = h.resolvers[0];
		const component = () => ({ render: () => ["custom"], invalidate() {} });
		const custom = { renderShell: "self" as const, renderCall: component, renderResult: component };
		assert.equal(resolve("delegate", () => custom), custom, "a renderer that frames itself is not replaced");
		const callOnly = { renderCall: component };
		const resultOnly = { renderResult: component };
		assert.equal(resolve("mcp__server__call", () => callOnly), callOnly, "nor one that leaves a slot to the host's own fallback");
		assert.equal(resolve("mcp__server__result", () => resultOnly), resultOnly);
		const framed = resolve("monitor", () => ({ renderCall: component, renderResult: component }));
		assert.equal(framed?.renderShell, "self", "a renderer with both hooks and the host's box is reframed");
		assert.ok(resolve("mcp__server__plain", () => undefined)?.renderCall, "unrendered tools get a compact fallback");
		assert.notEqual(resolve("read", () => custom), custom, "standard file tool presentation is polished");
		await h.handlers.get("session_start")?.({}, h.ctx);
		const afterStart = h.invalidations();
		assert.ok(afterStart > 0, "history rows are invalidated on activation");
		await h.toggle();
		assert.ok(h.invalidations() > afterStart, "existing rows restore their baseline before dropping TUI");
		await h.toggle();
		assert.equal(h.resolvers.length, 1, "toggles do not accumulate resolvers");
	} finally { await h.handlers.get("session_shutdown")?.({}, h.ctx); }
}));

test("repeated host resolution shares renderer state per tool within this extension instance", async () => isolated(async () => {
	const h = harness();
	const resolve = h.resolvers[0];
	const baseline = {
		renderCall: (_args: unknown, _theme: unknown, context: { state: Record<string, unknown> }) => {
			context.state.marker = true;
			return { render: () => ["baseline call"], invalidate() {} };
		},
		renderResult: (_result: unknown, _options: unknown, _theme: unknown,
			context: { state: Record<string, unknown> }) => {
			assert.equal(context.state.marker, true);
			return { render: () => ["baseline result"], invalidate() {} };
		},
	};
	const rowState = {};
	const call = resolve("read", () => baseline);
	call?.renderCall?.({}, h.ctx.ui.theme, { state: rowState, toolCallId: "id" } as never);
	const result = resolve("read", () => baseline);
	assert.notEqual(result, call, "Pi resolves a fresh adapter descriptor for each lookup");
	assert.match(result?.renderResult?.({ content: [], isError: false } as never, { isPartial: false, expanded: false } as never,
		h.ctx.ui.theme, { state: rowState, toolCallId: "id" } as never)?.render(20).join("\n") ?? "", /baseline result/);
	const otherTool = resolve("write", () => baseline);
	assert.doesNotThrow(() => otherTool?.renderResult?.({ content: [], isError: false } as never,
		{ isPartial: false, expanded: false } as never, h.ctx.ui.theme,
		{ state: {}, toolCallId: "id" } as never));
}));

test("polish opt-out leaves all host renderers alone", async () => isolated(async () => {
	process.env.PI_1337_POLISH = "off";
	const h = harness();
	const baseline = { renderShell: "default" as const };
	for (const resolve of h.resolvers) assert.equal(resolve("read", () => baseline), baseline);
	const thirdParty = monitorRenderers().renderers;
	for (const resolve of h.resolvers) assert.equal(resolve("monitor", () => thirdParty), thirdParty);
}));

/** A third-party tool as pi-persona ships them: both hooks, the host's box, state on the row. */
function monitorRenderers() {
	const seen = { calls: 0, results: 0, states: new Set<object>() };
	const renderers: ToolRenderers = {
		renderCall(args, theme, context) {
			seen.calls++; seen.states.add(context.state);
			return new Text(`${theme.fg("toolTitle", theme.bold(`monitor ${(args as { action: string }).action}`))} ${theme.fg("dim", "CI run finished")}`, 0, 0);
		},
		renderResult(result, _options, theme, context) {
			seen.results++; seen.states.add(context.state);
			return new Text(theme.fg(context.isError ? "error" : "toolOutput", result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")), 0, 0);
		},
	};
	return { renderers, seen };
}

test("a third-party row is flat while the redesign is on, the host's exact box when toggled off, and flat again", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const wrapped = monitorRenderers();
		const host = monitorRenderers();
		const row = await h.settledCall("monitor", "m1", { action: "arm" }, { baseline: wrapped.renderers });
		const native = new ToolExecutionComponent("monitor", "m1", { action: "arm" }, { outputPad: 1 }, host.renderers,
			{ requestRender() {} } as TUI, "D:/work");
		native.updateResult({ content: [{ type: "text", text: "m1 output" }], details: undefined, isError: false });
		const flat = (width: number) => row.lines(width).map(line => stripAnsi(line).trimEnd());
		for (const width of [40, 60, 100]) {
			assert.deepEqual(flat(width), ["", " ● monitor arm CI run finished", " └ m1 output"], `flat at ${width}`);
			assert.ok(row.lines(width).every((line: string) => visibleWidth(line) <= width));
		}
		const hooks = [wrapped.seen.calls, wrapped.seen.results];
		await h.toggle();
		for (const width of [40, 60, 100]) assert.deepEqual(row.lines(width), native.render(width), `the host's own box at ${width}`);
		await h.toggle();
		assert.deepEqual(flat(100), ["", " ● monitor arm CI run finished", " └ m1 output"]);
		assert.deepEqual([wrapped.seen.calls, wrapped.seen.results], hooks, "toggling runs no third-party hook by itself");
		assert.equal(wrapped.seen.states.size, 1, "and the row keeps one state object throughout");

		const failed = await h.settledCall("monitor", "m2", { action: "arm" }, { baseline: wrapped.renderers, isError: true });
		assert.deepEqual(failed.lines(100).map((line: string) => stripAnsi(line).trimEnd()), ["", " ● monitor arm CI run finished", " └ m2 output"]);
	} finally { await h.emit("session_shutdown"); }
}));

test("a third-party row never folds and still ends the exploration run above it", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const { renderers } = monitorRenderers();
		const before = [await h.settledCall("read", "s1", { path: "a.ts" }), await h.settledCall("read", "s2", { path: "b.ts" })];
		const monitors = [];
		for (const id of ["m1", "m2", "m3"]) monitors.push(await h.settledCall("monitor", id, { action: "arm" }, { baseline: renderers }));
		const after = [await h.settledCall("read", "s3", { path: "c.ts" }), await h.settledCall("read", "s4", { path: "d.ts" })];
		await h.emit("agent_settled", { aborted: false });
		for (const row of [...before, ...after]) assert.match(row.text(), /^● Read [a-d]\.ts/, "two runs of two never fold as one of four");
		for (const row of monitors) assert.match(row.text(), /^● monitor arm CI run finished *\n └ m\d output$/, "three settled third-party rows stay three rows");
	} finally { await h.emit("session_shutdown"); }
}));

test("non-TUI modes never acquire a redraw or presentation side effect", async () => isolated(async () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const h = harness();
		const ctx = { ...h.ctx, mode, hasUI: mode === "rpc" } as ExtensionContext;
		await h.handlers.get("session_start")?.({}, ctx);
		assert.equal(h.invalidations(), 0);
		await h.handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(h.invalidations(), 0);
	}
}));

const thinking = { message: { role: "assistant", content: [{ type: "thinking", thinking: "next step" }] } };

test("settled reads fold into one tally row that grows in place, until a painted message ends the run", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [
			await h.settledCall("read", "r1", { path: "src/width.ts" }),
			await h.settledCall("read", "r2", { path: "src/frame.ts" }),
		];
		for (const row of rows) assert.match(row.text(), /^● Read src\//, "two settled rows stay rows");
		await h.settledCall("bash", "r1/1", { command: "echo nested" }, { parent: "r1" });
		rows.push(await h.settledCall("grep", "g1", { pattern: "visibleWidth", path: "src" }));
		assert.deepEqual(rows.map(row => row.text()).slice(0, 2), ["", ""], "the third settled call folds the open run");
		assert.match(rows[2]!.text(), /^● Read width\.ts, frame\.ts · searched 1 pattern \(.*expand\)$/, "the last call carries the tally; nested calls are not counted");
		assert.equal(rows[2]!.text(40), "● Read 2 files, searched 1 pattern", "a row too narrow for the names counts them");
		await h.emit("message_start", { message: { role: "assistant", content: [] } });
		rows.push(await h.settledCall("read", "r3", { path: "src/width.ts" }));
		assert.equal(rows[2]!.text(), "", "an empty streaming message painted nothing: the run is still open and the tally moved on");
		assert.match(rows[3]!.text(), /^● Read width\.ts, frame\.ts · searched 1 pattern /, "re-reading a file does not list it twice");
		assert.match(rows[3]!.text(40), /^● Read 2 files, searched 1 pattern/, "or inflate the count");
		await h.emit("message_update", thinking);
		const next = await h.settledCall("read", "r4", { path: "src/editor.ts" });
		assert.match(next.text(), /^● Read src\/editor\.ts/, "a call below a painted message starts its own run");
		assert.match(rows[3]!.text(), /^● Read width\.ts, frame\.ts · searched 1 pattern /, "and the closed run keeps its tally");
		await h.emit("session_start");
		assert.match(rows[0]!.text(), /^● Read src\/width\.ts/, "a new session forgets every fold");
	} finally { await h.emit("session_shutdown"); }
}));

test("a thinking row between calls ends the run, so separated rows never fold together", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [];
		for (const id of ["r1", "r2", "r3", "r4"]) {
			rows.push(await h.settledCall("read", id, { path: `src/${id}.ts` }));
			await h.emit("message_update", thinking);
		}
		await h.emit("agent_settled", { aborted: false });
		for (const row of rows) assert.match(row.text(), /^● Read src\/r\d\.ts/, "each read sat under its own thinking row");
	} finally { await h.emit("session_shutdown"); }
}));

test("failures keep their row, foreign rows break the run, and settlement closes it", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const ok = [
			await h.settledCall("read", "r1", { path: "a.ts" }),
			await h.settledCall("read", "r2", { path: "b.ts" }),
		];
		const failed = await h.settledCall("read", "r3", { path: "missing.ts" }, { isError: true });
		ok.push(await h.settledCall("ls", "l1", { path: "src" }));
		await h.emit("agent_settled", { aborted: false });
		assert.match(failed.text(), /^● Read missing\.ts/, "a failed call is never hidden behind a tally");
		assert.deepEqual([ok[0]!.text(), ok[1]!.text()], ["", ""]);
		assert.match(ok[2]!.text(), /^● Read a\.ts, b\.ts · listed src /, "the tally names successes only");

		// A tool whose rows this package does not render was never resolved through us.
		const before = [await h.settledCall("read", "s1", { path: "a.ts" }), await h.settledCall("read", "s2", { path: "b.ts" })];
		await h.emit("tool_execution_start", { toolCallId: "x1", toolName: "foreign_reader", args: {} });
		await h.emit("tool_execution_end", { toolCallId: "x1", toolName: "foreign_reader", result: {}, isError: false });
		const after = [await h.settledCall("read", "s3", { path: "c.ts" }), await h.settledCall("read", "s4", { path: "d.ts" })];
		await h.emit("agent_settled", { aborted: false });
		for (const row of [...before, ...after]) assert.match(row.text(), /^● Read [a-d]\.ts/, "two runs of two never fold as one of four");
	} finally { await h.emit("session_shutdown"); }
}));

test("PI_1337_GROUPS=off and a toggled-off redesign both keep one row per call", async () => isolated(async () => {
	process.env.PI_1337_GROUPS = "off";
	const off = harness();
	try {
		await off.emit("session_start");
		const rows = [];
		for (const id of ["r1", "r2", "r3"]) rows.push(await off.settledCall("read", id, { path: `${id}.ts` }));
		await off.emit("agent_settled", { aborted: false });
		for (const row of rows) assert.match(row.text(), /^● Read r\d\.ts/);
	} finally { await off.emit("session_shutdown"); }

	delete process.env.PI_1337_GROUPS;
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [];
		for (const id of ["r1", "r2", "r3"]) rows.push(await h.settledCall("read", id, { path: `${id}.ts` }));
		await h.emit("agent_settled", { aborted: false });
		assert.match(rows[2]!.text(), /^● Read r1\.ts, r2\.ts, r3\.ts /);
		await h.toggle();
		for (const row of rows) assert.notEqual(row.text(), "", "toggling the redesign off restores every row");
		assert.doesNotMatch(rows[2]!.text(), /Read 3 files|r1\.ts, r2\.ts/);
	} finally { await h.emit("session_shutdown"); }
}));

test("a rebuilt chat starts unfolded: tree navigation and compaction forget every fold", async () => isolated(async () => {
	for (const rebuild of ["session_tree", "session_compact"]) {
		const h = harness();
		try {
			await h.emit("session_start");
			const rows = [];
			for (const id of ["r1", "r2", "r3"]) rows.push(await h.settledCall("read", id, { path: `${id}.ts` }));
			await h.emit("agent_settled", { aborted: false });
			assert.deepEqual([rows[0]!.text(), rows[1]!.text()], ["", ""]);
			// The host rebuilds rows by call id; a branch that ends inside the run has no tally row.
			await h.emit(rebuild, { reason: "manual" });
			for (const row of rows) assert.match(row.text(), /^● Read r\d\.ts/, `${rebuild} leaves no row hidden`);
		} finally { await h.emit("session_shutdown"); }
	}
}));

test("a compaction painted between two reads ends the run above it", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [await h.settledCall("read", "r1", { path: "a.ts" }), await h.settledCall("read", "r2", { path: "b.ts" })];
		await h.emit("session_before_compact", { reason: "threshold" });
		await h.emit("session_compact_failed", { aborted: true });
		rows.push(await h.settledCall("read", "r3", { path: "c.ts" }));
		await h.emit("agent_settled", { aborted: false });
		for (const row of rows) assert.match(row.text(), /^● Read [abc]\.ts/, "rows on either side of the compaction row never fold together");
	} finally { await h.emit("session_shutdown"); }
}));

test("the end event alone hides nothing: rows fold when the host has updated them", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [];
		for (const id of ["r1", "r2", "r3"]) rows.push(await h.settledCall("read", id, { path: `${id}.ts` }, { deferResult: true }));
		for (const row of rows) assert.match(row.text(), /^● Read r\d\.ts/, "extensions hear the end before the row has its result");
		rows[0]!.showResult();
		rows[1]!.showResult();
		for (const row of rows) assert.match(row.text(), /^● Read r\d\.ts/, "the third row still renders as running: nothing may hide");
		rows[2]!.showResult();
		assert.deepEqual([rows[0]!.text(), rows[1]!.text()], ["", ""]);
		assert.match(rows[2]!.text(), /^● Read r1\.ts, r2\.ts, r3\.ts /);
	} finally { await h.emit("session_shutdown"); }
}));

test("the tally counts one file once, however the calls spell its path", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [];
		// The harness cwd is D:/work.
		for (const [id, path] of [["r1", "a.ts"], ["r2", "./a.ts"], ["r3", "D:\\work\\a.ts"], ["r4", "src/b.ts"]] as const) {
			rows.push(await h.settledCall("read", id, { path }));
		}
		assert.match(rows[3]!.text(), /^● Read a\.ts, b\.ts \(/, "listed once, by the first spelling's name");
		assert.match(rows[3]!.text(16), /^● Read 2 files/);
	} finally { await h.emit("session_shutdown"); }
}));

test("a folded run names its files when the row has room, and counts them when it does not", async () => isolated(async () => {
	const h = harness();
	try {
		await h.emit("session_start");
		const rows = [];
		for (const [id, path] of [["r1", "src/width.ts"], ["r2", "src/frame.ts"], ["r3", "src/editor.ts"]] as const) rows.push(await h.settledCall("read", id, { path }));
		assert.match(rows[2]!.text(80), /^● Read width\.ts, frame\.ts, editor\.ts \(.*expand\)$/);
		assert.match(rows[2]!.text(30), /^● Read 3 files \(/, "the counted sentence, exactly as before, when the names do not fit");
		for (let width = 8; width <= 200; width++) {
			const lines: string[] = rows[2]!.lines(width);
			assert.equal(lines.length, 2, `the host's blank separator and one row at ${width}`);
			assert.ok(lines.every(line => visibleWidth(line) <= width), `fits ${width}`);
			const text = stripAnsi(lines[1]!).trim();
			assert.ok(/^● Read (width\.ts, frame\.ts, editor\.ts|3 files)/.test(text) || text.endsWith("…"), `a whole form or the truncated count at ${width}: ${text}`);
		}
		await h.emit("message_update", thinking);
		const ten = [];
		for (let i = 0; i < 10; i++) ten.push(await h.settledCall("read", `t${i}`, { path: `src/components/file-${i}.ts` }));
		assert.match(ten[9]!.text(80), /^● Read 10 files \(/, "ten names do not fit a row of 80: the run is counted");
		assert.match(ten[9]!.text(200), /^● Read file-0\.ts, file-1\.ts, .*file-9\.ts \(/, "and named where they do");
	} finally { await h.emit("session_shutdown"); }
}));
