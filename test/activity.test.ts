import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { initTheme, type EntryRenderer, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import pi1337 from "../src/index.ts";
import { ACTIVITY_ELAPSED_MS } from "../src/editor.ts";
import { ACTIVITY_GRACE_MS, RUN_CLOCK_GRACE_MS } from "../src/tool-activity.ts";
// Not a root export; the dist path is how test/preview.ts reaches host internals too.
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";

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
	let thinkingLevel: string | undefined;
	let thinkingReads = 0;
	const notices: [string, string | undefined][] = [];
	const titles: string[] = [];
	const appended: { customType: string; data: unknown }[] = [];
	const chrome: string[] = []; // setFooter / setWorkingVisible calls, in order
	const entryRenderers = new Map<string, EntryRenderer>();
	let invalidations = 0;
	const model = { provider: "test", id: "test-model", reasoning: false };
	const identity = (text: string) => text;
	const tui = { terminal: { rows: 40, columns: 100, write() {} }, invalidate() { invalidations++; }, requestRender() { renders++; } } as unknown as TUI;
	const theme = {
		name: skinName, sourcePath, fg: (_color: string, text: string) => text,
		style: (text: string, options: { fg?: { kind: string; r: number; g: number; b: number } }) => options.fg?.kind === "rgb"
			? `\x1b[38;2;${options.fg.r};${options.fg.g};${options.fg.b}m${text}\x1b[39m`
			: text,
	};
	const editorTheme = { borderColor: identity, selectList: {
		text: identity, selectedText: identity, description: identity, selectedDescription: identity, scrollIndicator: identity,
	} };
	const statuses = new Map<string, string>();
	const entries: { type: string; message?: { role: string; usage: { cost: { total: number } } } }[] = [];
	let entryReads = 0;
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } = { tokens: null, contextWindow: 200_000, percent: null };
	let editorFactory: ((...args: unknown[]) => Component) | undefined;
	const footerData = { getExtensionStatuses: () => statuses, getGitBranch: () => null, onBranchChange: () => () => {} };
	const ctx = {
		hasUI: mode === "tui" || mode === "rpc", mode, cwd: dir, model,
		get thinkingLevel() { thinkingReads++; return thinkingLevel; },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: { getEntries: () => { entryReads++; return entries; }, getSessionName: () => undefined },
		getContextUsage: () => usage, isIdle: () => idle,
		ui: {
			theme, setTheme: () => { themeChanges++; return { success: true }; },
			setWorkingVisible(visible: boolean) { chrome.push(`working:${String(visible)}`); }, setHiddenThinkingLabel() {},
			notify(message: string, level?: string) { notices.push([message, level]); },
			setTitle(title: string) { titles.push(title); },
			setFooter(factory: ((...args: unknown[]) => Component) | undefined) { chrome.push(factory ? "footer:on" : "footer:off"); footer = factory?.(tui, theme, footerData); },
			setEditorComponent(factory: ((...args: unknown[]) => Component) | undefined) {
				editorFactory = factory;
				editor = factory?.(tui, editorTheme, { matches: () => false });
			},
			getEditorComponent: () => editorFactory,
			setWidget(_key: string, factory: (() => Component) | undefined) { avatar = factory?.(); },
		},
	} as unknown as ExtensionContext;
	// The fixture's own dir has no config.json, so the developer's real file
	// cannot change the defaults these tests assert.
	const stateDir = process.env.PI_1337_STATE_DIR;
	process.env.PI_1337_STATE_DIR = dir;
	t.after(async () => {
		try { await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx); }
		finally {
			if (stateDir === undefined) delete process.env.PI_1337_STATE_DIR;
			else process.env.PI_1337_STATE_DIR = stateDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	pi1337({
		on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		registerCommand(_name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			toggle = () => command.handler("", ctx);
		},
		registerShortcut() {},
		registerToolRenderer() {},
		registerEntryRenderer(customType: string, renderer: EntryRenderer) { entryRenderers.set(customType, renderer); },
		appendEntry(customType: string, data: unknown) { appended.push({ customType, data }); },
	} as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return {
		cwd: dir,
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
		statuses,
		/** Record one assistant message's spend, as Pi appends it to the session. */
		spend(total: number) { entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total } } } }); },
		entryReads: () => entryReads,
		/** What `ctx.getContextUsage()` answers from now on. */
		setUsage(next: { tokens: number | null; contextWindow: number; percent: number | null }) { usage = next; },
		/** One UI pass: the editor renders, then the footer (Pi's layout order). */
		pass(width = 100) { const rows = editor?.render(width) ?? []; footer?.render(width); return rows; },
		text: (width = 100) => editor?.render(width).join("\n") ?? "",
		render: (width = 100) => editor?.render(width) ?? [],
		avatar: () => avatar?.render(100).join("\n") ?? "",
		toggle: () => toggle?.(),
		model,
		setThinking(level: string | undefined) { thinkingLevel = level; },
		thinkingReads: () => thinkingReads,
		notices,
		chrome,
		/** What another extension does: put its own editor (or none) in the slot. */
		installEditor(factory: (() => Component) | undefined) { (ctx.ui as unknown as { setEditorComponent(value: unknown): void }).setEditorComponent(factory); },
		hasFooter: () => footer !== undefined,
		/** A host from before `getEditorComponent` existed: nobody can say who holds the slot. */
		dropEditorGetter() { delete (ctx.ui as unknown as { getEditorComponent?: unknown }).getEditorComponent; },
		/** One event with a context of the caller's choosing. */
		emitWith: (name: string, fields: Record<string, unknown>, context: unknown) => handlers.get(name)?.({ type: name, ...fields }, context as ExtensionContext),
		handlerNames: () => [...handlers.keys()],
		titles,
		appended,
		entryRenderers,
		invalidations: () => invalidations,
		theme: theme as unknown as Theme,
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

function useFakeClock(t: TestContext): { advance(ms: number): void } {
	t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
	return { advance: ms => t.mock.timers.tick(ms) };
}

test("a tool that outlasts the grace period is named in the workspace segment until it ends", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	const workspace = basename(f.cwd);
	assert.ok(f.text().includes(workspace), "the workspace leads the status row before any tool runs");
	await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "cd /repo && npm test" } });
	assert.doesNotMatch(f.text(), /Running/, "a call younger than the grace period is not named");
	clock.advance(ACTIVITY_GRACE_MS);
	assert.match(f.text(), /Running npm test…/);
	assert.ok(!f.text().includes(workspace), "the label takes the workspace segment's place");
	assert.match(f.text(), /ctx —/, "usage keeps its place beside the label");
	await f.emit("tool_execution_start", { toolCallId: "t1/1", toolName: "bash", args: { command: "echo nested" }, parentToolCallId: "t1" });
	clock.advance(ACTIVITY_GRACE_MS);
	assert.doesNotMatch(f.text(), /echo nested|\+1/, "nested codemode calls are neither named nor counted");
	await f.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false });
	assert.doesNotMatch(f.text(), /Running/, "the label leaves with its call");
	assert.ok(f.text().includes(workspace), "and the workspace returns");
});

test("a long call's elapsed time appears after the threshold and advances with the clock", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	clock.advance(ACTIVITY_GRACE_MS);
	assert.match(f.text(), /Running npm test…/);
	assert.doesNotMatch(f.text(), /Running npm test… \d/, "a young call carries no counter");
	clock.advance(ACTIVITY_ELAPSED_MS - ACTIVITY_GRACE_MS);
	assert.match(f.text(), /Running npm test… 3s /);
	clock.advance(11_000);
	assert.match(f.text(), /Running npm test… 14s /, "the next repaint reads the advanced clock");
	clock.advance(51_000);
	assert.match(f.text(), /Running npm test… 1m 05s /);
	await f.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false });
	assert.doesNotMatch(f.text(), /Running/, "the label and its counter leave with the call");
	assert.match(f.text(), /│ Working… 1m 05s /, "and the run's own clock takes the slot back");
});

test("parallel calls name the oldest and count the rest", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "sleep 5" } });
	await f.emit("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "src/width.ts" } });
	clock.advance(ACTIVITY_GRACE_MS);
	assert.match(f.text(), /Running sleep 5… \+1/);
	await f.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", result: {}, isError: false });
	assert.match(f.text(), /Reading width\.ts…/, "the next-oldest call takes over");
	assert.doesNotMatch(f.text(), /\+1/);
});

test("a call that never reports its end cannot name the next run", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("tool_execution_start", { toolCallId: "lost", toolName: "bash", args: { command: "npm test" } });
	clock.advance(ACTIVITY_GRACE_MS);
	assert.match(f.text(), /Running npm test…/);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: true });
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(ACTIVITY_GRACE_MS);
	assert.doesNotMatch(f.text(), /Running/, "settlement dropped the orphaned call");
});

test("a blocking prompt hides the label and resuming restores it", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	clock.advance(ACTIVITY_GRACE_MS);
	await f.emit("ui_prompt_start");
	assert.doesNotMatch(f.text(), /Running/, "Pi is waiting for the user, not running");
	await f.emit("ui_prompt_end");
	assert.match(f.text(), /Running npm test…/);
});

test("PI_1337_ACTIVITY=off never names a tool", async (t) => {
	process.env.PI_1337_ACTIVITY = "off";
	t.after(() => { delete process.env.PI_1337_ACTIVITY; });
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	clock.advance(ACTIVITY_GRACE_MS);
	assert.doesNotMatch(f.text(), /Running/);
	assert.ok(f.text().includes(basename(f.cwd)), "the workspace segment stays");
});

// ---- the run clock -----------------------------------------------------------

