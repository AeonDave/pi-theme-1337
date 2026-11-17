import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBashToolDefinition, createExtensionRuntime, ExtensionRunner, initTheme, ToolExecutionComponent,
	type Extension, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	Box, Container, Text, getCapabilities, setCapabilities, truncateToWidth, visibleWidth, type Component, type TUI,
} from "@earendil-works/pi-tui";
import { createFlatToolView, createSwitchableToolView } from "../src/tool-adapter.ts";
import { createToolRunRegistry, type GroupControl, type GroupDecision, type ToolRunRegistry } from "../src/tool-groups.ts";
import { createToolView } from "../src/tool-view.ts";
import { stripAnsi, useTerminalMetrics } from "../src/width.ts";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";

initTheme("dark", false);
const dependencies = { Box, Container, Text, toolName: "bash", expandHint: () => "expand" };
const ui = { requestRender() {} } as TUI;
// Pi's resolver erases tool argument generics; this fixture always supplies valid bash args.
const bashBaseline = () => createBashToolDefinition(process.cwd()) as ToolRenderers;
const compact: ToolRenderers = {
	renderShell: "self",
	renderCall: () => new Text("compact call", 0, 0),
	renderResult: (_result, options) => new Text(options.isPartial ? "compact partial" : "compact result", 0, 0),
};
const result = (text = "native output", isError = false) => ({
	content: [{ type: "text", text }], details: undefined, isError, durationMs: 321,
});
function row(renderers: ToolRenderers | undefined, id = "row") {
	return new ToolExecutionComponent("bash", id, { command: "echo hello" }, { outputPad: 2 }, renderers, ui, process.cwd());
}
function resolve(baseline: ToolRenderers | undefined, active: () => boolean, polished: ToolRenderers = compact, name = "bash", groups?: GroupControl) {
	let nextCalls = 0;
	const extension = { toolRenderers: [(_name: string, next: () => ToolRenderers | undefined) =>
		createSwitchableToolView(polished, next(), active, { ...dependencies, groups })] } as Extension;
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(),
		{} as ConstructorParameters<typeof ExtensionRunner>[3], {} as ConstructorParameters<typeof ExtensionRunner>[4]);
	const resolved = runner.resolveToolRenderers(name, () => { nextCalls++; return baseline; });
	assert.equal(nextCalls, 1);
	assert.equal(resolved?.renderShell, "self");
	return resolved;
}

for (const stage of ["pending", "partial", "success", "error"] as const) {
	test(`existing ${stage} row toggles compact -> exact native Box -> compact through public invalidation`, () => {
		let active = true;
		const baseline = bashBaseline();
		const switched = row(resolve(baseline, () => active));
		const native = row(baseline);
		const parent = new Container();
		parent.addChild(switched);
		if (stage !== "pending") {
			const value = result(Array.from({ length: 14 }, (_, n) => `native line ${n}`).join("\n"), stage === "error");
			switched.updateResult(value, stage === "partial");
			native.updateResult(value, stage === "partial");
		}
		for (const expanded of [false, true]) {
			switched.setExpanded(expanded);
			native.setExpanded(expanded);
			active = true;
			assert.match(switched.render(70).join("\n"), /compact call/);
			active = false;
			parent.invalidate(); // TUI inherits this public recursive invalidation.
			for (const width of [8, 19, 70, 140]) {
				const lines = switched.render(width);
				assert.deepEqual(lines, native.render(width), `native equality at width ${width}, expanded=${expanded}`);
				assert.ok(lines.every(line => visibleWidth(line) <= width));
			}
			active = true;
			parent.invalidate();
			const lines = switched.render(70);
			assert.match(lines.join("\n"), /compact call/);
			assert.ok(!lines.join("\n").includes("native line"));
			assert.equal(lines.length, stage === "pending" ? 2 : 3);
		}
	});
}

test("real HTML exporter renders split result slot after call, including details-only baseline results", () => {
	for (const active of [true, false]) {
		const label = active ? "polished-rich-result" : "baseline-rich-result";
		const makeFindRenderer = (callText: string): ToolRenderers => ({
			renderCall: (_args, _theme, context) => {
				context.state.callMarker = context.toolCallId;
				return new Text(callText, 0, 0);
			},
			renderResult: (result, _options, _theme, context) => {
				assert.equal(context.state.callMarker, context.toolCallId, "result lookup shares its call state");
				return new Text(String((result.details as { label: string }).label), 0, 0);
			},
		});
		const polished = makeFindRenderer("find call");
		const baseline = makeFindRenderer("native find call");
		let nextCalls = 0;
		const stateKey = Symbol("find-extension-state");
		const extension = { toolRenderers: [(_name: string, next: () => ToolRenderers | undefined) =>
			createSwitchableToolView(polished, next(), () => active, { ...dependencies, toolName: "find" }, stateKey)] } as Extension;
		const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(),
			{} as ConstructorParameters<typeof ExtensionRunner>[3], {} as ConstructorParameters<typeof ExtensionRunner>[4]);
		const html = createToolHtmlRenderer({
			getToolRenderers: name => name === "find" ? runner.resolveToolRenderers(name, () => { nextCalls++; return baseline; }) : undefined,
			theme: ({ fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text,
				bold: (text: string) => text } as Parameters<typeof createToolHtmlRenderer>[0]["theme"]),
			cwd: process.cwd(),
		});
		const call = html.renderCall(`find-${active}`, "find", { pattern: "needle" });
		const rendered = html.renderResult(`find-${active}`, "find", [], { label }, false);
		assert.equal(nextCalls, 2, "the exporter resolves independently for call and result");
		assert.ok(call?.includes("find call") || call?.includes("native find call"));
		const resultHtml = rendered?.expanded ?? "";
		assert.ok(resultHtml.includes(label), `exported rich result for active=${active}: ${resultHtml}`);
		assert.equal(resultHtml.split(label).length - 1, 1);
	}
});

test("baseline self shell is not padded or recolored; live active flag works without descriptor replacement", () => {
	let active = true;
	const baseline = { ...compact, renderCall: () => new Text("original self", 0, 0) };
	const switched = row(resolve(baseline, () => active));
	const native = row(baseline);
	switched.updateResult(result()); native.updateResult(result());
	active = false;
	assert.deepEqual(switched.render(35), native.render(35));
	active = true;
	assert.match(switched.render(35).join("\n"), /compact call/);
});

test("state and lastComponent remain isolated per lane, row and call/result slot; hidden final hooks still run", () => {
	let active = true;
	const states = new Map<string, object>();
	const previous = new Map<string, object>();
	const observations: string[] = [];
	function fixture(lane: string): ToolRenderers {
		const observe = (slot: string, context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]) => {
			const key = `${lane}/${context.toolCallId}`;
			if (states.has(key)) assert.equal(context.state, states.get(key));
			else { assert.ok(![...states.values()].includes(context.state)); states.set(key, context.state); }
			assert.equal(context.lastComponent, previous.get(`${key}/${slot}`));
			if (slot === "result") assert.equal(context.state.callSeen, true);
			else context.state.callSeen = true;
			const component = context.lastComponent ?? new Text(`${key}/${slot}`, 0, 0);
			previous.set(`${key}/${slot}`, component);
			observations.push(`${key}/${slot}/${context.isPartial}/${context.expanded}/${context.isError}`);
			return component;
		};
		return { renderCall: (_args, _theme, ctx) => observe("call", ctx),
			renderResult: (_result, _options, _theme, ctx) => observe("result", ctx) };
	}
	const renderers = createSwitchableToolView(fixture("polished"), fixture("baseline"), () => active, dependencies);
	const rows = [row(renderers, "one"), row(renderers, "two")];
	for (const component of rows) {
		component.markExecutionStarted(); component.setArgsComplete();
		component.updateResult(result(), true); component.render(50);
		active = false; component.invalidate(); component.setExpanded(true); component.render(50);
		active = true; component.updateResult(result("error", true));
		assert.match(component.render(50).join("\n"), /polished\/\w+\/result/);
		active = false;
		assert.match(component.render(50).join("\n"), /baseline\/\w+\/result/);
	}
	assert.equal(states.size, 4);
	assert.ok(observations.includes("baseline/one/result/false/true/true"), "hidden baseline receives final result to clean its native resources");
	assert.ok(observations.includes("polished/two/result/false/true/true"));
});

test("host alone renders image payload exactly once in both lanes, respecting showImages", () => {
	const caps = getCapabilities();
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	try {
		let active = true;
		const baseline = bashBaseline();
		const switched = row(resolve(baseline, () => active));
		const native = row(baseline);
		const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
		const value = { ...result(), content: [...result().content, image] };
		switched.updateResult(value); native.updateResult(value);
		for (active of [true, false, true]) {
			switched.invalidate();
			const rendered = switched.render(70).join("\n");
			assert.equal(rendered.split("1337;File=").length - 1, 1);
			if (!active) assert.deepEqual(switched.render(70), native.render(70));
		}
		switched.setShowImages(false);
		assert.ok(!switched.render(70).join("\n").includes("1337;File="));
	} finally { setCapabilities(caps); }
});

