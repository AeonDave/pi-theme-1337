import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import pi1337 from "../src/index.ts";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

async function fixture(t: TestContext, mode: "tui" | "rpc" | "json" | "print" = "tui") {
	const dir = mkdtempSync(join(tmpdir(), "pi1337-activity-"));
	const sourcePath = join(dir, "activity.json");
	writeFileSync(sourcePath, JSON.stringify({ export: { pageBg: "#000000" } }));
	writeFileSync(join(dir, "activity.pi1337"), JSON.stringify({
		avatar: { idle: ["idle"], working: ["working"], confused: ["compacting"], error: ["error"] },
	}));
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
	let toggle: (() => unknown) | undefined;
	let editor: Component | undefined;
	let avatar: Component | undefined;
	let idle = true;
	let renders = 0;
	let themeChanges = 0;
	const identity = (text: string) => text;
	const tui = { terminal: { rows: 40, columns: 100, write() {} }, requestRender() { renders++; } } as unknown as TUI;
	const theme = { name: mode === "tui" ? "1337" : "dark", sourcePath, fg: (_color: string, text: string) => text };
	const editorTheme = { borderColor: identity, selectList: {
		text: identity, selectedText: identity, description: identity, selectedDescription: identity, scrollIndicator: identity,
	} };
	const footerData = { getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {} };
	const ctx = {
		hasUI: mode === "tui" || mode === "rpc", mode, cwd: dir, model: { provider: "test", id: "test-model" },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: { getEntries: () => [], getSessionName: () => undefined },
		getContextUsage: () => undefined, isIdle: () => idle,
		ui: {
			theme, setTheme: () => { themeChanges++; return { success: true }; },
			setWorkingVisible() {}, setHiddenThinkingLabel() {}, notify() {},
			setFooter(factory: ((...args: unknown[]) => Component) | undefined) { factory?.(tui, theme, footerData); },
			setEditorComponent(factory: ((...args: unknown[]) => Component) | undefined) {
				editor = factory?.(tui, editorTheme, { matches: () => false });
			},
			setWidget(_key: string, factory: (() => Component) | undefined) { avatar = factory?.(); },
		},
	} as unknown as ExtensionContext;
	t.after(async () => {
		try { await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx); }
		finally { rmSync(dir, { recursive: true, force: true }); }
	});
	pi1337({
		on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		registerCommand(_name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			toggle = () => command.handler("", ctx);
		},
		registerShortcut() {},
	} as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return {
		setIdle(value: boolean) { idle = value; },
		emit: async (name: string, fields: Record<string, unknown> = {}) => {
			const handler = handlers.get(name);
			assert.ok(handler, `missing ${name} handler`);
			await handler({ type: name, ...fields }, ctx);
		},
		text: () => editor?.render(100).join("\n") ?? "",
		avatar: () => avatar?.render(100).join("\n") ?? "",
		toggle: () => toggle?.(),
		renders: () => renders,
		themeChanges: () => themeChanges,
	};
}

test("activity remains live across agent_end and compaction until Pi settles", async (t) => {
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	assert.match(f.text(), SPINNER);
	await f.emit("agent_end");
	assert.match(f.text(), SPINNER, "agent_end can precede retries or compaction");
	assert.match(f.avatar(), /working/);
	await f.emit("session_before_compact", { reason: "threshold" });
	assert.match(f.avatar(), /compacting/);
	await f.emit("session_compact", { reason: "threshold" });
	assert.match(f.avatar(), /working/);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.doesNotMatch(f.text(), SPINNER);
	assert.match(f.avatar(), /idle/);
});

for (const mode of ["rpc", "json", "print"] as const) {
	test(`${mode} lifecycle events do not change the theme or install TUI chrome`, async (t) => {
		const f = await fixture(t, mode);
		f.setIdle(false);
		await f.emit("agent_start");
		await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
		await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
		await f.emit("agent_end");
		f.setIdle(true);
		await f.emit("agent_settled", { aborted: false });
		await f.emit("session_shutdown");
		assert.equal(f.themeChanges(), 0);
		assert.equal(f.renders(), 0);
		assert.equal(f.text(), "");
		assert.equal(f.avatar(), "");
	});
}

test("a blocking prompt pauses motion, survives toggle, and resumes only its active run", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	assert.doesNotMatch(f.text(), SPINNER);
	assert.match(f.text(), /\?/);
	const before = f.renders();
	t.mock.timers.tick(450);
	assert.equal(f.renders(), before, "waiting should have no spinner timer");
	await f.toggle();
	await f.toggle();
	assert.doesNotMatch(f.text(), SPINNER);
	assert.match(f.text(), /\?/);
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	assert.match(f.text(), SPINNER);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: true });
	await f.emit("ui_prompt_start", { kind: "input", reason: "ui_prompt" });
	await f.emit("ui_prompt_end", { kind: "input", reason: "ui_prompt" });
	assert.doesNotMatch(f.text(), SPINNER, "an idle command prompt must not invent an active run");
});

test("manual compaction finishes or aborts without leaving a busy avatar", async (t) => {
	const f = await fixture(t);
	f.setIdle(false); // Pi is busy during manual compaction, despite there being no agent run.
	await f.emit("session_before_compact", { reason: "manual" });
	assert.match(f.avatar(), /compacting/);
	// Pi emits session_compact before it clears its manual compaction busy state.
	await f.emit("session_compact", { reason: "manual" });
	assert.match(f.avatar(), /idle/);
	assert.doesNotMatch(f.text(), SPINNER);
	await f.emit("session_before_compact", { reason: "manual" });
	f.setIdle(true); // Failure is emitted after Pi clears that state.
	await f.emit("session_compact_failed", { reason: "manual", aborted: true });
	assert.match(f.avatar(), /idle/);
	assert.doesNotMatch(f.text(), SPINNER);
	await f.emit("session_before_compact", { reason: "manual" });
	await f.emit("session_compact_failed", { reason: "manual", aborted: false, errorMessage: "provider offline" });
	assert.match(f.avatar(), /error/);
	assert.doesNotMatch(f.text(), SPINNER);
});