/** The status row (the line above the bottom border), as plain text. */
const statusRow = (f: { render(width?: number): string[] }, width = 100) => f.render(width).at(-2)!.replace(/\x1b\[[0-9;]*m/g, "");

test("a run with no tool named shows Working… with its own age after three seconds, and starts no timer for it", async (t) => {
	const clock = useFakeClock(t);
	const intervals = t.mock.method(globalThis, "setInterval");
	const timeouts = t.mock.method(globalThis, "setTimeout");
	const f = await fixture(t);
	const workspace = basename(f.cwd);
	f.setIdle(false);
	await f.emit("agent_start");
	const timersAfterStart = [intervals.mock.callCount(), timeouts.mock.callCount()];
	assert.deepEqual(timersAfterStart, [1, 0], "the spinner's one interval");
	assert.ok(statusRow(f).includes(workspace), "a young run shows the workspace");
	clock.advance(RUN_CLOCK_GRACE_MS - 1);
	assert.doesNotMatch(statusRow(f), /Working/, "not before three seconds");
	const before = statusRow(f);
	clock.advance(1);
	const after = statusRow(f);
	assert.match(after, /│ Working… 3s /);
	assert.ok(!after.includes(workspace), "the clock takes the workspace segment's place");
	// The right group does not move: the same overlay mechanism as the tool label.
	const right = before.slice(before.indexOf("ctx —"));
	assert.ok(right.length > 5 && after.endsWith(right), `the right group is byte-identical: ${before} → ${after}`);
	assert.equal(after.length, before.length);
	clock.advance(42_999);
	assert.match(statusRow(f), /│ Working… 45s /, "rounded down; the next repaint reads the advanced clock");
	clock.advance(20_000);
	assert.match(statusRow(f), /│ Working… 1m 05s /);
	assert.deepEqual([intervals.mock.callCount(), timeouts.mock.callCount()], timersAfterStart, "the clock started no timer of its own");
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.doesNotMatch(statusRow(f), /Working/, "gone when the run settles");
	assert.ok(statusRow(f).includes(workspace));
	// The next run counts from its own start.
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(RUN_CLOCK_GRACE_MS - 1);
	assert.doesNotMatch(statusRow(f), /Working/);
	clock.advance(1_001);
	assert.match(statusRow(f), /│ Working… 4s /);
});

test("a tool label takes the slot after its own grace period and the clock returns with the run's whole age", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(10_000);
	assert.match(statusRow(f), /│ Working… 10s /);
	await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	clock.advance(ACTIVITY_GRACE_MS - 1);
	assert.match(statusRow(f), /│ Working… 10s /, "a call inside its grace period does not blank the slot");
	clock.advance(1);
	assert.match(statusRow(f), /│ Running npm test… /);
	assert.doesNotMatch(statusRow(f), /Working/);
	clock.advance(4_000);
	assert.match(statusRow(f), /│ Running npm test… 4s /, "the call's own age while it is named");
	await f.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false });
	assert.match(statusRow(f), /│ Working… 14s /, "the run's age, not the call's and not restarted");
	// A call shorter than its grace period never interrupts the clock.
	await f.emit("tool_execution_start", { toolCallId: "t2", toolName: "read", args: { path: "a.ts" } });
	clock.advance(20);
	assert.match(statusRow(f), /│ Working… 14s /);
	await f.emit("tool_execution_end", { toolCallId: "t2", toolName: "read", result: {}, isError: false });
	assert.match(statusRow(f), /│ Working… 14s /);
});

test("the clock is the run's: retries, a mid-run compaction and drained follow-ups keep it; only settlement ends it", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(20_000);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
	await f.emit("agent_end");
	assert.match(statusRow(f), /│ Working… 20s /, "agent_end is not settlement");
	clock.advance(5_000);
	await f.emit("agent_start"); // the auto-retry
	assert.match(statusRow(f), /│ Working… 25s /, "a continuation does not restart the clock");
	clock.advance(5_000);
	await f.emit("agent_end");
	await f.emit("session_before_compact", { reason: "threshold" });
	assert.doesNotMatch(statusRow(f), /Working/, "compaction is Pi's indicator's to announce");
	assert.match(f.text(), SPINNER, "the spinner still turns");
	clock.advance(10_000);
	assert.doesNotMatch(statusRow(f), /Working/);
	await f.emit("session_compact", { reason: "threshold" });
	await f.emit("agent_start"); // the loop resumes
	assert.match(statusRow(f), /│ Working… 40s /, "the time spent compacting is part of the run");
	clock.advance(1_000);
	await f.emit("agent_end");
	await f.emit("agent_start"); // a drained follow-up
	assert.match(statusRow(f), /│ Working… 41s /);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.doesNotMatch(statusRow(f), /Working/);
	// A failed compaction hands the slot back to the clock too.
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(6_000);
	await f.emit("session_before_compact", { reason: "threshold" });
	assert.doesNotMatch(statusRow(f), /Working/);
	await f.emit("session_compact_failed", { reason: "threshold", aborted: true });
	assert.match(statusRow(f), /│ Working… 6s /);
	// Manual compaction with no run has no clock at all.
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	await f.emit("session_before_compact", { reason: "manual" });
	clock.advance(30_000);
	assert.doesNotMatch(statusRow(f), /Working/);
	await f.emit("session_compact", { reason: "manual" });
});

test("a blocking prompt hides the clock and resuming restores it", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(8_000);
	assert.match(statusRow(f), /│ Working… 8s /);
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	assert.doesNotMatch(statusRow(f), /Working/, "Pi is waiting for the user");
	assert.ok(statusRow(f).includes(basename(f.cwd)), "the workspace is back");
	clock.advance(30_000);
	assert.doesNotMatch(statusRow(f), /Working/);
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	assert.match(statusRow(f), /│ Working… 38s /, "elapsed since the run began, the wait included");
});

test("a run that began while toggled off has no clock; one that began on keeps it across a toggle", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	await f.toggle();
	f.setIdle(false);
	await f.emit("agent_start"); // begins while off
	clock.advance(20_000);
	await f.toggle();
	assert.match(f.text(), SPINNER, "the run is live after toggling on");
	assert.doesNotMatch(statusRow(f), /Working/, "but it has no start to count from");
	clock.advance(20_000);
	await f.emit("agent_start"); // a continuation is not a start either
	assert.doesNotMatch(statusRow(f), /Working/);
	// Its tool calls are still named: only the clock needs the run's start.
	await f.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	clock.advance(ACTIVITY_GRACE_MS);
	assert.match(statusRow(f), /│ Running npm test… /);
	await f.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false });
	assert.doesNotMatch(statusRow(f), /Working|Running/);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	// The next run begins on: it has one, and a toggle mid-run does not lose it.
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(5_000);
	assert.match(statusRow(f), /│ Working… 5s /);
	await f.toggle();
	clock.advance(5_000);
	await f.toggle();
	assert.match(statusRow(f), /│ Working… 10s /);
	// A stale clock never leaks into a run that begins off.
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	await f.toggle();
	f.setIdle(false);
	await f.emit("agent_start");
	await f.toggle();
	clock.advance(60_000);
	assert.doesNotMatch(statusRow(f), /Working/);
	// A session that starts mid-run has no start to measure from.
	await f.emit("session_start", { reason: "reload" });
	clock.advance(60_000);
	assert.doesNotMatch(statusRow(f), /Working/);
});

test("a session that starts while Pi is mid-run stops the clock of the run before it", async (t) => {
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(5_000);
	assert.match(statusRow(f), /│ Working… 5s /, "the run's clock is showing");
	// A resume, fork or reload binds a new session while ctx.isIdle() is still
	// false: the run is live, but its start belongs to the session before.
	await f.emit("session_start", { reason: "resume" });
	assert.match(f.text(), SPINNER, "the run still reads as live");
	assert.doesNotMatch(statusRow(f), /Working/, "the clock is gone at once");
	clock.advance(RUN_CLOCK_GRACE_MS + 1_000);
	assert.doesNotMatch(statusRow(f), /Working/, "and does not come back counting from the old start");
	assert.ok(statusRow(f).includes(basename(f.cwd)), "the workspace keeps its place");
});

test("PI_1337_ACTIVITY=off hides the run clock together with the tool label", async (t) => {
	process.env.PI_1337_ACTIVITY = "off";
	t.after(() => { delete process.env.PI_1337_ACTIVITY; });
	const clock = useFakeClock(t);
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	clock.advance(60_000);
	assert.doesNotMatch(statusRow(f), /Working/);
	assert.ok(statusRow(f).includes(basename(f.cwd)), "the workspace segment stays");
	assert.match(f.text(), SPINNER);
});

test("the run clock never reaches the terminal title", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	t.mock.timers.tick(45_000);
	f.pass();
	await Promise.resolve();
	assert.match(statusRow(f), /│ Working… 45s /);
	assert.deepEqual(f.titles, [`● Working — ${basename(f.cwd)}`], "one write at run start; no counter in the tab");
});

test("a thinking_level_select event repaints the top border with the new level, read from cache", async (t) => {
	const f = await fixture(t);
	f.model.reasoning = true;
	const top = () => f.render()[0];
	assert.match(top(), / test\/test-model ──╮$/, "no level is known yet");
	const renders = f.renders();
	await f.emit("thinking_level_select", { level: "high", previousLevel: "off" });
	assert.ok(f.renders() > renders, "the event requests a repaint");
	assert.match(top(), / test\/test-model · high ──╮$/);
	assert.doesNotMatch(f.render().slice(1).join("\n"), /high|test-model/, "the level and model live in the border only");
	await f.emit("thinking_level_select", { level: "off", previousLevel: "high" });
	assert.match(top(), / test\/test-model ──╮$/, "off shows nothing");
	// A model switch clamps the level before model_select fires; the refresh re-reads it.
	f.setThinking("minimal");
	await f.emit("model_select", { model: f.model, source: "set" });
	assert.match(top(), / test\/test-model · minimal ──╮$/);
	const reads = f.thinkingReads();
	for (let i = 0; i < 5; i++) f.text();
	assert.equal(f.thinkingReads(), reads, "renders never read the host's level");
	// Toggled off, the cache is dropped; toggling on reads the current level again.
	await f.toggle();
	f.setThinking("xhigh");
	await f.emit("thinking_level_select", { level: "xhigh", previousLevel: "minimal" });
	await f.toggle();
	assert.match(top(), / test\/test-model · xhigh ──╮$/);
	f.model.reasoning = false;
	assert.match(top(), / test\/test-model ──╮$/, "a model that does not reason shows no level");
});