test("generic fallback stays lazy in the hidden lane, then uses latest preview and full expanded result", () => {
	let active = true;
	let reads = 0;
	let textReads = 0;
	let polishedCalls = 0;
	const polished: ToolRenderers = {
		renderCall: () => new Text("polished call", 0, 0),
		renderResult: () => { polishedCalls++; return new Text("polished result", 0, 0); },
	};
	const switched = row(resolve(undefined, () => active, polished));
	const makeResult = (prefix: string, count: number) => ({
		get content() { reads++; return [{ type: "text" as const, get text() { textReads++; return Array.from({ length: count }, (_, n) => `${prefix} ${n}`).join("\n"); } }]; },
		details: undefined, isError: false, durationMs: 1,
	});
	switched.updateResult(makeResult("old", 3), true);
	switched.updateResult(makeResult("latest", 1000), true);
	reads = 0; textReads = 0;
	assert.match(switched.render(120).join("\n"), /polished result/);
	assert.equal(polishedCalls, 2, "genuine polished hook still receives updates");
	assert.equal(reads, 0, "hidden generic fallback must not even read content");
	assert.equal(textReads, 0, "hidden generic fallback must not inspect or sanitize output text");

	active = false;
	switched.invalidate();
	const collapsed = stripAnsi(switched.render(120).join("\n"));
	assert.match(collapsed, /latest 0/);
	assert.match(collapsed, /latest 9/);
	assert.doesNotMatch(collapsed, /latest 10/);
	assert.match(collapsed, /990 more lines/);
	assert.doesNotMatch(collapsed, /old [0-9]/);
	assert.ok(reads > 0, "selected generic fallback reads current result content");

	switched.setExpanded(true);
	const expanded = stripAnsi(switched.render(120).join("\n"));
	assert.match(expanded, /latest 999/);
	assert.doesNotMatch(expanded, /more lines/);
});

test("selected generic fallback is memoized across unchanged redraws", () => {
	let active = false;
	let contentReads = 0;
	let textReads = 0;
	let textConstructions = 0;
	class CountingText extends Text {
		constructor(...args: ConstructorParameters<typeof Text>) {
			super(...args);
			textConstructions++;
		}
	}
	const renderers = createSwitchableToolView({}, undefined, () => active,
		{ ...dependencies, Text: CountingText });
	const switched = row(renderers);
	const value = {
		get content() {
			contentReads++;
			return [{ type: "text" as const, get text() { textReads++; return "stable output"; } }];
		},
		details: undefined, isError: false, durationMs: 1,
	};
	switched.updateResult(value);
	const first = stripAnsi(switched.render(70).join("\n"));
	assert.match(first, /stable output/);
	const afterFirst = { contentReads, textReads, textConstructions };
	const second = stripAnsi(switched.render(70).join("\n"));
	assert.equal(second, first);
	assert.deepEqual({ contentReads, textReads, textConstructions }, afterFirst,
		"a redraw of the same selected fallback must reuse its Text component");

	switched.setExpanded(true);
	assert.match(stripAnsi(switched.render(70).join("\n")), /stable output/);
	assert.equal(textReads, afterFirst.textReads + 1, "expanded presentation rebuilds from the current result");
	switched.setExpanded(false);
	switched.render(70);
	assert.equal(textReads, afterFirst.textReads + 2, "collapsing rebuilds the bounded preview");
	switched.invalidate();
	switched.render(70);
	assert.equal(textReads, afterFirst.textReads + 3, "explicit invalidation rebuilds owned fallback content");

	switched.updateResult(result("new partial output"), true);
	assert.match(stripAnsi(switched.render(70).join("\n")), /new partial output/);
});

test("collapsed fallback scans omitted lines without slicing them", () => {
	let slices = 0;
	const source = Array.from({ length: 1000 }, (_, index) => `line ${index}`).join("\n");
	const trackedText = {
		indexOf: source.indexOf.bind(source),
		slice(start: number, end?: number) { slices++; return source.slice(start, end); },
	} as unknown as string;
	const switched = row(createSwitchableToolView({}, undefined, () => false, dependencies));
	switched.updateResult({ ...result(), content: [{ type: "text", text: trackedText }] });
	const collapsed = stripAnsi(switched.render(120).join("\n"));
	assert.match(collapsed, /line 9/);
	assert.doesNotMatch(collapsed, /line 10/);
	assert.match(collapsed, /990 more lines/);
	assert.equal(slices, 10, "only the ten visible preview lines should be sliced and sanitized");

	switched.setExpanded(true);
	const expanded = stripAnsi(switched.render(120).join("\n"));
	assert.match(expanded, /line 999/);
	assert.equal(slices, 1010, "expanded output slices all lines");
});

test("missing or throwing hooks have safe generic fallback; data is unchanged and images are not serialized", () => {
	for (const baseline of [undefined, {}, { renderCall() { throw Error("call"); }, renderResult() { throw Error("result"); } }]) {
		const switched = row(resolve(baseline, () => false));
		const value = { ...result("first\nsecond\u001b[2J\n" + "界".repeat(30)), content: [
			...result("first\nsecond\u001b[2J\n" + "界".repeat(30)).content,
			{ type: "image", data: "SECRET_BASE64", mimeType: "image/png" },
		] };
		const before = structuredClone(value);
		switched.setShowImages(false); switched.updateResult(value);
		const text = switched.render(20).join("\n");
		assert.match(stripAnsi(text), /echo hello/);
		assert.match(stripAnsi(text), /first/);
		assert.ok(!text.includes("\u001b[2J"));
		assert.ok(!text.includes("SECRET_BASE64"));
		assert.match(stripAnsi(text), /\[image:\s+image\/png\]/);
		assert.deepEqual(value, before);
		assert.ok(switched.render(20).every(line => visibleWidth(line) <= 20));
	}
});

test("tiny widths and excessive outputPad never wrap a text row", () => {
	let active = false;
	const switched = row(resolve(bashBaseline(), () => active));
	switched.updateArgs({ command: "echo 界😀" });
	switched.updateResult(result("界😀 output"));
	for (active of [false, true]) for (const pad of [0, 1, 2, 20]) {
		switched.setOutputPad(pad);
		for (const width of [1, 2, 3, 4, 5, 8]) {
			assert.ok(switched.render(width).every(line => visibleWidth(line) <= width), `width=${width}, pad=${pad}`);
		}
	}
});

test("generic image placeholder appears without capabilities, and disappears only when host can render it", () => {
	const caps = getCapabilities();
	try {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const switched = row(createSwitchableToolView(compact, undefined, () => false,
			{ ...dependencies, imagesSupported: () => getCapabilities().images !== null }));
		switched.updateResult({ ...result(), content: [{ type: "image", mimeType: "image/png", data: "" }] });
		assert.match(stripAnsi(switched.render(50).join("\n")), /\[image: image\/png\]/);
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		assert.ok(!stripAnsi(switched.render(50).join("\n")).includes("[image:"),
			"a live capability change invalidates the owned fallback presentation");
		switched.setShowImages(false);
		assert.match(stripAnsi(switched.render(50).join("\n")), /\[image: image\/png\]/);
	} finally { setCapabilities(caps); }
});

function readRow(renderers: ToolRenderers | undefined, id: string, args: Record<string, unknown> = { path: `${id}.ts` }) {
	return new ToolExecutionComponent("read", id, args, { outputPad: 2 }, renderers, ui, process.cwd());
}
const leftClick = {
	type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 70, height: 2, shift: false, alt: false, ctrl: false,
} as const;
/** Counts every registry query so a test can prove a lane never consulted it. */
function countingGroups(runs: ToolRunRegistry) {
	const counts = { decisions: 0, expands: 0 };
	const groups: GroupControl = {
		decisionFor(id) { counts.decisions++; return runs.decisionFor(id); },
		expand(id) { counts.expands++; runs.expand(id); },
		markImages(id) { runs.markImages(id); },
		settle(id, failed) { runs.settle(id, failed); },
	};
	return { groups, counts };
}
/** Three settled reads in one run; returns their rows. */
function foldedRun(renderers: ToolRenderers | undefined, runs: ToolRunRegistry, ids = ["g1", "g2", "g3"]) {
	const rows = ids.map(id => readRow(renderers, id));
	for (const [index, id] of ids.entries()) {
		runs.onToolStart(id, "read");
		rows[index]!.updateResult(result(Array.from({ length: 14 }, (_, n) => `native line ${n}`).join("\n")));
		runs.settle(id, false);
	}
	return rows;
}

test("two settled rows stay rows; the third folds the open run to [], [] and one summary row", () => {
	const runs = createToolRunRegistry();
	const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const pair = foldedRun(renderers, runs, ["e1", "e2"]);
	for (const component of pair) assert.match(component.render(70).join("\n"), /compact call/, "a run of two reads fine as rows");
	const pending = readRow(renderers, "e3");
	runs.onToolStart("e3", "read");
	assert.match(pending.render(70).join("\n"), /compact call/, "a call without a result keeps its row");
	runs.closeAll();

	const rows = foldedRun(renderers, runs);
	const folded = rows.map(component => component.render(70));
	assert.deepEqual(folded[0], []);
	assert.deepEqual(folded[1], []);
	assert.equal(folded[2]!.length, 2, "the host frames the summary with its usual blank separator");
	assert.equal(stripAnsi(folded[2]![1]!), "  ● Read 3 files (expand)", "the summary takes the rows' outputPad indent");
	for (const width of [4, 12, 30, 70]) {
		const lines = rows[2]!.render(width);
		assert.equal(lines.length, 2, `one summary line at ${width}`);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `fits ${width}`);
	}
});

