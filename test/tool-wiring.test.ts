import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import pi1337 from "../src/index.ts";

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
	return { handlers, resolvers, ctx, toggle: () => toggle?.("", ctx), invalidations: () => invalidations };
}

async function isolated(body: () => Promise<void>) {
	const keys = ["PI_1337_STATE_DIR", "PI_1337_DISABLE", "PI_1337_THEME", "PI_1337_BG", "PI_1337_POLISH"];
	const saved = keys.map(key => process.env[key]);
	const dir = mkdtempSync(join(tmpdir(), "pi1337-tools-"));
	process.env.PI_1337_STATE_DIR = dir;
	delete process.env.PI_1337_DISABLE;
	process.env.PI_1337_THEME = "off";
	process.env.PI_1337_BG = "off";
	delete process.env.PI_1337_POLISH;
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
		const custom = { renderShell: "self" as const, renderCall: () => ({ render: () => ["custom"], invalidate() {} }) };
		assert.equal(resolve("delegate", () => custom), custom, "persona's renderer is not replaced");
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