test("no agent count ever appears, with or without pi-persona's persona-agents status", async (t) => {
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	for (const agents of [undefined, "0", "1", "3", "12 agents"]) {
		if (agents === undefined) f.statuses.delete("persona-agents");
		else f.statuses.set("persona-agents", agents);
		f.statuses.set("persona", "Elite");
		await f.emit("tool_execution_start", { toolCallId: `d-${agents}`, toolName: "delegate", args: { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] } });
		for (const width of [60, 100, 200]) {
			const text = f.pass(width).join("\n");
			assert.doesNotMatch(text, /\bagents?\b/, `persona-agents=${agents} @${width}`);
			assert.match(text, /Elite/, "the persona label is still read");
		}
	}
});

test("a persona-cost change while idle updates the cost on the next render, without an event or a session walk", async (t) => {
	const f = await fixture(t);
	f.spend(0.5);
	await f.emit("turn_end");
	assert.match(f.text(), /~\$0\.500/);
	const reads = f.entryReads();
	const renders = f.renders();
	f.statuses.set("persona-cost", "~$1.24");
	f.pass(); // the editor paints first; the footer then notices the change
	await Promise.resolve();
	assert.ok(f.renders() > renders, "the change requests one more repaint");
	assert.match(f.text(), /~\$1\.74/, "the cached session sum plus the new persona-cost");
	f.statuses.set("persona-cost", "$0.10");
	f.pass();
	assert.match(f.text(), /~\$0\.600/);
	f.statuses.delete("persona-cost");
	f.pass();
	assert.match(f.text(), /~\$0\.500/);
	for (let i = 0; i < 10; i++) f.pass();
	await Promise.resolve();
	assert.equal(f.entryReads(), reads, "no render walks the session");
	const quiet = f.renders();
	f.pass();
	await Promise.resolve();
	assert.equal(f.renders(), quiet, "an unchanged status requests nothing");
});

test("the run delta appears after agent_start and spend, survives settlement, and resets on the next run or session", async (t) => {
	for (const persona of [false, true]) {
		const f = await fixture(t);
		if (persona) f.statuses.set("persona", "Elite");
		f.spend(10);
		await f.emit("turn_end");
		assert.match(f.text(200), /~\$10\.00/);
		assert.doesNotMatch(f.text(200), /\+\$/, "a resumed or idle session shows no delta");
		f.setIdle(false);
		await f.emit("agent_start");
		assert.doesNotMatch(f.text(200), /\+\$/, "the run starts at zero");
		f.spend(0.004);
		await f.emit("turn_end");
		assert.doesNotMatch(f.text(200), /\+\$/, "below a printable cent");
		f.spend(1.236);
		await f.emit("turn_end");
		assert.match(f.text(200), /~\$11\.24 \+\$1\.24/);
		if (persona) {
			f.statuses.set("persona-cost", "~$0.50");
			f.pass(200);
			assert.match(f.text(200), /~\$11\.74 \+\$1\.74 · Elite/, "a background leg's spend joins the run");
			f.statuses.delete("persona-cost");
			f.pass(200);
		}
		f.setIdle(true);
		await f.emit("agent_end");
		await f.emit("agent_settled", {});
		assert.match(f.text(200), /~\$11\.24 \+\$1\.24/, "the delta stays after the run settles");
		f.setIdle(false);
		await f.emit("agent_start");
		assert.doesNotMatch(f.text(200), /\+\$/, "the next run clears it");
		f.spend(2);
		await f.emit("agent_end");
		assert.match(f.text(200), /\+\$2\.00/);
		await f.emit("session_start", { reason: "resume" });
		assert.doesNotMatch(f.text(200), /\+\$/, "a session switch clears it");
		assert.match(f.text(200), /~\$13\.24/);
	}
});

test("a tool call shows the context and cost of the response that launched it: one session walk, no repaint request", async (t) => {
	const f = await fixture(t);
	const bash = (toolCallId: string, extra: Record<string, unknown> = {}) =>
		f.emit("tool_execution_start", { toolCallId, toolName: "bash", args: { command: "npm test" }, ...extra });
	f.spend(10);
	f.setIdle(false);
	await f.emit("agent_start");
	assert.match(f.text(200), /ctx — · ~\$10\.00 /);

	// The response that asks for the call. Pi appends it to the session only after
	// its message_end listeners have returned, so nothing is read here.
	const reads = f.entryReads();
	await f.emit("message_end", { message: { role: "assistant", usage: { output: 120 } } });
	assert.equal(f.entryReads(), reads, "message_end walks nothing: the message is not in the session yet");
	f.spend(1.5);
	f.setUsage({ tokens: 50_000, contextWindow: 200_000, percent: 25 });
	assert.match(f.text(200), /ctx — · ~\$10\.00 /, "the row still shows the figures from before the response");

	// A nested (codemode) call is no row of its own and refreshes nothing.
	await bash("p/1", { parentToolCallId: "p" });
	assert.equal(f.entryReads(), reads);
	const renders = f.renders();
	await bash("a");
	assert.equal(f.entryReads(), reads + 1, "the first top-level call refreshes, once");
	assert.equal(f.renders(), renders, "no repaint is requested: the spinner's own carries it");
	assert.match(f.text(200), /50\.0k\/200k · 25% · ~\$11\.50 \+\$1\.50 /, "fresh tokens, total and run delta while the call runs");
	await bash("b"); // a parallel sibling of the same response
	assert.equal(f.entryReads(), reads + 1, "one walk per assistant message, however many calls it launched");

	// Only an assistant message arms it: tool results and user messages change no usage.
	await f.emit("message_end", { message: { role: "toolResult" } });
	await f.emit("message_end", { message: { role: "user" } });
	await f.emit("message_end", {});
	await bash("c");
	assert.equal(f.entryReads(), reads + 1);

	// The baseline is the run's: the refresh moved the total, not where the delta counts from.
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.match(f.text(200), /~\$11\.50 \+\$1\.50 /);
	await f.emit("message_end", { message: { role: "assistant" } });
	f.spend(0.25);
	await bash("d");
	assert.match(f.text(200), /~\$11\.75 \+\$1\.75 /, "the next response adds to the same run");

	// Toggled off there is no row to keep fresh: nothing is walked.
	await f.emit("message_end", { message: { role: "assistant" } });
	await f.toggle();
	const off = f.entryReads();
	await bash("e");
	assert.equal(f.entryReads(), off, "no session walk while the redesign is off");
});

for (const mode of ["rpc", "json", "print"] as const) {
	test(`${mode} mode: the in-turn stats refresh does nothing outside the TUI`, async (t) => {
		const f = await fixture(t, mode);
		const bash = (toolCallId: string) => f.emit("tool_execution_start", { toolCallId, toolName: "bash", args: { command: "npm test" } });
		f.spend(10);
		f.setIdle(false);
		await f.emit("agent_start");
		const reads = f.entryReads();
		const thinking = f.thinkingReads();
		assert.equal(reads, 0, "no chrome, so nothing has walked the session at all");
		// The same sequence that refreshes once in the TUI: an assistant message, then the call it launched.
		await f.emit("message_end", { message: { role: "assistant", usage: { output: 120 } } });
		f.spend(1.5);
		f.setUsage({ tokens: 50_000, contextWindow: 200_000, percent: 25 });
		await bash("a");
		await bash("b");
		await f.emit("message_end", { message: { role: "assistant" } });
		await bash("c");
		assert.equal(f.entryReads(), reads, "no session walk");
		assert.equal(f.thinkingReads(), thinking, "no thinking-level read");
		assert.equal(f.renders(), 0, "no repaint request");
		assert.equal(f.text(200), "", "and no editor of ours to show it in");
	});
}

test("the /theme-1337 toggle names the package in its info notice", async (t) => {
	const f = await fixture(t);
	await f.toggle();
	await f.toggle();
	assert.deepEqual(f.notices, [["pi-theme-1337 off", "info"], ["pi-theme-1337 on", "info"]]);
});

for (const [setting, width, expected] of [[undefined, 200, 100], ["60", 100, 60], ["full", 200, 196], ["0", 200, 196], ["12", 100, 40], ["wide", 200, 100]] as const) {
	test(`PI_1337_MAX_WIDTH=${setting ?? "(unset)"} reaches the framed editor's box width`, async (t) => {
		const previous = process.env.PI_1337_MAX_WIDTH;
		if (setting === undefined) delete process.env.PI_1337_MAX_WIDTH;
		else process.env.PI_1337_MAX_WIDTH = setting;
		t.after(() => {
			if (previous === undefined) delete process.env.PI_1337_MAX_WIDTH;
			else process.env.PI_1337_MAX_WIDTH = previous;
		});
		const f = await fixture(t);
		const top = f.render(width)[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
		assert.match(top, /^╭─{2,} test\/test-model ──╮$/);
		assert.equal(top.length, expected);
	});
}

// ---- end-of-run summary entry and terminal title ----------------------------

/** Set (or unset) environment variables for one test, read by the extension at load. */
function withEnv(t: TestContext, values: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(values)) {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const PATCH = "--- src/a.ts\n+++ src/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n";

/** One run that edits, writes from a script, and runs a failing command. */
async function toolRun(f: Fixture, aborted = false) {
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("tool_execution_start", { toolCallId: "e", toolName: "edit", args: { path: join(f.cwd, "src/a.ts") } });
	await f.emit("tool_execution_end", { toolCallId: "e", toolName: "edit", result: { content: [], details: { diff: "", patch: PATCH } }, isError: false });
	await f.emit("tool_execution_start", { toolCallId: "s", toolName: "codemode", args: {} });
	await f.emit("tool_execution_start", { toolCallId: "w", toolName: "write", args: { path: "notes.md", content: "a\nb\n" }, parentToolCallId: "s" });
	await f.emit("tool_execution_end", { toolCallId: "w", toolName: "write", result: { content: [] }, isError: false, parentToolCallId: "s" });
	await f.emit("tool_execution_end", { toolCallId: "s", toolName: "codemode", result: { content: [] }, isError: false });
	await f.emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "npm test" } });
	await f.emit("tool_execution_end", { toolCallId: "b", toolName: "bash", result: { content: [] }, isError: true });
	f.spend(1.236);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted });
}