test("a click on the summary is handled and brings the run's rows back for good", () => {
	const runs = createToolRunRegistry();
	const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const rows = foldedRun(renderers, runs);
	runs.closeAll();
	const tail = rows[2]!;
	tail.render(70);
	assert.equal(tail.handleMouse(leftClick)?.handled, true, "the summary consumes the click instead of the row-expansion fallback");
	for (const component of rows) {
		const text = component.render(70).join("\n");
		assert.match(text, /compact call/);
		assert.match(text, /compact result/, "the restored row is collapsed, not host-expanded by the click");
	}
});

test("Ctrl+O renders every folded row normally, and collapsing folds them again", () => {
	const runs = createToolRunRegistry();
	const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const rows = foldedRun(renderers, runs);
	runs.closeAll();
	for (const component of rows) component.setExpanded(true);
	for (const component of rows) assert.match(component.render(70).join("\n"), /compact call/);
	for (const component of rows) component.setExpanded(false);
	assert.deepEqual(rows[0]!.render(70), []);
	assert.match(stripAnsi(rows[2]!.render(70).join("\n")), /Read 3 files/);
});

test("an inactive lane never folds or consults the registry, and a click still reaches the host", () => {
	let active = false;
	const runs = createToolRunRegistry();
	const { groups, counts } = countingGroups(runs);
	const rows = foldedRun(resolve(undefined, () => active, compact, "read", groups), runs);
	runs.closeAll();
	for (const component of rows) {
		const text = stripAnsi(component.render(70).join("\n"));
		assert.match(text, /native line 0/, "the baseline lane renders its own rows");
		assert.doesNotMatch(text, /native line 13/);
	}
	const tail = rows[2]!;
	assert.equal(tail.handleMouse(leftClick)?.handled, true, "the host's own click-to-expand handles it");
	assert.match(stripAnsi(tail.render(70).join("\n")), /native line 13/, "the click expanded the row instead of the run");
	assert.deepEqual(counts, { decisions: 0, expands: 0 });
	active = true;
	assert.deepEqual(rows[0]!.render(70), [], "the same registry folds as soon as the lane is active");
	assert.ok(counts.decisions > 0);
});

test("a failed call stays visible next to the summary of the rest", () => {
	const runs = createToolRunRegistry();
	const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const ids = ["f1", "f2", "f3", "f4"];
	const rows = ids.map(id => readRow(renderers, id));
	for (const [index, id] of ids.entries()) {
		runs.onToolStart(id, "read");
		rows[index]!.updateResult(result(`output ${index}`, id === "f2"));
		runs.settle(id, id === "f2");
	}
	runs.closeAll();
	const folded = rows.map(component => stripAnsi(component.render(70).join("\n")));
	assert.equal(folded[0], "");
	assert.match(folded[1]!, /compact call[\s\S]*compact result/, "the failure renders in place");
	assert.equal(folded[2], "");
	assert.match(folded[3]!, /● Read 3 files/);
});

test("an image-bearing row renders in place with its image while the rest of the run folds", () => {
	const caps = getCapabilities();
	try {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const runs = createToolRunRegistry();
		const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
		const ids = ["i1", "i2", "i3", "i4"];
		const rows = ids.map(id => readRow(renderers, id));
		const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
		for (const [index, id] of ids.entries()) {
			runs.onToolStart(id, "read");
			rows[index]!.updateResult(id === "i4" ? { ...result(), content: [...result().content, image] } : result());
			runs.settle(id, false);
		}
		runs.closeAll();
		const imageRow = rows[3]!.render(70).join("\n");
		assert.match(stripAnsi(imageRow), /compact call/);
		assert.equal(imageRow.split("1337;File=").length - 1, 1, "the host still paints the image once");
		assert.deepEqual(rows[0]!.render(70), []);
		assert.match(stripAnsi(rows[2]!.render(70).join("\n")), /● Read 3 files/, "the summary moves to the last foldable call");
	} finally { setCapabilities(caps); }
});

test("HTML export of a folded run keeps every call header and renders every result", () => {
	const runs = createToolRunRegistry();
	const ids = ["x1", "x2", "x3"];
	for (const id of ids) { runs.onToolStart(id, "find"); runs.settle(id, false); }
	runs.closeAll();
	assert.equal(runs.decisionFor("x3").kind, "summary", "the TUI would fold this run");
	const extension = { toolRenderers: [(_name: string, next: () => ToolRenderers | undefined) =>
		createSwitchableToolView(createToolView("find", () => "expand"), next(), () => true,
			{ ...dependencies, toolName: "find", groups: runs })] } as Extension;
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(),
		{} as ConstructorParameters<typeof ExtensionRunner>[3], {} as ConstructorParameters<typeof ExtensionRunner>[4]);
	const html = createToolHtmlRenderer({
		getToolRenderers: name => runner.resolveToolRenderers(name, () => undefined),
		theme: ({ fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text,
			bold: (text: string) => text } as Parameters<typeof createToolHtmlRenderer>[0]["theme"]),
		cwd: process.cwd(),
	});
	for (const [index, id] of ids.entries()) {
		const call = html.renderCall(id, "find", { pattern: `needle-${index}`, path: `dir-${index}` }) ?? "";
		assert.ok(call.includes(`needle-${index}`) && call.includes(`dir-${index}`), `call header ${id}: ${call}`);
		const rendered = html.renderResult(id, "find", [{ type: "text", text: `hit-${index}` }], undefined, false);
		assert.ok(rendered?.expanded?.includes(`hit-${index}`), `result ${id}: ${rendered?.expanded}`);
	}
});

test("a row the user opens unfolds its whole run, so no sibling is stranded behind a missing tally", () => {
	// The host toggles `expanded` on the clicked row alone. If that row later became the
	// tally carrier it would render expanded (never the tally) while its siblings
	// rendered nothing — so a click on any member unfolds the run for good.
	const runs = createToolRunRegistry();
	const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const rows = foldedRun(renderers, runs, ["o1", "o2"]);
	const opened = rows[1]!;
	opened.render(70);
	assert.equal(opened.handleMouse(leftClick)?.handled, true, "the host's own click-to-expand still handles the click");
	rows.push(...foldedRun(renderers, runs, ["o3", "o4"]));
	runs.closeAll();
	for (const component of rows) assert.match(component.render(70).join("\n"), /compact call/, "every row of the run stays visible");
	assert.doesNotMatch(stripAnsi(rows.map(component => component.render(70).join("\n")).join("\n")), /Read \d files/);

	// A sibling opened after the fold: clicking is impossible on a hidden row, and a
	// click on a member of an already-expanded run keeps it unfolded.
	const later = createToolRunRegistry();
	const laterRows = foldedRun(createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: later }), later, ["h1", "h2", "h3"]);
	later.closeAll();
	assert.deepEqual(laterRows[0]!.render(70), []);
	laterRows[2]!.render(70);
	laterRows[2]!.handleMouse(leftClick);
	laterRows[0]!.render(70);
	laterRows[0]!.handleMouse(leftClick);
	for (const component of laterRows) assert.notDeepEqual(component.render(70), [], "an expanded run never folds again");
});

test("a row settles its own call: nothing folds until the carrier row shows its result", () => {
	// Pi tells extensions a tool ended before it updates the row. A registry settled
	// by that event hid a run's rows while the would-be carrier still rendered as running.
	const runs = createToolRunRegistry();
	const renderers = createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const ids = ["s1", "s2", "s3"];
	const rows = ids.map(id => readRow(renderers, id));
	for (const id of ids) runs.onToolStart(id, "read");
	rows[0]!.updateResult(result());
	rows[1]!.updateResult(result());
	rows[2]!.updateResult(result("still streaming"), true);
	for (const component of rows) assert.notDeepEqual(component.render(70), [], "two settled rows and a partial one: no row may hide");
	rows[2]!.updateResult(result());
	assert.deepEqual([rows[0]!.render(70), rows[1]!.render(70)], [[], []]);
	assert.match(stripAnsi(rows[2]!.render(70).join("\n")), /● Read 3 files/, "the row's own final result is what folds the run");

	const failing = createToolRunRegistry();
	const failRows = ["f1", "f2", "f3", "f4"].map(id => readRow(createSwitchableToolView(compact, undefined, () => true,
		{ ...dependencies, toolName: "read", groups: failing }), id));
	for (const id of ["f1", "f2", "f3", "f4"]) failing.onToolStart(id, "read");
	failRows.forEach((component, index) => component.updateResult(result("out", index === 1)));
	assert.match(failRows[1]!.render(70).join("\n"), /compact call/, "a row whose result is an error keeps its row");
	assert.match(stripAnsi(failRows[3]!.render(70).join("\n")), /● Read 3 files/, "and is not counted");
});

test("a click that reaches a row hidden since the last frame is still a click on the tally", () => {
	// The host routes clicks through the last frame's layout: after the carrier moved on,
	// the old carrier renders nothing but can still receive the click meant for the tally.
	const runs = createToolRunRegistry();
	const telling: ToolRenderers = {
		renderShell: "self",
		renderCall: () => new Text("call", 0, 0),
		renderResult: (_result, options) => new Text(options.expanded ? "EXPANDED" : "collapsed", 0, 0),
	};
	const renderers = createSwitchableToolView(telling, undefined, () => true, { ...dependencies, toolName: "read", groups: runs });
	const rows = foldedRun(renderers, runs);
	const oldCarrier = rows[2]!;
	oldCarrier.render(70); // the frame the user is looking at: the tally is on this row
	rows.push(...foldedRun(renderers, runs, ["g4"]));
	assert.equal(oldCarrier.handleMouse(leftClick)?.handled, true);
	for (const component of rows) {
		const text = component.render(70).join("\n");
		assert.match(text, /collapsed/, "the run unfolds");
		assert.doesNotMatch(text, /EXPANDED/, "and the host did not expand the clicked row on its own");
	}
});

