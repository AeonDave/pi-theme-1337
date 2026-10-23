import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBashToolDefinition, createExtensionRuntime, ExtensionRunner, initTheme, ToolExecutionComponent,
	type Extension, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, getCapabilities, setCapabilities, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createSwitchableToolView } from "../src/tool-adapter.ts";
import { stripAnsi } from "../src/width.ts";
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
function resolve(baseline: ToolRenderers | undefined, active: () => boolean, polished: ToolRenderers = compact, name = "bash") {
	let nextCalls = 0;
	const extension = { toolRenderers: [(_name: string, next: () => ToolRenderers | undefined) =>
		createSwitchableToolView(polished, next(), active, dependencies)] } as Extension;
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