test("a run that used tools appends one summary entry with its numbers; a chat-only run appends none", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	t.mock.timers.tick(134_000);
	await f.emit("tool_execution_start", { toolCallId: "e", toolName: "edit", args: { path: join(f.cwd, "src/a.ts") } });
	await f.emit("tool_execution_end", { toolCallId: "e", toolName: "edit", result: { content: [], details: { diff: "", patch: PATCH } }, isError: false });
	f.spend(1.236);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 1);
	assert.equal(f.appended[0]!.customType, "pi1337-run-summary");
	assert.deepEqual(f.appended[0]!.data, {
		v: 1, outcome: "done", durationMs: 134_000, edited: 1, added: 2, removed: 1, wrote: 0,
		commands: 0, commandsFailed: 0, tools: 1, toolsFailed: 0, cost: 1.236,
		files: [{ path: "src/a.ts", kind: "edit", added: 2, removed: 1, lines: 0, script: false }], moreFiles: 0,
	});

	await toolRun(f);
	const data = f.appended[1]!.data as Record<string, unknown>;
	assert.deepEqual([data.edited, data.wrote, data.commands, data.commandsFailed, data.tools, data.toolsFailed], [1, 1, 1, 1, 4, 1]);
	assert.deepEqual((data.files as { path: string; script: boolean }[]).map(file => [file.path, file.script]), [["src/a.ts", false], ["notes.md", true]]);

	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 2, "a chat-only reply gets no row");
	await f.emit("agent_start");
	await f.emit("agent_settled", { aborted: true });
	assert.equal((f.appended[2]!.data as { outcome: string }).outcome, "interrupted", "an interrupted run always gets one");
	await f.emit("agent_start");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
	await f.emit("agent_settled", { aborted: false });
	assert.equal((f.appended[3]!.data as { outcome: string }).outcome, "failed");
});

// Pi 1.5.2 re-enters its agent loop inside one run — after an auto-retry, a
// mid-run compaction, or drained steering/follow-ups — and each re-entry emits
// agent_start again; agent_settled fires once, at the very end.
const editCall = async (f: Fixture, id: string, path = "src/a.ts") => {
	await f.emit("tool_execution_start", { toolCallId: id, toolName: "edit", args: { path: join(f.cwd, path) } });
	await f.emit("tool_execution_end", { toolCallId: id, toolName: "edit", result: { content: [], details: { diff: "", patch: PATCH } }, isError: false });
};
const bashCall = async (f: Fixture, id: string) => {
	await f.emit("tool_execution_start", { toolCallId: id, toolName: "bash", args: { command: "npm test" } });
	await f.emit("tool_execution_end", { toolCallId: id, toolName: "bash", result: { content: [] }, isError: false });
};

test("a retried run keeps the tools from before the retry in its one summary row", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await editCall(f, "e");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
	await f.emit("agent_end");
	t.mock.timers.tick(4_000);
	await f.emit("agent_start"); // the auto-retry
	t.mock.timers.tick(6_000);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 1);
	const data = f.appended[0]!.data as Record<string, unknown>;
	assert.deepEqual([data.outcome, data.durationMs, data.edited, data.added, data.removed, data.tools], ["done", 10_000, 1, 2, 1, 1]);
});

test("a continuation with tools on both sides is one row with the sums, the whole wall time and the whole spend", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	f.spend(10);
	await f.emit("turn_end");
	f.setIdle(false);
	await f.emit("agent_start");
	await editCall(f, "e");
	f.spend(1);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	assert.match(f.text(200), /~\$11\.00 \+\$1\.00/);
	t.mock.timers.tick(10_000);
	await f.emit("session_before_compact");
	await f.emit("session_compact");
	await f.emit("agent_start"); // the loop resumes after the mid-run compaction
	assert.match(f.text(200), /~\$11\.00 \+\$1\.00/, "the continuation keeps the run's baseline");
	await bashCall(f, "b");
	f.spend(2);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	t.mock.timers.tick(5_000);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.match(f.text(200), /~\$13\.00 \+\$3\.00/, "the delta spans the whole run");
	assert.equal(f.appended.length, 1);
	const data = f.appended[0]!.data as Record<string, unknown>;
	assert.deepEqual([data.durationMs, data.edited, data.commands, data.tools, data.cost], [15_000, 1, 1, 2, 3]);
});

test("a follow-up drained mid-run joins the run; two genuinely separate runs get two rows", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	await editCall(f, "e");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	await f.emit("agent_end");
	t.mock.timers.tick(3_000);
	await f.emit("agent_start"); // a queued follow-up (e.g. a pi-persona wake): chat only
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	t.mock.timers.tick(2_000);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 1);
	assert.deepEqual([(f.appended[0]!.data as { tools: number }).tools, (f.appended[0]!.data as { durationMs: number }).durationMs], [1, 5_000]);

	f.spend(1);
	f.setIdle(false);
	await f.emit("agent_start");
	await bashCall(f, "b");
	f.spend(2);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	t.mock.timers.tick(7_000);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 2, "a new run after settlement is a new row");
	const second = f.appended[1]!.data as Record<string, unknown>;
	assert.deepEqual([second.durationMs, second.edited, second.commands, second.tools, second.cost], [7_000, 0, 1, 1, 2]);
	assert.match(f.text(200), /\+\$2\.00/, "the delta restarts with the new run");
});

test("a run started while toggled off has no baseline: no delta and no cost after toggling on", async (t) => {
	const f = await fixture(t);
	f.spend(5);
	await f.emit("turn_end");
	f.setIdle(false);
	await f.emit("agent_start"); // run 1 takes a baseline of $5
	f.spend(1);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.match(f.text(200), /~\$6\.00 \+\$1\.00/);
	await f.toggle();
	f.setIdle(false);
	await f.emit("agent_start"); // run 2 starts while off
	f.spend(2);
	await f.toggle();
	assert.match(f.text(200), /~\$8\.00/);
	assert.doesNotMatch(f.text(200), /\+\$/, "never a stale delta from the previous run");
	await bashCall(f, "b");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.doesNotMatch(f.text(200), /\+\$/);
	assert.equal(f.appended.length, 1, "run 1 was chat-only");
	assert.equal((f.appended[0]!.data as { cost: number }).cost, 0, "the summary omits a cost it could not measure");
});

test("no summary entry while toggled off or with PI_1337_SUMMARY=off; none outside TUI mode", async (t) => {
	const f = await fixture(t);
	await f.toggle();
	await toolRun(f);
	assert.equal(f.appended.length, 0, "toggled off");
	await f.toggle();
	await toolRun(f);
	assert.equal(f.appended.length, 1, "toggled back on");

	for (const mode of ["rpc", "json", "print"] as const) {
		const other = await fixture(t, mode);
		await toolRun(other);
		assert.equal(other.appended.length, 0, mode);
	}

	withEnv(t, { PI_1337_SUMMARY: "off" });
	const off = await fixture(t);
	await toolRun(off);
	assert.equal(off.appended.length, 0);
	assert.equal(off.entryRenderers.size, 0, "off registers no renderer, so existing rows stay hidden");
});

test("the entry renderer paints a row while on and nothing while toggled off, in Pi's real entry component", async (t) => {
	initTheme("dark", false); // Pi hands its global theme to entry renderers
	const f = await fixture(t);
	await toolRun(f);
	const renderer = f.entryRenderers.get("pi1337-run-summary");
	assert.ok(renderer, "registered at load");
	const entry = { type: "custom", customType: "pi1337-run-summary", data: f.appended[0]!.data, id: "x", parentId: null, timestamp: "" } as const;
	const row = new CustomEntryComponent(entry as never, renderer as never);
	const shown = row.render(120).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.equal(shown[0], "", "Pi's spacer");
	assert.match(shown[1]!, /^ ● Done in \S+ · edited 1 file \+2 −1 · wrote 1 file · 1 command, 1 failed · ~\$1\.24 \((\S+ )?to expand\)$/, "the host's own expand hint (no key bound in this fixture)");
	assert.match(row.render(shown[1]!.length).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))[1]!, /· 1 command, 1 failed · ~\$1\.24$/, "the hint goes first when narrowing");
	row.setExpanded(true);
	assert.doesNotMatch(row.render(120).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))[1]!, /expand/, "expanded: no hint");
	assert.deepEqual(row.render(120).slice(2).map(line => line.replace(/\x1b\[[0-9;]*m/g, "")), ["   src/a.ts +2 −1", "   notes.md wrote 2 lines (script)"]);

	const before = f.invalidations();
	await f.toggle();
	assert.ok(f.invalidations() > before, "toggle-off invalidates the transcript");
	row.invalidate(); // what the TUI's invalidate does to every transcript row
	assert.deepEqual(row.render(120), [], "the row and its spacer disappear");
	assert.equal(renderer(entry as never, { expanded: false, keyText: () => "", keyHint: () => "" }, f.theme), undefined);
	const off = f.invalidations();
	await f.toggle();
	assert.ok(f.invalidations() > off, "toggle-on invalidates the transcript");
	row.invalidate();
	assert.equal(row.render(120).length, 4, "the row comes back, still expanded");
	assert.equal(renderer({ ...entry, data: { v: 99 } } as never, { expanded: false, keyText: () => "", keyHint: () => "" }, f.theme), undefined, "foreign data renders nothing");
});

test("the title follows a run: working, the named call after its grace period, done, then Pi's own", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await fixture(t);
	const where = basename(f.cwd);
	assert.deepEqual(f.titles, [], "startup leaves Pi's own title alone");
	f.setIdle(false);
	await f.emit("agent_start");
	assert.deepEqual(f.titles, [`● Working — ${where}`]);
	await f.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "npm test" } });
	f.pass();
	await Promise.resolve();
	assert.equal(f.titles.length, 1, "a call inside its grace period is not named");
	t.mock.timers.tick(ACTIVITY_GRACE_MS + 10);
	f.pass();
	assert.equal(f.titles.length, 1, "no setTitle inside a render");
	await Promise.resolve();
	assert.equal(f.titles.at(-1), `● Running npm test… — ${where}`);
	for (let i = 0; i < 5; i++) f.pass();
	await Promise.resolve();
	assert.equal(f.titles.length, 2, "an unchanged title is not rewritten");
	await f.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false });
	f.pass();
	await Promise.resolve();
	assert.equal(f.titles.at(-1), `● Working — ${where}`);
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	assert.equal(f.titles.at(-1), `? Waiting for you — ${where}`);
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	assert.equal(f.titles.at(-1), `● Working — ${where}`);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.titles.at(-1), `✓ Done — ${where}`);
	await f.emit("session_info_changed", { name: "fold tallies" });
	assert.equal(f.titles.at(-1), "✓ Done — fold tallies", "re-applied after Pi rewrote its own title");
	await f.emit("input", { text: "next", source: "interactive" });
	assert.equal(f.titles.at(-1), `π - fold tallies - ${where}`, "user input ends the after-run title");
	await f.emit("agent_start");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.titles.at(-1), "✗ Failed — fold tallies");
	await f.emit("agent_start");
	assert.equal(f.titles.at(-1), "● Working — fold tallies", "the next run replaces the after-run title");
	await f.emit("agent_settled", { aborted: true });
	assert.equal(f.titles.at(-1), `π - fold tallies - ${where}`, "an interrupted run goes straight back to Pi's own");
	assert.ok(f.titles.every((title, i) => i === 0 || title !== f.titles[i - 1]), "no title is written twice in a row");
});