// A row keeps its shell and its last clip across frames. These pin that it is
// never stale (one test per kind of change) and that a repeat frame is cheap.

type Theme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];
type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type MouseEvent = Parameters<NonNullable<Component["handleMouse"]>>[0];
/** Renderers that always hand back the same components, so only the row itself can change what is painted. */
function fixed(call: Component, output?: Component, renderShell?: "self"): ToolRenderers {
	return { ...(renderShell ? { renderShell } : {}), renderCall: () => call, ...(output ? { renderResult: () => output } : {}) };
}
/** A child whose lines change with no signal to anyone. */
function silent(initial: string) {
	const child = { lines: [initial], render: () => child.lines, invalidate() {} };
	return child;
}
/** Routes every measurement the adapter makes through counters; pi-tui's own components measure on their own. */
function countingMetrics() {
	const counts = { calls: 0 };
	useTerminalMetrics({
		visibleWidth: text => { counts.calls++; return visibleWidth(text); },
		truncateToWidth: (text, max, ellipsis) => { counts.calls++; return truncateToWidth(text, max, ellipsis); },
	});
	return counts;
}
const frames = (component: Component, width = 70, count = 3) => { for (let i = 0; i < count; i++) component.render(width); };
const output14 = (isError = false) => result(Array.from({ length: 14 }, (_, n) => `native line ${n} ${"界".repeat(n)}`).join("\n"), isError);

test("a row rendered frame after frame paints exactly what a freshly built identical row paints", () => {
	const staged = (stage: "pending" | "partial" | "success" | "error", expanded: boolean, active: boolean) => {
		const component = row(createSwitchableToolView(createToolView("bash", () => "expand"), bashBaseline(), () => active, dependencies));
		if (stage !== "pending") component.updateResult(output14(stage === "error"), stage === "partial");
		component.setExpanded(expanded);
		return component;
	};
	try {
		for (const metrics of [undefined, { visibleWidth, truncateToWidth }]) {
			useTerminalMetrics(metrics);
			for (const stage of ["pending", "partial", "success", "error"] as const) for (const expanded of [false, true]) for (const active of [true, false]) {
				const repeated = staged(stage, expanded, active);
				for (const width of [8, 19, 70, 140]) {
					const fresh = staged(stage, expanded, active).render(width);
					for (let frame = 0; frame < 3; frame++) {
						assert.deepEqual(repeated.render(width), fresh,
							`${stage} expanded=${expanded} active=${active} width=${width} frame=${frame} metrics=${metrics ? "pi-tui" : "mirror"}`);
					}
				}
			}
		}
	} finally { useTerminalMetrics(); }
});

test("freshness (a): new arguments, results and expansion show on the very next frame in both lanes", () => {
	const reflect: ToolRenderers = {
		renderShell: "self",
		renderCall: args => new Text(`call ${(args as { command: string }).command}`, 0, 0),
		renderResult: (value, options) => new Text(`${(value.content[0] as { text: string }).text.split("\n")[0]} ${options.expanded ? "expanded" : "collapsed"}`, 0, 0),
	};
	for (const active of [true, false]) {
		const baseline = bashBaseline();
		const switched = row(createSwitchableToolView(reflect, baseline, () => active, dependencies));
		const native = row(baseline);
		const steps: [RegExp, (component: ToolExecutionComponent) => void][] = [
			[/first output collapsed/, component => component.updateResult(result("first output"), true)],
			[/call echo changed/, component => component.updateArgs({ command: "echo changed" })],
			[/second output collapsed/, component => component.updateResult(result("second output"), true)],
			[/native line 0 +collapsed/, component => component.updateResult(output14())],
			[/native line 0 +expanded/, component => component.setExpanded(true)],
		];
		for (const [expected, change] of steps) {
			frames(switched);
			change(switched); change(native);
			const lines = switched.render(70);
			if (active) assert.match(stripAnsi(lines.join("\n")), expected);
			else assert.deepEqual(lines, native.render(70), `baseline after ${expected}`);
		}
	}
});

test("freshness (b): invalidation repaints components that cache their lines until invalidated", () => {
	for (const renderShell of ["self", undefined] as const) {
		let tone = "dark";
		const cached = () => {
			let lines: string[] | undefined;
			return { render: () => lines ??= [`tone ${tone}`], invalidate() { lines = undefined; } };
		};
		const switched = row(createSwitchableToolView(fixed(cached(), cached(), renderShell), undefined, () => true, dependencies));
		switched.updateResult(result());
		frames(switched);
		tone = "light";
		switched.invalidate();
		const text = stripAnsi(switched.render(70).join("\n"));
		assert.equal(text.match(/tone light/g)?.length, 2, `shell=${renderShell ?? "native"}`);
		assert.doesNotMatch(text, /tone dark/);
	}
});

test("freshness (c): a lane switch with no other signal shows the other lane on the next frame", () => {
	let active = true;
	const baseline = bashBaseline();
	const switched = row(createSwitchableToolView(compact, baseline, () => active, dependencies));
	const native = row(baseline);
	switched.updateResult(output14()); native.updateResult(output14());
	for (const next of [false, true, false]) {
		frames(switched);
		active = next;
		const lines = switched.render(70);
		if (active) assert.match(lines.join("\n"), /compact call/);
		else assert.deepEqual(lines, native.render(70));
	}
});

test("freshness (d): state and padding changes repaint the native shell even when its components stay the same", () => {
	const call = new Text("same call", 0, 0);
	const output = new Text("same output", 0, 0);
	const make = () => row(createSwitchableToolView(compact, fixed(call, output), () => false, dependencies));
	const steps: [string, (component: ToolExecutionComponent) => void][] = [
		["partial", component => component.updateResult(result(), true)],
		["final", component => component.updateResult(result())],
		["error", component => component.updateResult(result("native output", true))],
		["pad 0", component => component.setOutputPad(0)],
		["pad 5", component => component.setOutputPad(5)],
	];
	const switched = make();
	const applied: typeof steps[number][1][] = [];
	let previous = switched.render(70);
	for (const [label, change] of steps) {
		frames(switched);
		change(switched); applied.push(change);
		const fresh = make();
		for (const step of applied) step(fresh);
		const lines = switched.render(70);
		assert.deepEqual(lines, fresh.render(70), label);
		assert.notDeepEqual(lines, previous, `${label} changes the painted row`);
		previous = lines;
	}
});

/** The adapter driven directly, as the host would: one row, an explicit theme object and context. */
function directRow(baseline: ToolRenderers, theme: Theme) {
	const renderers = createSwitchableToolView(compact, baseline, () => false, dependencies);
	const context = {
		args: {}, toolCallId: "direct", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
		executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false,
		isError: false, outputPad: 1,
	} as unknown as Context;
	const component = renderers.renderCall!({}, theme, context);
	return { renderers, context, component };
}
const taggedTheme = (tag: string, paints = { count: 0 }) => ({
	fg: (_token: string, text: string) => text,
	bg: (token: string, text: string) => { paints.count++; return `<${tag}:${token}>${text}`; },
	bold: (text: string) => text,
}) as unknown as Theme;

test("freshness (d): a new theme object repaints the native shell on the next frame", () => {
	const { renderers, context, component } = directRow(fixed(new Text("same call", 0, 0)), taggedTheme("A"));
	frames(component, 30);
	assert.match(component.render(30).join("\n"), /<A:toolSuccessBg>/);
	renderers.renderCall!({}, taggedTheme("B"), context);
	const text = component.render(30).join("\n");
	assert.match(text, /<B:toolSuccessBg>/);
	assert.doesNotMatch(text, /<A:/);
});

test("freshness (e): a width change re-clips lines that are otherwise unchanged", () => {
	const wide = { render: () => ["w".repeat(100)], invalidate() {} };
	for (const renderShell of ["self", undefined] as const) {
		const switched = row(createSwitchableToolView(fixed(wide, undefined, renderShell), undefined, () => true, dependencies));
		frames(switched, 70);
		const narrow = switched.render(20);
		assert.ok(narrow.every(line => visibleWidth(line) <= 20), `shell=${renderShell ?? "native"} at 20`);
		assert.ok(narrow.some(line => stripAnsi(line).includes("w".repeat(10))));
		frames(switched, 20);
		assert.ok(switched.render(70).some(line => visibleWidth(line) === 70), `shell=${renderShell ?? "native"} back at 70`);
	}
});

