import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import pi1337 from "../src/index.ts";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

async function fixture(t: TestContext, mode: "tui" | "rpc" | "json" | "print" = "tui", spinner?: { frames: string[][]; intervalMs: number; color?: string }, skinName = mode === "tui" ? "1337" : "dark") {
	const dir = mkdtempSync(join(tmpdir(), "pi1337-activity-"));
	let sourcePath = join(dir, `${skinName}.json`);
	writeFileSync(sourcePath, JSON.stringify({ export: { pageBg: "#000000" } }));
	writeFileSync(sourcePath.replace(/\.json$/i, ".pi1337"), JSON.stringify({
		avatar: { idle: ["idle"], working: ["working"], confused: ["compacting"], error: ["error"] },
		...(spinner ? { spinner } : {}),
	}));
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
	let toggle: (() => unknown) | undefined;
	let editor: Component | undefined;
	let avatar: Component | undefined;
	let footer: Component | undefined;
	let idle = true;
	let renders = 0;
	let themeChanges = 0;
	let spinnerSwap = 0;
	const identity = (text: string) => text;
	const tui = { terminal: { rows: 40, columns: 100, write() {} }, invalidate() {}, requestRender() { renders++; } } as unknown as TUI;
	const theme = {
		name: skinName, sourcePath, fg: (_color: string, text: string) => text,
		style: (text: string, options: { fg?: { kind: string; r: number; g: number; b: number } }) => options.fg?.kind === "rgb"
			? `\x1b[38;2;${options.fg.r};${options.fg.g};${options.fg.b}m${text}\x1b[39m`
			: text,
	};
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
			setFooter(factory: ((...args: unknown[]) => Component) | undefined) { footer = factory?.(tui, theme, footerData); },
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
		registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return {
		setIdle(value: boolean) { idle = value; },
		switchSpinner(intervalMs: number, frames = ["▲△△", "△▲△", "△△▲"]) {
			sourcePath = join(dir, `alternate-${++spinnerSwap}.json`);
			theme.sourcePath = sourcePath;
			writeFileSync(sourcePath, JSON.stringify({}));
			writeFileSync(sourcePath.replace(/\.json$/i, ".pi1337"), JSON.stringify({ spinner: { frames, intervalMs } }));
			footer?.render(100);
		},
		flushTheme: async () => { await Promise.resolve(); },
		emit: async (name: string, fields: Record<string, unknown> = {}) => {
			const handler = handlers.get(name);
			assert.ok(handler, `missing ${name} handler`);
			await handler({ type: name, ...fields }, ctx);
		},
		text: (width = 100) => editor?.render(width).join("\n") ?? "",
		render: (width = 100) => editor?.render(width) ?? [],
		avatar: () => avatar?.render(100).join("\n") ?? "",
		toggle: () => toggle?.(),
		renders: () => renders,
		themeChanges: () => themeChanges,
	};
}

for (const columns of [1, 2, 3] as const) {
	test(`sidecar-loaded two-row spinner is generic for ${columns}-column profiles`, async (t) => {
		const glyphs = columns === 1 ? ["▲", "△"] : columns === 2 ? ["◆◇", "◇◆"] : ["▰▱▱", "▱▰▱"];
		const color = columns === 2 ? "#d51f2a" : undefined;
		const frames = [[glyphs[0], glyphs[1]], [glyphs[1], glyphs[0]]];
		const f = await fixture(t, "tui", { frames, intervalMs: 120, color }, `custom-pyramid-${columns}`);
		const rows = f.render();
		assert.ok(rows.some((row) => row.includes("╭")), "extension installed the captured framed-editor factory");
		const idleGeometry = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").length);
		assert.ok(!f.text().includes(glyphs[0]), "idle editor does not paint the spinner profile");

		f.setIdle(false);
		await f.emit("agent_start");
		const active = f.render();
		const activeText = active.join("\n");
		assert.ok(activeText.includes(glyphs[0]), "active state paints the first configured row");
		assert.ok(activeText.includes(glyphs[1]), "active state paints the second configured row");
		if (color) assert.ok(activeText.includes("\x1b[38;2;213;31;42m"), "optional sidecar RGB is applied by the real editor path");
		assert.deepEqual(active.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").length), idleGeometry, "spinner activity preserves the allocated editor/status geometry");

		await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
		const waiting = f.render().join("\n");
		assert.ok(waiting.includes("?"), "waiting state uses the static prompt marker");
		assert.ok(!waiting.includes(glyphs[0]) && !waiting.includes(glyphs[1]), "waiting hides both animated rows");
		await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
		assert.ok(f.text().includes(glyphs[0]), "resuming restores the sidecar-loaded profile");
	});
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

test("live profile swaps restart the single timer only while active and preserve paused/compacting lifecycle", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	f.switchSpinner(180);
	await f.flushTheme();
	let before = f.renders();
	t.mock.timers.tick(179);
	assert.equal(f.renders(), before, "active timer adopts the new theme interval");
	t.mock.timers.tick(1);
	assert.equal(f.renders(), before + 1, "only one active interval runs after profile replacement");

	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	f.switchSpinner(240, ["●○○", "○●○", "○○●"]);
	await f.flushTheme();
	before = f.renders();
	t.mock.timers.tick(500);
	assert.equal(f.renders(), before, "profile refresh while waiting must not start animation");
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	before = f.renders();
	t.mock.timers.tick(180);
	assert.equal(f.renders(), before, "the old 180ms timer must not survive the paused profile replacement");
	t.mock.timers.tick(59);
	assert.equal(f.renders(), before, "the resumed 240ms profile must not tick early");
	t.mock.timers.tick(1);
	assert.equal(f.renders(), before + 1, "the refreshed 240ms interval ticks exactly once at its deadline");
	assert.match(f.text(), /○●○/, "resume uses a frame from the replacement theme profile");
	t.mock.timers.tick(240);
	assert.equal(f.renders(), before + 2, "the refreshed interval continues at exactly 240ms");

	await f.emit("session_before_compact", { reason: "manual" });
	f.switchSpinner(300, ["◆◇◇", "◇◆◇", "◇◇◆"]);
	await f.flushTheme();
	before = f.renders();
	t.mock.timers.tick(299);
	assert.equal(f.renders(), before, "a live theme swap during compaction must reset its timer");
	t.mock.timers.tick(1);
	assert.equal(f.renders(), before + 1, "manual compaction uses the latest profile's exact interval");
	assert.match(f.text(), /◇◆◇/, "compaction renders a frame from its replacement profile");
	await f.toggle();
	before = f.renders();
	t.mock.timers.tick(1000);
	assert.equal(f.renders(), before, "toggle-off clears the timer");
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