test("phase events re-assert an unchanged title over Pi's own refresh; continuations and repeats in between stay deduplicated", async (t) => {
	const f = await fixture(t);
	const working = `● Working — ${basename(f.cwd)}`;
	const waiting = `? Waiting for you — ${basename(f.cwd)}`;
	// Manual compaction already reads as working; the run that follows still re-asserts it.
	await f.emit("session_before_compact");
	assert.deepEqual(f.titles, [working]);
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("session_compact");
	assert.deepEqual(f.titles, [working, working], "run start");
	await f.emit("agent_start"); // a continuation inside the same run
	assert.deepEqual(f.titles, [working, working], "a continuation is not a phase");
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" }); // a second dialog
	assert.deepEqual(f.titles.slice(2), [waiting, waiting], "prompt start");
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	assert.deepEqual(f.titles.slice(4), [working, working], "prompt end");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	assert.equal(f.titles.length, 6, "in-between events never rewrite an unchanged title");
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: true });
	await f.emit("agent_start");
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	await f.emit("agent_settled", { aborted: true }); // the dialog outlives the run
	assert.deepEqual(f.titles.slice(6), [`π - ${basename(f.cwd)}`, working, waiting, waiting], "run end");
});

test("toggle-off and shutdown leave Pi's own title exactly once; toggled off, runs never touch it", async (t) => {
	const f = await fixture(t);
	const fallback = `π - ${basename(f.cwd)}`;
	await toolRun(f);
	assert.equal(f.titles.at(-1), `✓ Done — ${basename(f.cwd)}`);
	await f.toggle();
	assert.equal(f.titles.at(-1), fallback);
	assert.equal(f.titles.filter(title => title === fallback).length, 1);
	const count = f.titles.length;
	await toolRun(f);
	await f.emit("session_shutdown");
	assert.equal(f.titles.length, count, "nothing more while off, and shutdown has nothing to restore");

	const g = await fixture(t);
	g.setIdle(false);
	await g.emit("agent_start");
	await g.emit("session_shutdown");
	assert.deepEqual(g.titles, [`● Working — ${basename(g.cwd)}`, `π - ${basename(g.cwd)}`], "shutdown mid-run restores Pi's title once");
});

test("PI_1337_TITLE=off never calls setTitle", async (t) => {
	withEnv(t, { PI_1337_TITLE: "off" });
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await fixture(t);
	await f.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "npm test" } });
	t.mock.timers.tick(ACTIVITY_GRACE_MS + 10);
	f.pass();
	await Promise.resolve();
	await toolRun(f);
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	await f.emit("session_info_changed", { name: "x" });
	await f.toggle();
	await f.toggle();
	await f.emit("session_shutdown");
	assert.deepEqual(f.titles, []);
});

test("RPC and print modes never set the title", async (t) => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const f = await fixture(t, mode);
		await toolRun(f);
		await f.emit("session_shutdown");
		assert.deepEqual(f.titles, [], mode);
	}
});

// ---- background work still running (pi-persona's persona-background status) ----

const BACKGROUND = "persona-background";
const entryOptions = { expanded: false, keyText: () => "", keyHint: () => "" };
/** The row Pi would paint for an appended entry, through the registered renderer. */
function summaryLines(f: Fixture, data: unknown, expanded = false, width = 200): string[] {
	const renderer = f.entryRenderers.get("pi1337-run-summary")!;
	const row = renderer({ type: "custom", customType: "pi1337-run-summary", data } as never, { ...entryOptions, expanded }, f.theme);
	return row?.render(width) ?? [];
}
/** A clean run of `calls` read calls. */
async function readRun(f: Fixture, calls: number, outcome: { aborted?: boolean; stopReason?: string } = {}) {
	f.setIdle(false);
	await f.emit("agent_start");
	for (let i = 0; i < calls; i++) {
		await f.emit("tool_execution_start", { toolCallId: `r${i}`, toolName: "read", args: { path: `src/${i}.ts` } });
		await f.emit("tool_execution_end", { toolCallId: `r${i}`, toolName: "read", result: { content: [] }, isError: false });
	}
	await f.emit("turn_end", { message: { role: "assistant", stopReason: outcome.stopReason ?? "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: outcome.aborted ?? false });
}

test("a run that settles while background work is running records the snapshot and does not say Done", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	f.statuses.set(BACKGROUND, "agents=3 monitors=1 timers=1 scripts=1");
	f.setIdle(false);
	await f.emit("agent_start");
	for (let i = 0; i < 7; i++) {
		await f.emit("tool_execution_start", { toolCallId: `r${i}`, toolName: "read", args: { path: `src/${i}.ts` } });
		await f.emit("tool_execution_end", { toolCallId: `r${i}`, toolName: "read", result: { content: [] }, isError: false });
	}
	f.spend(0.08);
	t.mock.timers.tick(9_000);
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 1);
	assert.deepEqual(f.appended[0]!.data, {
		v: 1, outcome: "done", durationMs: 9_000, edited: 0, added: 0, removed: 0, wrote: 0,
		commands: 0, commandsFailed: 0, tools: 7, toolsFailed: 0, cost: 0.08, files: [], moreFiles: 0,
		waiting: { agents: 3, monitors: 1, timers: 1, scripts: 1 },
	});
	assert.deepEqual(summaryLines(f, f.appended[0]!.data), [" ● Turn ended in 9.0s · 7 tool calls · ~$0.08 · waiting on 3 agents, 1 monitor, 1 timer, 1 script"]);
	// It is a snapshot: the row keeps saying what was outstanding then.
	f.statuses.delete(BACKGROUND);
	assert.match(summaryLines(f, f.appended[0]!.data)[0]!, /waiting on 3 agents, 1 monitor, 1 timer, 1 script$/);
	// Nothing about background work ever enters the editor's status row.
	f.statuses.set(BACKGROUND, "agents=3 monitors=1 timers=1 scripts=1");
	for (const width of [60, 100, 200]) {
		assert.doesNotMatch(f.pass(width).join("\n"), /agents?|monitor|timer|script|background|[Ww]aiting/, `@${width}`);
	}
	// Interrupted and failed runs keep their outcome and carry the same snapshot.
	f.statuses.set(BACKGROUND, "agents=1");
	await readRun(f, 1, { aborted: true });
	assert.deepEqual([(f.appended[1]!.data as RunData).outcome, (f.appended[1]!.data as RunData).waiting], ["interrupted", { agents: 1, monitors: 0, timers: 0, scripts: 0 }]);
	assert.match(summaryLines(f, f.appended[1]!.data)[0]!, /^ ● Interrupted after \S+ · 1 tool call · waiting on 1 agent$/);
	await readRun(f, 0, { stopReason: "error" });
	assert.equal((f.appended[2]!.data as RunData).outcome, "failed");
	assert.match(summaryLines(f, f.appended[2]!.data)[0]!, /^ ● Failed after \S+ · waiting on 1 agent$/);
	// When a row is written is unchanged: a chat-only reply gets none, background work or not.
	await readRun(f, 0);
	assert.equal(f.appended.length, 3);
});
type RunData = { outcome: string; waiting?: unknown; modelMs?: number; outputTokens?: number; durationMs: number };

test("a status that does not parse is no background work: today's row, today's title", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 }); // every run below lasts exactly 0 ms
	const f = await fixture(t);
	const where = basename(f.cwd);
	const malformed = [
		"agents=0", "3 agents", "agents=3 agents=1", "monitors=1 agents=1", "agents=3 ", "agents=3,timers=1", "agents=10000",
		"tasks=3", "\x1b]0;pwned\x07agents=3", "agents=3\x1b[31m", "‮agents=3",
	];
	for (const [index, status] of malformed.entries()) {
		f.statuses.set(BACKGROUND, status);
		await readRun(f, 2);
		const data = f.appended[index]!.data as RunData;
		assert.ok(!("waiting" in (data as object)), JSON.stringify(status));
		assert.deepEqual(summaryLines(f, data), [" ● Done in 0ms · 2 tool calls"], JSON.stringify(status));
		assert.equal(f.titles.at(-1), `✓ Done — ${where}`, JSON.stringify(status));
		f.pass();
		await Promise.resolve();
	}
	assert.ok(f.titles.every(title => !/pwned|agents|\x1b|‮/.test(title)), "nothing unparsed reaches the title");
	// Without pi-persona there is no status at all.
	f.statuses.delete(BACKGROUND);
	await readRun(f, 2);
	assert.ok(!("waiting" in (f.appended.at(-1)!.data as object)));
	assert.equal(f.titles.at(-1), `✓ Done — ${where}`);
});