test("freshness (f): every change of the fold decision shows on the next frame", () => {
	let decision: GroupDecision = { kind: "normal" };
	const groups: GroupControl = { decisionFor: () => decision, expand() {}, markImages() {}, settle() {} };
	const switched = readRow(createSwitchableToolView(compact, undefined, () => true, { ...dependencies, toolName: "read", groups }), "fold");
	switched.updateResult(result());
	const normalLines = switched.render(70);
	assert.match(normalLines.join("\n"), /compact call[\s\S]*compact result/);
	const steps: [GroupDecision, RegExp][] = [
		[{ kind: "summary", sentence: "Read 3 files", detailed: "Read 3 files" }, /Read 3 files/],
		[{ kind: "summary", sentence: "Read 4 files", detailed: "Read 4 files" }, /Read 4 files/],
		[{ kind: "summary", sentence: "Read 4 files", detailed: "Read a.ts, b.ts, c.ts, d.ts" }, /Read a\.ts, b\.ts, c\.ts, d\.ts \(/],
		[{ kind: "summary", sentence: "Read 4 files", detailed: "Read a.ts, b.ts, c.ts, e.ts" }, /Read a\.ts, b\.ts, c\.ts, e\.ts \(/],
		[{ kind: "hidden" }, /^$/],
		[{ kind: "normal" }, /compact call[\s\S]*compact result/],
	];
	for (const [next, expected] of steps) {
		frames(switched);
		decision = next;
		assert.match(stripAnsi(switched.render(70).join("\n")), expected, next.kind);
	}
	assert.deepEqual(switched.render(70), normalLines);
});

test("freshness (g): a child that changes its own lines without telling anyone is repainted next frame", () => {
	for (const active of [true, false]) {
		const call = silent("call v1");
		const output = silent("output v1");
		// Self shell when active, native Box when not: both see the same silent children.
		const switched = row(createSwitchableToolView(fixed(call, output, "self"), fixed(call, output), () => active, dependencies));
		switched.updateResult(result());
		const next = () => stripAnsi(switched.render(70).join("\n"));
		frames(switched);
		call.lines = ["call v2"];
		assert.match(next(), /call v2/, `new array, active=${active}`);
		frames(switched);
		output.lines[0] = "output v2"; // the same array, mutated in place
		assert.match(next(), /output v2/, `in-place mutation, active=${active}`);
		frames(switched);
		output.lines.push("output extra");
		assert.match(next(), /output v2[\s\S]*output extra/, `grown in place, active=${active}`);
	}
});

test("repeat frames of an unchanged row never re-clip in either lane; invalidation and width changes do", () => {
	try {
		const counts = countingMetrics();
		for (const active of [true, false]) {
			const switched = row(createSwitchableToolView(compact, bashBaseline(), () => active, dependencies));
			switched.updateResult(output14());
			counts.calls = 0;
			switched.render(100);
			assert.ok(counts.calls > 0, "the first frame clips through the installed metrics");
			counts.calls = 0;
			frames(switched, 100, 3);
			assert.equal(counts.calls, 0, `repeat frames, active=${active}`);
			switched.invalidate();
			counts.calls = 0;
			switched.render(100);
			assert.ok(counts.calls > 0, "invalidation drops the last clip");
			counts.calls = 0;
			switched.render(70);
			assert.ok(counts.calls > 0, "a new width clips again");
		}
	} finally { useTerminalMetrics(); }
});

test("a 10,000-line expanded row is clipped once, not on every repeat frame", () => {
	const text = Array.from({ length: 10_000 }, (_, n) => `line ${n}`).join("\n");
	const full: ToolRenderers = {
		renderShell: "self",
		renderCall: () => new Text("call", 0, 0),
		renderResult: value => new Text((value.content[0] as { text: string }).text, 0, 0),
	};
	try {
		const counts = countingMetrics();
		for (const active of [true, false]) {
			const switched = row(createSwitchableToolView(full, bashBaseline(), () => active, dependencies));
			switched.updateResult(result(text));
			switched.setExpanded(true);
			counts.calls = 0;
			const first = switched.render(100);
			assert.match(stripAnsi(first.join("\n")), /line 9999/, `active=${active}`);
			assert.ok(counts.calls >= 10_000, `the first frame clips every row, active=${active}`);
			counts.calls = 0;
			for (let frame = 0; frame < 3; frame++) assert.deepEqual(switched.render(100), first);
			assert.equal(counts.calls, 0, `repeat frames re-clip nothing, active=${active}`);
		}
	} finally { useTerminalMetrics(); }
});

test("an unchanged native row reuses its Box in both slots: repeat frames paint only the background sample", () => {
	const paints = { count: 0 };
	const output = new Text(Array.from({ length: 20 }, (_, n) => `out ${n}`).join("\n"), 0, 0);
	const { renderers, context, component } = directRow(fixed(new Text("call", 0, 0), output), taggedTheme("T", paints));
	// The HTML exporter renders the result slot on its own; it shares the same cached shell idea.
	const resultSlot = renderers.renderResult!(result() as never, { expanded: false, isPartial: false }, taggedTheme("T", paints), context);
	try {
		const counts = countingMetrics();
		for (const slot of [resultSlot, component]) {
			const first = slot.render(60);
			assert.ok(first.length > 20);
			paints.count = 0; counts.calls = 0;
			for (let frame = 0; frame < 3; frame++) assert.deepEqual(slot.render(60), first);
			assert.equal(paints.count, 3, "one bgFn sample per frame and no repainted line");
			assert.equal(counts.calls, 0, "and no re-clip");
		}
	} finally { useTerminalMetrics(); }
});

test("after several cached frames a click still reaches the component under it, in both shells", () => {
	for (const active of [true, false]) {
		const hits: string[] = [];
		const target = (name: string, lines: string[]) => ({
			render: () => lines, invalidate() {},
			handleMouse(event: MouseEvent) { hits.push(`${name}@${event.y}`); return { handled: true }; },
		});
		const call = target("call", ["call"]);
		const output = target("result", ["result 0", "result 1"]);
		const switched = row(createSwitchableToolView(fixed(call, output, "self"), fixed(call, output), () => active, dependencies));
		switched.updateResult(result());
		frames(switched);
		// The host row opens with a blank separator; the native Box adds a top padding row and outputPad columns.
		const top = active ? 1 : 2;
		const x = active ? 0 : 2;
		assert.equal(switched.handleMouse({ ...leftClick, x, y: top + 2 })?.handled, true);
		assert.equal(switched.handleMouse({ ...leftClick, x, y: top })?.handled, true);
		assert.deepEqual(hits, ["result@1", "call@0"], `active=${active}`);
	}
});

// Third-party renderers (pi-persona, MCP adapters): the content stays theirs, only the
// frame is ours. One lane, so their hooks run once and keep one state object.

type Options = Parameters<NonNullable<ToolRenderers["renderResult"]>>[1];
/** A third-party tool with both hooks, reused components and row state — and a record of everything it was handed. */
function thirdParty() {
	const seen = {
		calls: 0, results: 0, states: new Set<object>(), theme: undefined as Theme | undefined,
		callContext: undefined as Context | undefined, resultContext: undefined as Context | undefined,
		options: undefined as Options | undefined, callComponents: new Set<Component>(), resultComponents: new Set<Component>(),
	};
	const renderers: ToolRenderers = {
		renderCall(args, theme, context) {
			seen.calls++; seen.states.add(context.state); seen.theme = theme; seen.callContext = context;
			context.state.callsSeen = (context.state.callsSeen as number | undefined ?? 0) + 1;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold(`monitor ${(args as { action?: string }).action ?? "arm"}`))} ${theme.fg("dim", "CI run finished")}`);
			seen.callComponents.add(text);
			return text;
		},
		renderResult(value, options, theme, context) {
			seen.results++; seen.states.add(context.state); seen.resultContext = context; seen.options = options;
			assert.ok((context.state.callsSeen as number) > 0, "the result hook shares the call hook's state");
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const body = value.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
			const lines = options.expanded ? body : body.split("\n").slice(0, 2).join("\n");
			text.setText(theme.fg(context.isError ? "error" : "toolOutput", `${options.isPartial ? "running " : ""}${lines}`));
			seen.resultComponents.add(text);
			return text;
		},
	};
	return { renderers, seen };
}
const monitorRow = (renderers: ToolRenderers | undefined, id = "monitor-row", outputPad = 1) =>
	new ToolExecutionComponent("monitor", id, { action: "arm" }, { outputPad }, renderers, ui, process.cwd());
const flatDependencies = { ...dependencies, toolName: "monitor" };
const launched = "launched auth-review · reviewer · opus-4-8 · high\n    token-tests · tester · sonnet-4-6 · high\nthird line only when expanded";
const text = (lines: string[]) => lines.map(line => stripAnsi(line).trimEnd());

test("a third-party row is flat while active: one dot, its call, its result under └, no fill and no pad rows", () => {
	const { renderers, seen } = thirdParty();
	const switched = monitorRow(createFlatToolView(renderers, () => true, flatDependencies));
	switched.updateResult(result(launched));
	const lines = switched.render(100);
	assert.deepEqual(text(lines), [
		"",
		" ● monitor arm CI run finished",
		" └ launched auth-review · reviewer · opus-4-8 · high",
		"       token-tests · tester · sonnet-4-6 · high",
	]);
	assert.ok(lines.every(line => !line.includes("\x1b[48")), "no background fill");
	assert.ok(lines[1]!.includes(seen.theme!.fg("success", "●")), "the settled dot is the success role");
	assert.ok(lines[2]!.includes(seen.theme!.fg("toolOutput", "└")));
	// The renderer's own styling is passed through untouched.
	assert.ok(lines[1]!.includes(seen.theme!.fg("toolTitle", seen.theme!.bold("monitor arm"))));
	for (const width of [40, 60, 100]) {
		const narrow = switched.render(width);
		assert.ok(narrow.every(line => visibleWidth(line) <= width), `fits ${width}`);
		assert.equal(text(narrow)[1], " ● monitor arm CI run finished");
		assert.match(text(narrow)[2]!, /^ └ launched auth-review/);
		assert.ok(text(narrow).slice(3).every(line => line.startsWith("   ")), `continuation lines align under the first at ${width}`);
		assert.ok(text(narrow).slice(1).every(line => line.trim() !== ""), `no blank row inside the row at ${width}`);
	}
});

for (const stage of ["pending", "partial", "success", "error"] as const) {
	test(`existing third-party ${stage} row toggles flat -> exact host box -> flat, with one state object`, () => {
		let active = true;
		const wrapped = thirdParty();
		const host = thirdParty();
		const switched = monitorRow(createFlatToolView(wrapped.renderers, () => active, flatDependencies));
		const native = monitorRow(host.renderers);
		const parent = new Container();
		parent.addChild(switched);
		if (stage !== "pending") {
			switched.updateResult(result(launched, stage === "error"), stage === "partial");
			native.updateResult(result(launched, stage === "error"), stage === "partial");
		}
		for (const expanded of [false, true]) {
			switched.setExpanded(expanded);
			native.setExpanded(expanded);
			active = true;
			parent.invalidate();
			const flat = switched.render(70);
			assert.equal(text(flat)[1], " ● monitor arm CI run finished");
			if (stage !== "pending") {
				assert.match(text(flat)[2]!, stage === "partial" ? /^ └ running launched/ : /^ └ launched/);
				assert.equal(text(flat).some(line => /third line/.test(line)), expanded, "expanded reaches the third-party renderer");
			}
			assert.ok(flat.every(line => !line.includes("\x1b[48")));
			active = false;
			parent.invalidate(); // TUI inherits this public recursive invalidation.
			for (const width of [8, 19, 40, 60, 100]) {
				const lines = switched.render(width);
				assert.deepEqual(lines, native.render(width), `host equality at width ${width}, expanded=${expanded}`);
				assert.ok(lines.every(line => visibleWidth(line) <= width));
			}
			active = true;
			parent.invalidate();
			assert.deepEqual(switched.render(70), flat, "and exactly the flat row again");
		}
		assert.equal(wrapped.seen.states.size, 1, "one state object, whichever frame is showing");
		assert.equal([...wrapped.seen.states][0], (switched as unknown as { rendererState: object }).rendererState,
			"and it is the host's own row state, as without this package");
		assert.equal(wrapped.seen.callComponents.size, 1, "lastComponent is the renderer's own, so it kept reusing it");
		assert.equal(wrapped.seen.resultComponents.size, stage === "pending" ? 0 : 1);
	});
}

test("third-party hooks run once per host update and never per frame; their context is the host's", () => {
	let active = true;
	let requests = 0;
	const { renderers, seen } = thirdParty();
	const switched = new ToolExecutionComponent("monitor", "ctx", { action: "arm" }, { outputPad: 1 },
		createFlatToolView(renderers, () => active, flatDependencies), { requestRender() { requests++; } } as TUI, process.cwd());
	const counts = () => [seen.calls, seen.results];
	assert.deepEqual(counts(), [1, 0], "the constructor's display update");
	switched.markExecutionStarted();
	assert.deepEqual(counts(), [2, 0]);
	switched.updateResult(result(launched), true);
	assert.deepEqual(counts(), [3, 1], "one call and one result hook for a partial update");
	assert.deepEqual([seen.options, seen.resultContext!.isPartial, seen.resultContext!.toolCallId, seen.resultContext!.args],
		[{ expanded: false, isPartial: true }, true, "ctx", { action: "arm" }]);
	for (active of [true, false, true]) frames(switched, 70, 4);
	assert.deepEqual(counts(), [3, 1], "frames and lane switches call no hook");
	switched.updateResult(result("boom", true));
	assert.deepEqual(counts(), [4, 2], "the final callback arrives exactly once");
	assert.deepEqual([seen.options, seen.resultContext!.isError, seen.resultContext!.isPartial, seen.resultContext!.durationMs],
		[{ expanded: false, isPartial: false }, true, false, 321]);
	active = false;
	switched.setExpanded(true);
	assert.deepEqual(counts(), [5, 3], "an update while toggled off still reaches the one lane, once");
	assert.equal(seen.options!.expanded, true);
	assert.equal(seen.callContext!.state, seen.resultContext!.state);
	assert.equal(seen.callContext!.state.callsSeen, 5, "state written by the renderer survives every toggle");
	// The host's own invalidate: it invalidates the row and asks for a render.
	const before = requests;
	seen.callContext!.invalidate();
	assert.equal(requests, before + 1);
	assert.deepEqual(counts(), [6, 4], "context.invalidate() is the host's, so it re-runs the hooks once");
});

test("third-party dot and connector take the roles of this package's own rows in every state", () => {
	const { renderers, seen } = thirdParty();
	const switched = monitorRow(createFlatToolView(renderers, () => true, flatDependencies));
	const marks = () => switched.render(70).slice(1, 3);
	assert.ok(marks()[0]!.includes(seen.theme!.fg("dim", "●")), "not started");
	switched.markExecutionStarted();
	assert.ok(marks()[0]!.includes(seen.theme!.fg("accent", "●")), "running");
	switched.updateResult(result("streaming"), true);
	assert.ok(marks()[0]!.includes(seen.theme!.fg("accent", "●")));
	assert.ok(marks()[1]!.includes(seen.theme!.fg("accent", "└")), "a partial result hangs under an accent connector");
	assert.equal(text(marks())[1], " └ running streaming");
	switched.updateResult(result("done"));
	assert.ok(marks()[0]!.includes(seen.theme!.fg("success", "●")));
	switched.updateResult(result("boom", true));
	assert.ok(marks()[0]!.includes(seen.theme!.fg("error", "●")));
	assert.ok(marks()[1]!.includes(seen.theme!.fg("error", "└")));
	assert.equal(text(marks())[1], " └ boom");
});

test("third-party rows with images are left in the host box: image results and image-protocol lines", () => {
	const caps = getCapabilities();
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	try {
		// (a) The result carries image content: the host paints it outside our shell.
		const wrapped = thirdParty();
		const host = thirdParty();
		const switched = monitorRow(createFlatToolView(wrapped.renderers, () => true, flatDependencies));
		const native = monitorRow(host.renderers);
		const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
		const value = { ...result(launched), content: [...result(launched).content, image] };
		switched.updateResult(value); native.updateResult(value);
		const lines = switched.render(70);
		assert.deepEqual(lines, native.render(70), "an image result keeps the host row, active or not");
		assert.equal(lines.join("\n").split("1337;File=").length - 1, 1, "painted once, by the host");
		switched.updateResult(result(launched));
		assert.equal(text(switched.render(70))[1], " ● monitor arm CI run finished", "a later result without images is flat again");

		// (b) The renderer itself emits a protocol line: never prefixed, never clipped.
		const payload = `\x1b_Gf=100,a=T;${"A".repeat(300)}\x1b\\`;
		const picture = { lines: [payload, ""], render: () => picture.lines, invalidate() {} };
		const call = new Text("screenshot", 0, 0);
		const framed = monitorRow(createFlatToolView(fixed(call, picture), () => true, flatDependencies));
		const plain = monitorRow(fixed(call, picture));
		assert.equal(text(framed.render(70))[1], " ● screenshot", "flat until a result exists");
		framed.updateResult(result()); plain.updateResult(result());
		assert.deepEqual(framed.render(70), plain.render(70));
		assert.ok(framed.render(70).some(line => line.includes(payload)), "the payload is intact");
		picture.lines = ["now plain text"];
		assert.deepEqual(framed.render(70), plain.render(70), "a row that painted an image keeps the host box for good");
	} finally { setCapabilities(caps); }
});

test("a third-party renderer that frames itself keeps its own shell, active or not", () => {
	for (const active of [true, false]) {
		const self = fixed(new Text("own frame call", 0, 0), new Text("own frame result", 0, 0), "self");
		const switched = monitorRow(createFlatToolView(self, () => active, flatDependencies));
		const native = monitorRow(self);
		switched.updateResult(result()); native.updateResult(result());
		assert.deepEqual(switched.render(50), native.render(50), `active=${active}`);
	}
});

test("third-party lines are never wrapped by the frame: an over-wide line is clipped, at every width", () => {
	const stubborn = { render: () => ["界".repeat(120), "x".repeat(300)], invalidate() {} };
	const call = { render: () => ["c".repeat(300)], invalidate() {} };
	const switched = monitorRow(createFlatToolView(fixed(call, stubborn), () => true, flatDependencies));
	switched.updateResult(result());
	try {
		for (const metrics of [undefined, { visibleWidth, truncateToWidth }]) {
			useTerminalMetrics(metrics);
			for (const pad of [0, 1, 2, 20]) {
				switched.setOutputPad(pad);
				for (let width = 1; width <= 130; width++) {
					const lines = switched.render(width);
					assert.equal(lines.length, 4, `separator + three lines at ${width}`);
					assert.ok(lines.every(line => visibleWidth(line) <= width), `width=${width}, pad=${pad}, metrics=${metrics ? "pi-tui" : "mirror"}`);
				}
			}
		}
	} finally { useTerminalMetrics(); }
	switched.setOutputPad(1);
	assert.match(text(switched.render(40))[1]!, /^ ● c{36}$/, "the call is cut at the inner width, with the lead intact");
	assert.match(text(switched.render(40))[2]!, /^ └ 界{18}$/);
});

test("a third-party renderer's own padding rows are not painted inside the row; blank lines inside its content stay", () => {
	// `new Text(text)` defaults to one padding row above and below, and one column each side.
	const padded: ToolRenderers = { renderCall: () => new Text("padded call"), renderResult: () => new Text("first\n\nthird") };
	const switched = monitorRow(createFlatToolView(padded, () => true, flatDependencies));
	switched.updateResult(result());
	assert.deepEqual(text(switched.render(60)), ["", " ●  padded call", " └  first", "", "    third"]);
});

test("a third-party slot with nothing to show: no result lines, no call lines, a throwing hook", () => {
	const none = { render: () => [], invalidate() {} };
	const call = new Text("only the call", 0, 0);
	const silentResult = monitorRow(createFlatToolView(fixed(call, none), () => true, flatDependencies));
	silentResult.updateResult(result());
	assert.deepEqual(text(silentResult.render(60)), ["", " ● only the call"]);

	const silentCall = monitorRow(createFlatToolView(fixed(none, new Text("result alone\nsecond", 0, 0)), () => true, flatDependencies));
	silentCall.updateResult(result());
	assert.deepEqual(text(silentCall.render(60)), ["", " ● result alone", "   second"], "the row still leads with its dot");

	const nothing = monitorRow(createFlatToolView(fixed(none, none), () => true, flatDependencies));
	nothing.updateResult(result());
	assert.deepEqual(nothing.render(60), [], "a row with no line at all takes none, as a self-framed row does in the host");

	const throwing: ToolRenderers = { renderCall() { throw Error("call"); }, renderResult() { throw Error("result"); } };
	const broken = monitorRow(createFlatToolView(throwing, () => true, flatDependencies));
	broken.updateResult(result("first\nsecond"));
	const lines = text(broken.render(60));
	assert.equal(lines[1], " ● monitor", "the adapter's generic call text, in the same frame");
	assert.ok(lines.includes(" └ first") && lines.includes("   second"), lines.join("\n"));
});

// What the real host paints for a row with little or nothing in it, probed against
// ToolExecutionComponent: its default shell is [Spacer, Box], so the separator row is
// printed even above a Box with no line in it, while a `renderShell: "self"` row gets
// the separator only together with at least one line of its own.
const rowsOf = (...rows: string[]): Component => ({ render: () => rows, invalidate() {} });
const sparse: Array<[name: string, build: () => ToolRenderers, flat: string[] | undefined]> = [
	["blank-only slots", () => fixed(rowsOf(""), rowsOf("")), undefined],
	["slots of several blank and space-only lines", () => fixed(rowsOf("  ", ""), rowsOf("", "   ", "")), undefined],
	["a blank call beside an empty result", () => fixed(rowsOf(""), new Container()), undefined],
	["a call with text beside an empty result", () => fixed(new Text("call text", 0, 0), new Container()), [" ● call text"]],
	// Pending, this row has no line at all: that is the next test's case.
	["an empty call beside a result with text", () => fixed(new Container(), new Text("result text\nsecond", 0, 0)), [" ● result text", "   second"]],
];
for (const stage of ["pending", "partial", "success", "error"] as const) {
	test(`a sparse third-party ${stage} row toggled off is the host's row exactly: blank-only slots, one empty slot`, () => {
		for (const [name, build, flat] of stage === "pending" ? sparse.slice(0, -1) : sparse) {
			for (const outputPad of [0, 1, 2]) {
				let active = true;
				const switched = monitorRow(createFlatToolView(build(), () => active, flatDependencies), "sparse", outputPad);
				const native = monitorRow(build(), "sparse", outputPad);
				const parent = new Container();
				parent.addChild(switched);
				if (stage !== "pending") for (const component of [switched, native]) component.updateResult(result("ignored", stage === "error"), stage === "partial");
				// Active, a slot of nothing but blank lines is padding: the row takes no line at all.
				if (outputPad === 1) assert.deepEqual(text(switched.render(60)), flat ? ["", ...flat] : [], `${name}: active`);
				active = false;
				parent.invalidate();
				for (const width of [8, 19, 40, 100]) {
					const lines = switched.render(width);
					assert.deepEqual(lines, native.render(width), `${name}: host equality at width ${width}, outputPad ${outputPad}`);
					assert.ok(lines.every(line => visibleWidth(line) <= width));
				}
				active = true;
				parent.invalidate();
				if (outputPad === 1) assert.deepEqual(text(switched.render(60)), flat ? ["", ...flat] : [], `${name}: active again`);
			}
		}
	});

	test(`a third-party ${stage} row whose slots render no line takes none, on or off; the host's lone separator row is out of a self shell's reach`, () => {
		for (const build of [() => fixed(new Container(), new Container()), () => fixed(rowsOf(), rowsOf())]) {
			let active = true;
			const switched = monitorRow(createFlatToolView(build(), () => active, flatDependencies));
			const native = monitorRow(build());
			const parent = new Container();
			parent.addChild(switched);
			if (stage !== "pending") for (const component of [switched, native]) component.updateResult(result("ignored", stage === "error"), stage === "partial");
			for (const width of [8, 40, 100]) {
				assert.deepEqual(native.render(width), [""], "the host: its separator row and an empty Box");
				active = true;
				parent.invalidate();
				assert.deepEqual(switched.render(width), [], "active: an empty row takes no line");
				active = false;
				parent.invalidate();
				assert.deepEqual(switched.render(width), [], "off: one row short of the host — the documented exception");
			}
		}
		// Why the off state cannot be exact here: a self shell is never one row tall.
		const self = (...rows: string[]) => monitorRow({ renderShell: "self", renderCall: () => rowsOf(...rows) }).render(40);
		assert.deepEqual([self(), self(""), self("", "")], [[], ["", ""], ["", "", ""]],
			"the host adds its separator only to a self shell that has a line: no line, or two and more");
	});
}