test("after a clean run the title waits on the background work, follows the status, and is Done when it clears", async (t) => {
	const f = await fixture(t);
	const where = basename(f.cwd);
	f.statuses.set(BACKGROUND, "agents=3");
	f.setIdle(false);
	await f.emit("agent_start");
	f.pass();
	await Promise.resolve();
	assert.deepEqual(f.titles, [`● Working — ${where}`], "a run in progress is still working, whatever runs behind it");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	const intervals = t.mock.method(globalThis, "setInterval");
	const timeouts = t.mock.method(globalThis, "setTimeout");
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 0, "a chat-only run gets no row");
	assert.equal(f.titles.at(-1), `◌ Waiting on 3 agents — ${where}`, "but its title does not claim Done");
	let count = f.titles.length;
	const settle = async (status: string | undefined) => {
		if (status === undefined) f.statuses.delete(BACKGROUND);
		else f.statuses.set(BACKGROUND, status);
		count = f.titles.length;
		f.pass(); // the footer notices the change during the render pass…
		assert.equal(f.titles.length, count, "…and never calls setTitle inside it");
		await Promise.resolve();
		return f.titles.at(-1);
	};
	assert.equal(await settle("agents=3"), `◌ Waiting on 3 agents — ${where}`);
	assert.equal(f.titles.length, count, "an unchanged status writes nothing");
	assert.equal(await settle("agents=2 timers=1"), `◌ Waiting on 3 background tasks — ${where}`);
	assert.equal(await settle("agents=1"), `◌ Waiting on 1 agent — ${where}`);
	assert.equal(await settle("agents=1 monitors=1 timers=1 scripts=2"), `◌ Waiting on 5 background tasks — ${where}`);
	assert.equal(await settle("scripts=1"), `◌ Waiting on 1 script — ${where}`);
	assert.equal(await settle("scripts=lots"), `✓ Done — ${where}`, "a status that stops parsing is no background work");
	assert.equal(await settle("timers=2"), `◌ Waiting on 2 timers — ${where}`, "work that appears while idle is waited on too");
	await f.emit("session_info_changed", { name: "fold tallies" });
	assert.equal(f.titles.at(-1), "◌ Waiting on 2 timers — fold tallies", "re-applied after Pi rewrote its own title");
	assert.equal(await settle(undefined), "✓ Done — fold tallies", "cleared without a new run: now it is done");
	for (let i = 0; i < 5; i++) f.pass();
	await Promise.resolve();
	assert.equal(f.titles.length, count + 1, "and nothing more is written");
	assert.deepEqual([intervals.mock.callCount(), timeouts.mock.callCount()], [0, 0], "following the status starts no timer");
	assert.ok(f.titles.every((title, i) => i === 0 || title !== f.titles[i - 1]), "no title is written twice in a row");
	// User input ends the after-run title; the status no longer matters.
	await f.emit("input", { text: "next", source: "interactive" });
	assert.equal(f.titles.at(-1), `π - fold tallies - ${where}`);
	assert.equal(await settle("agents=4"), `π - fold tallies - ${where}`);
	assert.equal(f.titles.length, count, "idle: Pi's own title, untouched");
});

test("only a clean run waits: failed says Failed, interrupted is Pi's own, and toggling off restores Pi's title once", async (t) => {
	const f = await fixture(t);
	const where = basename(f.cwd);
	f.statuses.set(BACKGROUND, "agents=2");
	await readRun(f, 1, { stopReason: "error" });
	assert.equal(f.titles.at(-1), `✗ Failed — ${where}`);
	await readRun(f, 1, { aborted: true });
	assert.equal(f.titles.at(-1), `π - ${where}`);
	await readRun(f, 1);
	assert.equal(f.titles.at(-1), `◌ Waiting on 2 agents — ${where}`);
	await f.toggle();
	assert.equal(f.titles.at(-1), `π - ${where}`, "clear() leaves Pi's default");
	const count = f.titles.length;
	f.statuses.set(BACKGROUND, "agents=1");
	f.pass();
	await Promise.resolve();
	await f.toggle();
	f.pass();
	await Promise.resolve();
	assert.equal(f.titles.length, count, "toggled back on, the after-run state is gone: nothing to re-assert");
	await f.emit("session_shutdown");
	assert.equal(f.titles.length, count);

	withEnv(t, { PI_1337_TITLE: "off" });
	const off = await fixture(t);
	off.statuses.set(BACKGROUND, "agents=2");
	await readRun(off, 1);
	off.statuses.delete(BACKGROUND);
	off.pass();
	await Promise.resolve();
	assert.deepEqual(off.titles, [], "PI_1337_TITLE=off never calls setTitle");
	assert.deepEqual((off.appended[0]!.data as RunData).waiting, { agents: 2, monitors: 0, timers: 0, scripts: 0 }, "the summary row is its own toggle");
});

// ---- run timing in the summary entry -----------------------------------------

test("the entry records model time and output tokens over the whole run, continuations included", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	const assistant = (output: number, stopReason = "toolUse") =>
		({ role: "assistant", content: [], stopReason, usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output } });
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await f.emit("message_start", { message: { role: "user", content: "go" } });
	await f.emit("message_end", { message: { role: "user", content: "go" } });
	t.mock.timers.tick(30_000);
	await f.emit("message_end", { message: assistant(1_000) }); // 30 s of model time
	await f.emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "npm test" } });
	t.mock.timers.tick(10_000);
	await f.emit("tool_execution_end", { toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false });
	await f.emit("message_end", { message: { role: "toolResult", content: [] } });
	await f.emit("turn_end", { message: assistant(1_000) });
	await f.emit("agent_end");
	t.mock.timers.tick(2_000);
	await f.emit("agent_start"); // a drained follow-up: the same run
	await f.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
	t.mock.timers.tick(60_000);
	await f.emit("message_end", { message: assistant(2_000, "stop") }); // 60 s more
	await f.emit("turn_end", { message: assistant(2_000, "stop") });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 1);
	const data = f.appended[0]!.data as RunData;
	assert.deepEqual([data.durationMs, data.modelMs, data.outputTokens], [102_000, 90_000, 3_000]);
	assert.deepEqual(summaryLines(f, data, false), [" ● Done in 1m 42s · 1 command"], "collapsed: unchanged, and no hint without files");
	assert.deepEqual(summaryLines(f, data, true), [" ● Done in 1m 42s · 1 command", "   model 1m 30s · tools 12s · 33 tok/s"]);

	// The next run starts from nothing, and a run whose messages report no usage records no tokens.
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	t.mock.timers.tick(4_000);
	await f.emit("message_end", { message: { role: "assistant", content: [], stopReason: "toolUse" } });
	await bashCall(f, "c");
	await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	const next = f.appended[1]!.data as RunData;
	assert.deepEqual([next.durationMs, next.modelMs], [4_000, 4_000]);
	assert.ok(!("outputTokens" in (next as object)), "never a guessed token count");
	assert.deepEqual(summaryLines(f, next, true), [" ● Done in 4.0s · 1 command", "   model 4.0s"]);
});

test("the entry records thinking time from the stream's own events, as a part of the model time", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await fixture(t);
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "hm" }], stopReason: "toolUse", usage: { output: 900 } };
	const stream = (type: string) => f.emit("message_update", { message, assistantMessageEvent: { type, contentIndex: 0, partial: message } });
	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await f.emit("message_start", { message: { role: "assistant", content: [] } });
	t.mock.timers.tick(1_000);
	await stream("thinking_start");
	t.mock.timers.tick(6_000);
	await stream("thinking_delta");
	t.mock.timers.tick(6_000);
	await stream("thinking_end"); // 12 s
	await stream("toolcall_start");
	t.mock.timers.tick(17_000);
	await f.emit("message_end", { message }); // 30 s of model time
	await bashCall(f, "b");
	await f.emit("turn_end", { message });
	await f.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
	await stream("thinking_start");
	t.mock.timers.tick(8_000);
	await f.emit("message_end", { message: { ...message, stopReason: "stop" } }); // cut off mid-thought: 8 s more
	await f.emit("turn_end", { message: { ...message, stopReason: "stop" } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	const data = f.appended[0]!.data as RunData & { thinkingMs?: number };
	assert.deepEqual([data.durationMs, data.modelMs, data.thinkingMs], [38_000, 38_000, 20_000]);
	assert.deepEqual(summaryLines(f, data, false), [" ● Done in 38s · 1 command"], "collapsed: unchanged");
	assert.deepEqual(summaryLines(f, data, true), [" ● Done in 38s · 1 command", "   model 38s (20s thinking) · 47 tok/s"]);
});

test("resumed history painted before session_start still gets its summary rows", async (t) => {
	withEnv(t, { PI_1337_STATE_DIR: mkdtempSync(join(tmpdir(), "pi1337-before-bind-")) });
	t.after(() => rmSync(process.env.PI_1337_STATE_DIR!, { recursive: true, force: true }));
	const renderers = new Map<string, EntryRenderer>();
	pi1337({
		on() {}, registerCommand() {}, registerShortcut() {}, registerToolRenderer() {}, appendEntry() {},
		registerEntryRenderer(customType: string, renderer: EntryRenderer) { renderers.set(customType, renderer); },
	} as unknown as ExtensionAPI);
	const data = { v: 1, outcome: "done", durationMs: 38_000, edited: 0, added: 0, removed: 0, wrote: 0, commands: 0, commandsFailed: 0, tools: 9, toolsFailed: 0, cost: 0, files: [], moreFiles: 0 };
	const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
	// On a session switch Pi renders the history, then binds extensions and emits session_start.
	const row = renderers.get("pi1337-run-summary")?.({ type: "custom", customType: "pi1337-run-summary", data } as never, { expanded: false, keyText: () => "", keyHint: () => "" }, theme);
	assert.ok(row, "a row returned as undefined here would never be added to the chat");
	assert.deepEqual(row.render(80), [" ● Done in 38s · 9 tool calls"]);
});

// ---- subscription quota ------------------------------------------------------

const ANTHROPIC_API = "anthropic-messages";
const CODEX_API = "openai-codex-responses";
/** The error OpenAI's ChatGPT route ended an assistant message with at the account's limit, as received. */
const USAGE_LIMIT_ERROR = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";

/** Anthropic's unified headers for the given percent used; resets relative to the (possibly mocked) clock. */
function unifiedHeaders(windows: { fiveHour?: number; week?: number; fiveHourResetIn?: number }): Record<string, string> {
	const seconds = Math.floor(Date.now() / 1000);
	return {
		"content-type": "text/event-stream",
		...(windows.fiveHour === undefined ? {} : {
			"anthropic-ratelimit-unified-5h-utilization": String(windows.fiveHour / 100),
			"anthropic-ratelimit-unified-5h-reset": String(seconds + (windows.fiveHourResetIn ?? 4 * 3600)),
		}),
		...(windows.week === undefined ? {} : {
			"anthropic-ratelimit-unified-7d-utilization": String(windows.week / 100),
			"anthropic-ratelimit-unified-7d-reset": String(seconds + 3 * 86400),
		}),
	};
}

const useModel = (f: Fixture, provider: string, api: string) => Object.assign(f.model, { provider, api });
const response = (f: Fixture, headers: unknown, status = 200) => f.emit("after_provider_response", { status, headers });

test("quota: response headers reach the status row between the cost and the persona, per provider", async (t) => {
	const f = await fixture(t);
	useModel(f, "sub", ANTHROPIC_API);
	f.statuses.set("persona", "Elite");
	f.spend(10);
	await f.emit("turn_end", { message: { role: "assistant" } });
	assert.match(f.text(200), /ctx — · ~\$10\.00 · Elite /, "nothing known: the row as it always was");

	const renders = f.renders();
	await response(f, unifiedHeaders({ week: 85 }));
	assert.match(f.text(200), /ctx — · ~\$10\.00 · wk 85% · Elite /);
	assert.equal(f.renders(), renders + 1, "a changed figure asks for one repaint");
	await response(f, unifiedHeaders({ week: 85 }));
	assert.equal(f.renders(), renders + 1, "the same figure asks for none");

	// A response with another window adds it; the one it does not carry stays.
	await response(f, unifiedHeaders({ fiveHour: 43 }));
	assert.match(f.text(200), /~\$10\.00 · 5h 43% · wk 85% · Elite /);

	// Another provider has no quota; switching back finds the first provider's again.
	useModel(f, "zai", "openai-completions");
	await f.emit("model_select");
	assert.match(f.text(200), /ctx — · ~\$10\.00 · Elite /);
	await response(f, { "content-type": "text/event-stream" });
	await response(f, { "content-type": "text/event-stream" });
	useModel(f, "sub", ANTHROPIC_API);
	await f.emit("model_select");
	assert.match(f.text(200), /~\$10\.00 · 5h 43% · wk 85% · Elite /, "the other provider's responses were not this account's misses");

	// A non-2xx response with valid headers updates the figure.
	await response(f, unifiedHeaders({ fiveHour: 100, week: 86 }), 429);
	assert.match(f.text(200), /~\$10\.00 · 5h 100% · wk 86% · Elite /);

	// Two successful responses without quota: the account or its auth changed.
	await response(f, { "content-type": "text/event-stream" });
	assert.match(f.text(200), /5h 100% · wk 86%/, "one miss keeps it");
	await response(f, {}, 500);
	await response(f, { "content-type": "text/event-stream" });
	assert.match(f.text(200), /ctx — · ~\$10\.00 · Elite /);
	// session_start and session_tree re-read the current provider as well.
	await response(f, unifiedHeaders({ week: 12 }));
	useModel(f, "zai", "openai-completions");
	await f.emit("session_tree");
	assert.doesNotMatch(f.text(200), /wk 12%/);
	useModel(f, "sub", ANTHROPIC_API);
	await f.emit("session_start");
	assert.match(f.text(200), /wk 12%/);
});

test("quota: a response is credited to the model its turn started with, not the one selected meanwhile", async (t) => {
	const f = await fixture(t);
	useModel(f, "sub", ANTHROPIC_API);
	await f.emit("turn_start");
	// Same header family, another account, selected while the request is in flight.
	useModel(f, "other", ANTHROPIC_API);
	await f.emit("model_select");
	await response(f, unifiedHeaders({ week: 66 }));
	assert.doesNotMatch(f.text(200), /wk 66%/, "the account switched to shows nothing of the one that answered");
	await f.emit("turn_end", { message: { role: "assistant" } });
	useModel(f, "sub", ANTHROPIC_API);
	await f.emit("model_select");
	assert.match(f.text(200), /wk 66%/, "the account that answered kept its figure");
	// Outside a turn (cache warming) the response is the current model's.
	await response(f, unifiedHeaders({ week: 67 }));
	assert.match(f.text(200), /wk 67%/);
});

test("quota: a usage-limit error shows limit until that provider's next clean assistant message", async (t) => {
	const f = await fixture(t);
	useModel(f, "openai", "openai-responses");
	// The observed route: a 200 without quota headers, then the error on the message.
	await response(f, { "x-codex-turn-state": "abc" });
	assert.doesNotMatch(f.text(200), /limit/);
	await f.emit("message_end", { message: { role: "assistant", provider: "openai", stopReason: "error", errorMessage: USAGE_LIMIT_ERROR, usage: {} } });
	assert.match(f.text(200), /ctx — · limit │/);
	// A retry repeats both: the mark holds through the request and after it.
	await response(f, { "x-codex-turn-state": "abc" });
	assert.match(f.text(200), /ctx — · limit │/);
	// The message names no provider: the current model's is used.
	await f.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: USAGE_LIMIT_ERROR } });
	assert.match(f.text(200), /ctx — · limit │/);
	// Other messages, and a generic rate-limit error on another provider, leave it alone.
	await f.emit("message_end", { message: { role: "user" } });
	await f.emit("message_end", { message: { role: "toolResult" } });
	await f.emit("message_end", { message: { role: "assistant", provider: "zai", stopReason: "stop" } });
	assert.match(f.text(200), /ctx — · limit │/);
	// It is this provider's: another model shows nothing.
	useModel(f, "zai", "openai-completions");
	await f.emit("model_select");
	assert.doesNotMatch(f.text(200), /limit/);
	await f.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "429 Rate limit exceeded" } });
	assert.doesNotMatch(f.text(200), /limit/, "a pay-per-use throttle is not a subscription limit");
	useModel(f, "openai", "openai-responses");
	await f.emit("model_select");
	assert.match(f.text(200), /ctx — · limit │/);
	await f.emit("message_end", { message: { role: "assistant", provider: "openai", stopReason: "stop" } });
	assert.doesNotMatch(f.text(200), /limit/, "the next message that does not end in that error clears it");
	// Nothing about quota reaches the title.
	assert.ok(!f.titles.some((title) => /limit|quota|%/.test(title)), f.titles.join(" | "));
});

test("quota: the Codex stream event is read, and every other stream chunk costs two comparisons", async (t) => {
	const f = await fixture(t);
	useModel(f, "openai-codex", CODEX_API);
	const reset = Math.floor(Date.now() / 1000) + 3 * 86400;
	const rateLimits = (usedPercent: number) => ({
		type: "codex.rate_limits", plan_type: "plus",
		rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: usedPercent, window_minutes: 10079, reset_at: reset }, secondary: null },
	});
	const stream = (api: string, data: unknown, provider = "openai-codex") => f.emit("provider_stream_event", { provider, api, model: "gpt", data });
	await stream(CODEX_API, rateLimits(7));
	assert.match(f.text(200), /ctx — · wk 7% │/, "10079 minutes is the weekly window");
	await stream(CODEX_API, rateLimits(72));
	assert.match(f.text(200), /ctx — · wk 72% │/);

	// Other apis never have their data read, whatever it says; the Codex api's is read for its type only.
	let reads = 0;
	const counted = (target: object) => new Proxy(target, { get(object, key, receiver) { reads++; return Reflect.get(object, key, receiver); } });
	for (const api of ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai", ""]) {
		await stream(api, counted(rateLimits(99)));
	}
	assert.equal(reads, 0, "another api returns before touching the event's data");
	assert.match(f.text(200), /wk 72%/);
	await stream(CODEX_API, counted({ type: "response.output_text.delta", delta: "hello" }));
	assert.equal(reads, 1, "a Codex chunk of another type is read for its type and nothing else");
	for (const data of [null, undefined, 0, "codex.rate_limits", []]) await stream(CODEX_API, data);
	assert.match(f.text(200), /wk 72%/);
	// The fast path does not touch the context at all: a stale one cannot make it throw.
	const stale = new Proxy({}, { get() { throw new Error("stale context"); } });
	assert.doesNotThrow(() => f.emitWith("provider_stream_event", { provider: "x", api: "openai-completions", model: "m", data: {} }, stale));
	assert.doesNotThrow(() => f.emitWith("provider_stream_event", { provider: "x", api: CODEX_API, model: "m", data: { type: "response.created" } }, stale));
});

test("quota: handlers are synchronous, never throw, and a hostile payload changes nothing", async (t) => {
	const f = await fixture(t);
	useModel(f, "sub", ANTHROPIC_API);
	await response(f, unifiedHeaders({ week: 20 }));
	const trap = () => { throw new Error("hostile"); };
	const hostile = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
	const stale = new Proxy({}, { get: trap });
	const calls: [string, Record<string, unknown>][] = [
		["after_provider_response", { status: 200, headers: hostile }],
		["after_provider_response", { status: hostile, headers: null }],
		["after_provider_response", {}],
		["provider_stream_event", { provider: "sub", api: CODEX_API, model: "m", data: hostile }],
		["provider_stream_event", { provider: hostile, api: CODEX_API, model: "m", data: { type: "codex.rate_limits", rate_limits: hostile } }],
		["message_end", { message: { role: "assistant", get stopReason(): string { throw new Error("hostile"); } } }],
	];
	for (const [name, fields] of calls) {
		for (const context of [undefined, stale]) {
			let result: unknown = "unset";
			assert.doesNotThrow(() => { result = context ? f.emitWith(name, fields, context) : f.emitWith(name, fields, undefined); }, `${name} ${JSON.stringify(Object.keys(fields))}`);
			if (name !== "message_end") assert.equal(result, undefined, `${name} returns nothing to await`);
		}
		await f.emit(name, fields);
	}
	assert.match(f.text(200), /ctx — · wk 20% │/, "the figure from before stands");
});

test("quota: recorded while the redesign is toggled off, so toggle-on opens on current figures", async (t) => {
	const f = await fixture(t);
	useModel(f, "sub", ANTHROPIC_API);
	await f.toggle(); // off
	const renders = f.renders();
	await response(f, unifiedHeaders({ fiveHour: 43, week: 12 }));
	await f.emit("message_end", { message: { role: "assistant", provider: "sub", stopReason: "stop" } });
	assert.equal(f.renders(), renders, "no repaint is requested while off");
	await f.toggle(); // on
	assert.match(f.text(200), /ctx — · 5h 43% · wk 12% │/);
	// The limit mark too.
	await f.toggle();
	await f.emit("message_end", { message: { role: "assistant", provider: "sub", stopReason: "error", errorMessage: USAGE_LIMIT_ERROR } });
	await f.toggle();
	assert.match(f.text(200), /ctx — · limit │/);
});