test("a third-party line that is not a string never throws: the row keeps the host box and paints what the host paints", () => {
	const junk = (rows: unknown[]): Component => ({ render: () => rows as string[], invalidate() {} });
	for (const rows of [[undefined, "x"], [null], [42, "x"], ["x", {}], [["nested"], true]]) {
		for (const where of ["call", "result"] as const) {
			const build = () => where === "call" ? fixed(junk(rows), new Text("result", 0, 0)) : fixed(new Text("call", 0, 0), junk(rows));
			for (const active of [true, false]) {
				const name = `${JSON.stringify(rows)} in the ${where} slot, active=${active}`;
				const switched = monitorRow(createFlatToolView(build(), () => active, flatDependencies));
				const native = monitorRow(build());
				// Until the bad line exists the active row is flat, like any other.
				if (where === "call" || !active) assert.deepEqual(switched.render(60), native.render(60), `${name}, pending`);
				else assert.deepEqual(text(switched.render(60)), ["", " ● call"], `${name}, pending`);
				for (const [value, partial] of [[result(), true], [result(), false], [result("boom", true), false]] as const) {
					switched.updateResult(value, partial); native.updateResult(value, partial);
					for (const width of [24, 60, 100]) assert.deepEqual(switched.render(width), native.render(width), `${name}, width ${width}`);
					for (let width = 1; width <= 24; width++) {
						assert.ok(switched.render(width).every(line => visibleWidth(line) <= width), `${name}: clipped to ${width}`);
					}
				}
			}
		}
	}

	// Like a row that painted an image, it keeps the host box for the rest of its life.
	const output = { lines: ["plain"] as unknown[], render: () => output.lines as string[], invalidate() {} };
	const call = new Text("call", 0, 0);
	const framed = monitorRow(createFlatToolView(fixed(call, output), () => true, flatDependencies));
	const plainRow = monitorRow(fixed(call, output));
	framed.updateResult(result()); plainRow.updateResult(result());
	assert.deepEqual(text(framed.render(60)), ["", " ● call", " └ plain"], "flat while every line is text");
	frames(framed, 60);
	output.lines = [undefined, "x"];
	assert.deepEqual(framed.render(60), plainRow.render(60), "the first non-string line hands the row to the host box");
	assert.ok(text(framed.render(60)).includes(" undefined"), "which paints it as the text it coerces to");
	output.lines = ["plain again"];
	assert.deepEqual(framed.render(60), plainRow.render(60), "and it stays there");

	// A renderer that frames itself has no Box to coerce its lines: they are handed on as the host hands them on.
	const selfFramed = () => fixed(new Text("own frame", 0, 0), junk([undefined, "x".repeat(80), 42]), "self");
	const hostRows = (() => { const row = monitorRow(selfFramed()); row.updateResult(result()); return row.render(40); })();
	assert.deepEqual(hostRows.slice(2), [undefined, "x".repeat(80), 42]);
	for (const active of [true, false]) {
		const flat = monitorRow(createFlatToolView(selfFramed(), () => active, flatDependencies));
		flat.updateResult(result());
		assert.deepEqual(flat.render(40), hostRows, `self-framed third-party row, active=${active}`);
	}
	const baseline = monitorRow(createSwitchableToolView(compact, selfFramed(), () => false, flatDependencies));
	baseline.updateResult(result());
	assert.deepEqual(baseline.render(40), hostRows, "a self-framed baseline lane");
});