test("quota: a window's reset is noticed on the next run or turn event, never by a timer or a render", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.UTC(2026, 10, 17, 12) });
	const f = await fixture(t);
	useModel(f, "sub", ANTHROPIC_API);
	await response(f, unifiedHeaders({ fiveHour: 43, week: 12, fiveHourResetIn: 60 }));
	assert.match(f.text(200), /5h 43% · wk 12%/);
	t.mock.timers.tick(61_000);
	for (let pass = 0; pass < 3; pass++) f.pass(200);
	assert.match(f.text(200), /5h 43% · wk 12%/, "rendering re-evaluates nothing: the cached view stands");
	const renders = f.renders();
	await f.emit("turn_start");
	assert.match(f.text(200), /ctx — · wk 12% │/, "the five-hour window is over");
	assert.ok(f.renders() > renders, "and the row repaints once for it");
	// Thirty minutes without news: the calm figure is aged, on the next event again.
	t.mock.timers.tick(31 * 60_000);
	await f.emit("agent_start");
	assert.match(f.text(200), /wk 12%/);
	// Each of the events that can end a wait re-evaluates.
	for (const event of ["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "model_select", "session_tree"]) {
		await response(f, unifiedHeaders({ fiveHour: 50, week: 12, fiveHourResetIn: 60 }));
		assert.match(f.text(200), /5h 50% · wk 12%/, event);
		t.mock.timers.tick(61_000);
		await f.emit(event, event === "agent_settled" ? { aborted: false } : event === "turn_end" ? { message: { role: "assistant" } } : {});
		assert.doesNotMatch(f.text(200), /5h 50%/, `${event} drops the window whose reset has passed`);
	}
});

for (const mode of ["rpc", "json", "print"] as const) {
	test(`quota: ${mode} mode records nothing and reads nothing`, async (t) => {
		const f = await fixture(t, mode);
		useModel(f, "sub", ANTHROPIC_API);
		let reads = 0;
		const counted = <T extends object>(target: T): T => new Proxy(target, { get(object, key, receiver) { reads++; return Reflect.get(object, key, receiver); } });
		await f.emit("after_provider_response", { status: 200, headers: counted(unifiedHeaders({ week: 85 })) });
		await f.emit("provider_stream_event", { provider: "sub", api: CODEX_API, model: "m", data: { type: "codex.rate_limits", rate_limits: counted({ primary: null }) } });
		await f.emit("message_end", { message: counted({ role: "assistant", provider: "sub", stopReason: "error", errorMessage: USAGE_LIMIT_ERROR }) });
		// The run collector and the fold registry read a message's role; the quota reads nothing more.
		assert.ok(reads <= 4, `no header, limit or error text was read outside the TUI: ${reads} reads`);
		await f.emit("model_select");
		await f.emit("session_tree");
		assert.equal(f.renders(), 0);
		assert.equal(f.text(200), "");
	});
}

test("PI_1337_QUOTA=off registers no response or stream handler and leaves the row as it is", async (t) => {
	withEnv(t, { PI_1337_QUOTA: "off" });
	const f = await fixture(t);
	useModel(f, "sub", ANTHROPIC_API);
	assert.ok(!f.handlerNames().includes("after_provider_response"));
	assert.ok(!f.handlerNames().includes("provider_stream_event"));
	const before = f.text(200);
	await f.emit("message_end", { message: { role: "assistant", provider: "sub", stopReason: "error", errorMessage: USAGE_LIMIT_ERROR } });
	await f.emit("model_select");
	await f.emit("turn_start");
	assert.equal(f.text(200), before);
});

test("quota is on by default and reaches neither the summary row nor the terminal title", async (t) => {
	const f = await fixture(t);
	assert.ok(f.handlerNames().includes("after_provider_response") && f.handlerNames().includes("provider_stream_event"));
	useModel(f, "sub", ANTHROPIC_API);
	f.setIdle(false);
	await f.emit("agent_start");
	await response(f, unifiedHeaders({ fiveHour: 96, week: 85 }));
	await f.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "npm test" } });
	await f.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false });
	await f.emit("message_end", { message: { role: "assistant", provider: "sub", stopReason: "error", errorMessage: USAGE_LIMIT_ERROR } });
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.match(f.text(200), /limit/);
	assert.equal(f.appended.length, 1, "the run still gets its summary");
	const summary = JSON.stringify(f.appended);
	assert.doesNotMatch(summary, /quota|limit|5h|wk|96|85/, summary);
	const row = f.entryRenderers.get("pi1337-run-summary")?.({ type: "custom", customType: "pi1337-run-summary", data: f.appended[0]!.data } as never, { expanded: true, keyText: () => "", keyHint: () => "" }, f.theme);
	assert.doesNotMatch(row?.render(200).join("\n") ?? "", /quota|limit|5h|wk|%/);
	assert.ok(f.titles.length > 0);
	assert.ok(!f.titles.some((title) => /quota|limit|5h|wk|%/.test(title)), f.titles.join(" | "));
});

// ---- another extension's editor over ours --------------------------------------

/** Another extension's editor: it draws its own input, with none of our status. */
const foreignEditor = () => ({ render: () => ["foreign editor"], invalidate() {} }) as unknown as Component;

test("an editor installed over ours hands the footer and working row back to Pi, from a microtask, and stops our spinner", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture(t);
	f.setIdle(false);
	await f.emit("agent_start");
	assert.match(f.text(), SPINNER);
	assert.deepEqual(f.chrome, ["working:false", "footer:on"], "apply() hid Pi's working row and emptied the footer");

	// Our editor still mounted: passes change nothing.
	for (let pass = 0; pass < 5; pass++) f.pass();
	await f.flushTheme();
	assert.deepEqual(f.chrome, ["working:false", "footer:on"]);

	f.installEditor(foreignEditor);
	assert.equal(f.text(), "foreign editor", "the slot is theirs: none of our frame is on screen");
	assert.deepEqual(f.chrome, ["working:false", "footer:on"], "no event announced it");
	f.pass();
	f.pass();
	assert.deepEqual(f.chrome, ["working:false", "footer:on"], "the footer's render only notices; it changes no chrome itself");
	await f.flushTheme();
	assert.deepEqual(f.chrome, ["working:false", "footer:on", "footer:off", "working:true"], "after the render: Pi's footer and working row are back");
	assert.equal(f.hasFooter(), false);
	assert.equal(f.text(), "foreign editor", "their editor is left exactly where it is");

	// Our spinner timer is stopped: time passes and nothing asks for a repaint.
	const renders = f.renders();
	t.mock.timers.tick(2000);
	assert.equal(f.renders(), renders);
});

test("while displaced, runs and prompts never retake the chrome; tool rows, title and summary carry on", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture(t);
	f.installEditor(foreignEditor);
	f.pass();
	await f.flushTheme();
	assert.deepEqual(f.chrome.slice(-2), ["footer:off", "working:true"]);
	const handed = f.chrome.length;

	f.setIdle(false);
	await f.emit("agent_start");
	await f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
	await f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
	await f.emit("session_before_compact", { reason: "threshold" });
	await f.emit("session_compact", { reason: "threshold" });
	await f.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "npm test" } });
	await f.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false });
	const renders = f.renders();
	t.mock.timers.tick(2000);
	assert.equal(f.renders(), renders, "no spinner timer of ours runs under Pi's working row");
	assert.ok(f.titles.some((title) => title.startsWith("● ")), `the title still follows the run: ${f.titles.join(" | ")}`);
	f.setIdle(true);
	await f.emit("agent_settled", { aborted: false });
	assert.equal(f.appended.length, 1, "the summary row is still written");
	assert.ok(f.titles.at(-1)?.startsWith("✓ Done"), f.titles.at(-1));
	assert.equal(f.chrome.length, handed, "nothing took the footer or the working row again");
	assert.equal(f.text(), "foreign editor");
});

test("a displaced frame is taken again only by the next apply(): a toggle or a session_start", async (t) => {
	const f = await fixture(t);
	f.installEditor(foreignEditor);
	f.pass();
	await f.flushTheme();
	assert.equal(f.hasFooter(), false);

	await f.toggle(); // off: their editor stays, as before
	assert.equal(f.text(), "foreign editor");
	f.chrome.length = 0;
	await f.toggle(); // on
	assert.deepEqual(f.chrome, ["working:false", "footer:on"]);
	assert.ok(f.text().includes("╭"), "our frame is back");
	for (let pass = 0; pass < 3; pass++) f.pass();
	await f.flushTheme();
	assert.deepEqual(f.chrome, ["working:false", "footer:on"], "mounted again, nothing is handed back");

	// Displaced once more, then a new session.
	f.installEditor(foreignEditor);
	f.pass();
	await f.flushTheme();
	assert.deepEqual(f.chrome.slice(-2), ["footer:off", "working:true"]);
	f.chrome.length = 0;
	await f.emit("session_start");
	assert.deepEqual(f.chrome, ["working:false", "footer:on"]);
	assert.ok(f.text().includes("╭"));
});

test("a slot emptied by another extension counts as displaced; a slot that came back before the microtask does not", async (t) => {
	const f = await fixture(t);
	f.installEditor(undefined); // Pi's own editor, with our footer still empty
	f.pass();
	await f.flushTheme();
	assert.deepEqual(f.chrome.slice(-2), ["footer:off", "working:true"]);

	// A toggle in the same tick as the render that saw the foreign editor: the queued check is dropped.
	await f.toggle();
	await f.toggle();
	f.chrome.length = 0;
	f.installEditor(foreignEditor);
	f.pass();
	await f.toggle(); // off: clear() cancels the check and restores the chrome itself
	await f.flushTheme();
	assert.deepEqual(f.chrome, ["footer:off", "working:true"], "restored once, by clear()");
});

test("a host that cannot say who holds the editor slot never hands the chrome back", async (t) => {
	const f = await fixture(t);
	f.dropEditorGetter();
	f.installEditor(foreignEditor);
	for (let pass = 0; pass < 3; pass++) f.pass();
	await f.flushTheme();
	assert.deepEqual(f.chrome, ["working:false", "footer:on"]);
	assert.equal(f.hasFooter(), true);
});