test("a running bash row names the model's timeout where stock Pi does, and drops it with the final result", () => {
	const args = { command: "npm test", timeout: 30 };
	const bashRow = (renderers: ToolRenderers | undefined) =>
		new ToolExecutionComponent("bash", "timeout", args, { outputPad: 1 }, renderers, ui, process.cwd());
	const switched = bashRow(createSwitchableToolView(createToolView("bash", () => "expand"), bashBaseline(), () => true, dependencies));
	const native = bashRow(bashBaseline());
	assert.ok(text(native.render(70)).includes(" $ npm test (timeout 30s)"), "stock Pi's own row");
	assert.equal(text(switched.render(70))[1], " ● $ npm test (timeout 30s)", "pending");
	switched.markExecutionStarted();
	assert.equal(text(switched.render(70))[1], " ● $ npm test (timeout 30s)", "running");
	switched.updateResult(result("ok 1"), true);
	assert.equal(text(switched.render(70))[1], " ● $ npm test (timeout 30s)", "streaming output");
	assert.equal(text(switched.render(26))[1], " ● $ npm test", "too narrow: the rung goes whole");
	switched.updateArgs({ command: "npm test", timeout: "30s\x1b[2J" });
	assert.equal(text(switched.render(70))[1], " ● $ npm test", "a timeout that is not a number is never printed");
	switched.updateArgs(args);
	assert.equal(text(switched.render(70))[1], " ● $ npm test (timeout 30s)");
	switched.updateResult(result("ok 1\nok 2"));
	assert.equal(text(switched.render(70))[1], " ● $ npm test · 2 lines (expand)", "settled");
	switched.updateResult(result("Command timed out after 30 seconds", true));
	assert.equal(text(switched.render(70))[1], " ● $ npm test", "failed: the error text says what happened");
});

test("a click on a flat third-party row expands that row; one on the renderer's own component reaches it", () => {
	const { renderers, seen } = thirdParty();
	const switched = monitorRow(createFlatToolView(renderers, () => true, flatDependencies));
	switched.updateResult(result(launched));
	frames(switched);
	assert.equal(switched.handleMouse(leftClick)?.handled, true, "the host's own click-to-expand");
	assert.equal(seen.options!.expanded, true);
	assert.ok(text(switched.render(70)).some(line => /third line/.test(line)));

	const hits: string[] = [];
	const target = (name: string, lines: string[]) => ({
		render: () => lines, invalidate() {},
		handleMouse(event: MouseEvent) { hits.push(`${name}@${event.x},${event.y} ${event.width}x${event.height}`); return { handled: true }; },
	});
	// Each opens with a blank row the frame drops: the component still gets its own coordinates.
	const clickable = monitorRow(createFlatToolView(fixed(target("call", ["", "call"]), target("result", ["", "result 0", "result 1", ""])), () => true, flatDependencies));
	clickable.updateResult(result());
	assert.deepEqual(text(clickable.render(70)), ["", " ● call", " └ result 0", "   result 1"]);
	// Host row: y 0 is its blank separator. Flat row: one column of padding, two of lead.
	assert.equal(clickable.handleMouse({ ...leftClick, x: 5, y: 3 })?.handled, true);
	assert.equal(clickable.handleMouse({ ...leftClick, x: 3, y: 1 })?.handled, true);
	assert.deepEqual(hits, ["result@2,2 66x4", "call@0,1 66x2"]);
	hits.length = 0;
	assert.equal(clickable.handleMouse({ ...leftClick, x: 1, y: 1 })?.handled, true, "the dot is the host's: it expands the row");
	assert.deepEqual(hits, []);
});

test("a flat third-party row never folds and never consults or feeds the run registry", () => {
	const runs = createToolRunRegistry();
	const { groups, counts } = countingGroups(runs);
	let settled = 0;
	const watched: GroupControl = { ...groups, settle(id, failed) { settled++; groups.settle(id, failed); } };
	const { renderers } = thirdParty();
	const view = createFlatToolView(renderers, () => true, { ...flatDependencies, groups: watched });
	const rows = ["m1", "m2", "m3"].map(id => monitorRow(view, id));
	for (const [index, id] of ["m1", "m2", "m3"].entries()) {
		runs.onToolStart(id, "read"); // even if a registry knew these ids as foldable calls
		rows[index]!.updateResult(result(launched));
		runs.settle(id, false);
	}
	runs.closeAll();
	for (const component of rows) assert.equal(text(component.render(70))[1], " ● monitor arm CI run finished");
	assert.equal(rows[0]!.handleMouse(leftClick)?.handled, true);
	assert.deepEqual({ ...counts, settled }, { decisions: 0, expands: 0, settled: 0 });
});

test("flat third-party frames: a repeat frame measures nothing; silent changes, state, padding, width and theme repaint", () => {
	const call = silent("call v1");
	const output = silent("output v1");
	const switched = monitorRow(createFlatToolView(fixed(call, output), () => true, flatDependencies));
	switched.updateResult(result(), true);
	try {
		const counts = countingMetrics();
		const first = switched.render(100);
		assert.ok(counts.calls > 0, "the first frame clips through the installed metrics");
		counts.calls = 0;
		for (let frame = 0; frame < 3; frame++) assert.deepEqual(switched.render(100), first);
		assert.equal(counts.calls, 0, "repeat frames re-measure nothing");
		switched.render(70);
		assert.ok(counts.calls > 0, "a new width composes again");
	} finally { useTerminalMetrics(); }
	const next = () => text(switched.render(70));
	frames(switched);
	call.lines = ["call v2"];
	assert.equal(next()[1], " ● call v2", "a new array");
	frames(switched);
	output.lines[0] = "output v2"; // the same array, mutated in place
	assert.equal(next()[2], " └ output v2", "an in-place mutation");
	frames(switched);
	output.lines.push("output extra");
	assert.deepEqual(next().slice(2), [" └ output v2", "   output extra"], "grown in place");
	frames(switched);
	const partial = switched.render(70);
	switched.updateResult(result());
	assert.notDeepEqual(switched.render(70), partial, "the same lines under another state repaint the dot");
	frames(switched);
	switched.setOutputPad(3);
	assert.equal(next()[1], "   ● call v2", "padding");
	switched.invalidate();
	assert.equal(next()[1], "   ● call v2", "invalidation rebuilds the same row");
});

test("flat third-party frame: a new theme object, or the host's invalidation after a palette switch, repaints the marks", () => {
	let tag = "A";
	const paints = { count: 0 };
	const palette = () => ({
		fg: (token: string, value: string) => { paints.count++; return `<${tag}:${token}>${value}`; },
		bg: (_token: string, value: string) => value, bold: (value: string) => value,
	}) as unknown as Theme;
	const theme = palette();
	const renderers = createFlatToolView(fixed(new Text("same call", 0, 0)), () => true, flatDependencies);
	const context = {
		args: {}, toolCallId: "direct", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
		executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
		isError: false, outputPad: 1,
	} as unknown as Context;
	const component = renderers.renderCall!({}, theme, context);
	frames(component, 30);
	paints.count = 0;
	assert.match(component.render(30)[0]!, /^ <A:success>● same call/);
	assert.equal(paints.count, 0, "an unchanged frame paints no mark");
	// The host's theme object is one proxy: a palette switch changes what it paints, not
	// its identity, and the host invalidates every row (the renderer's lines bake colors too).
	tag = "B";
	component.invalidate();
	assert.match(component.render(30)[0]!, /^ <B:success>● same call/);
	tag = "C";
	renderers.renderCall!({}, palette(), context);
	assert.match(component.render(30)[0]!, /^ <C:success>● same call/, "a new theme object needs no invalidation");
});

test("real HTML exporter renders a third-party tool's call and result through the flat adapter, expanded included", () => {
	for (const active of [true, false]) {
		const { renderers, seen } = thirdParty();
		const stateKey = Symbol("monitor-state");
		const extension = { toolRenderers: [(_name: string, next: () => ToolRenderers | undefined) =>
			createFlatToolView(next()!, () => active, flatDependencies, stateKey)] } as Extension;
		const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(),
			{} as ConstructorParameters<typeof ExtensionRunner>[3], {} as ConstructorParameters<typeof ExtensionRunner>[4]);
		const html = createToolHtmlRenderer({
			getToolRenderers: name => runner.resolveToolRenderers(name, () => renderers),
			theme: ({ fg: (_token: string, value: string) => value, bg: (_token: string, value: string) => value,
				bold: (value: string) => value } as Parameters<typeof createToolHtmlRenderer>[0]["theme"]),
			cwd: process.cwd(),
		});
		const call = html.renderCall("export", "monitor", { action: "arm" }) ?? "";
		assert.ok(call.includes("monitor arm"), `call for active=${active}: ${call}`);
		assert.equal(call.includes("●"), active, "the exported call carries the dot only while the redesign is active");
		const rendered = html.renderResult("export", "monitor", [{ type: "text", text: launched }], undefined, false);
		const collapsedHtml = rendered?.collapsed ?? "";
		const expandedHtml = rendered?.expanded ?? "";
		assert.ok(collapsedHtml.includes("token-tests") && !collapsedHtml.includes("third line"), `collapsed: ${collapsedHtml}`);
		assert.ok(expandedHtml.includes("third line"), `expanded: ${expandedHtml}`);
		assert.equal(expandedHtml.includes("└"), active);
		assert.equal(expandedHtml.split("launched auth-review").length - 1, 1, "the result is exported once");
		assert.deepEqual([seen.calls, seen.results, seen.states.size], [1, 2, 1], "one hook call per exporter request, one state");
	}
});
