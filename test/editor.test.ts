import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CustomEditor, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { makeFramedEditorFactory } from "../src/editor.ts";
import { editorWidthFor, statusSlotWidth } from "../src/frame.ts";
import { chooseBox } from "../src/width.ts";
import { stripAnsi, useTerminalMetrics } from "../src/width.ts";
import { formatContext, type ContextUsageLike } from "../src/format.ts";

const identity = (text: string) => text;

/** Use actual bundled palettes and the host's ANSI emitter, not marker strings. */
function statusTheme(name: string): Theme {
	const palette = JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8"));
	const resolve = (value: string | number): string | number =>
		typeof value === "string" && value in palette.vars ? resolve(palette.vars[value]) : value;
	const colors = Object.fromEntries(Object.entries(palette.colors).map(([key, value]) => [key, resolve(value as string | number)]));
	return new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
}

function statusFixture(options: { height?: number; columns?: number; color?: { kind: "rgb"; r: number; g: number; b: number }; working?: boolean; waiting?: boolean } = {}) {
	const ui = { theme: statusTheme("1337") };
	const state = {
		usage: { tokens: 70000, contextWindow: 100000, percent: 70 } as ContextUsageLike | undefined,
		persona: "Elite" as string | undefined,
		branch: "main",
		session: "review",
	};
	const editor = makeFramedEditorFactory({
		ctx: { cwd: "/work/repo", model: { id: "claude-opus-4-8", provider: "anthropic" }, ui } as unknown as ExtensionContext,
		getPersona: () => state.persona,
		getSubagentCount: () => 2,
		getGitBranch: () => state.branch,
		getSessionName: () => state.session,
		getContextUsage: () => state.usage,
		getCost: () => "~$0.250",
		isWorking: () => options.working ?? false,
		isWaitingForUser: () => options.waiting ?? false,
		spinnerFrame: () => " ▲ ",
		spinnerRows: () => [" ▲ ", "△ △"],
		spinnerColor: () => options.color,
		spinnerHeight: () => options.height ?? 1,
		spinnerColumns: () => options.columns ?? (options.height === 2 ? 3 : 1),
		bindTui() {},
		bindEditor() {},
		maxWidth: 180,
		minMargin: 2,
	})(
		{ terminal: { rows: 40, columns: 200 }, requestRender() {} } as unknown as TUI,
		{ borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } },
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("status");
	return { editor, ui, state, status: (width = 200) => editor.render(width).at(-2)! };
}

test("status hierarchy uses active palette roles without adding columns or another row", () => {
	const { editor, ui, status } = statusFixture();
	let plain: string | undefined;
	for (const name of ["1337", "1337-amber", "1337-ice", "1337-cyber", "1337-neon", "1337-split", "1337-fallout", "1337-skynet"]) {
		ui.theme = statusTheme(name);
		const row = status();
		for (const [role, label] of [
			["text", " /work/repo"], ["accent", "main"], ["muted", "review"],
			["accent", "▰▰▰▰"], ["dim", "▱"],
			["accent", "70.0k · 70%"], ["muted", "~$0.250"], ["dim", " · "],
			["accent", "2 agents"], ["dim", "anthropic/"], ["accent", "opus-4-8"], ["text", "Elite"],
		] as const) assert.ok(row.includes(ui.theme.fg(role, label)), `${name}: ${label} must use ${role}`);
		plain ??= stripAnsi(row);
		assert.equal(stripAnsi(row), plain, "palette switches must not change geometry or data");
		assert.match(plain, /\/work\/repo · main · review\s+\[▰▰▰▰▱\] 70\.0k · 70% · ~\$0\.250\s+2 agents  anthropic\/opus-4-8 · Elite/);
		assert.equal(editor.render(200).length, 4, "one input row, one status row, two clean borders");
		assert.match(stripAnsi(editor.render(200)[0]).trim(), /^╭─+╮$/);
		assert.match(stripAnsi(editor.render(200).at(-1)!).trim(), /^╰─+╯$/);
	}
});

test("real-theme one/two/three-cell profiles keep exact host-measured rows while idle, active, and waiting", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		for (const columns of [1, 2, 3]) {
			for (const state of [{}, { working: true }, { working: true, waiting: true }]) {
				const editor = statusFixture({ height: 2, columns, color: { kind: "rgb", r: 213, g: 31, b: 42 }, ...state }).editor;
				const rows = editor.render(120);
				const expectedWidth = visibleWidth(rows[0]);
				for (const row of rows) assert.equal(visibleWidth(row), expectedWidth, `columns=${columns}, state=${JSON.stringify(state)}: ${row}`);
			}
			assert.equal(statusSlotWidth(columns, 2), columns + 1);
		}
		assert.equal(statusSlotWidth(3, 1), 0, "single-row profiles preserve their existing status width");
	} finally {
		useTerminalMetrics();
	}
});

test("two-row sidecar color paints the pyramid crimson and reserves status width in every activity state", () => {
	const color = { kind: "rgb" as const, r: 213, g: 31, b: 42 };
	const active = statusFixture({ height: 2, color, working: true }).editor.render(120);
	assert.ok(active[1].includes("\x1b[38;2;213;31;42m"), "logo uses configured RGB rather than semantic accent");
	assert.ok(stripAnsi(active[1]).includes(" ▲ "));
	assert.ok(stripAnsi(active[2]).includes("△ △"));
	const activeStatus = stripAnsi(active.at(-2)!);
	for (const state of [{ height: 2 }, { height: 2, waiting: true }, { height: 2, working: true, color }]) {
		const fixture = statusFixture(state);
		const status = stripAnsi(fixture.status(120));
		assert.equal(visibleWidth(status), visibleWidth(activeStatus), "idle/waiting/activity retain identical status row geometry");
		assert.equal(status.indexOf("Elite"), activeStatus.indexOf("Elite"), "reserved slot does not move status metadata");
		assert.equal(fixture.editor.render(120).length, 4, "pyramid never adds an editor row");
	}
});

test("context alone escalates at Pi thresholds; cost stays neutral and unknown usage stays quiet", () => {
	const { ui, state, status } = statusFixture();
	for (const [percent, role] of [[0, "accent"], [70, "accent"], [70.01, "warning"], [90, "warning"], [90.01, "error"], [null, "accent"]] as const) {
		state.usage = { tokens: 70000, contextWindow: 100000, percent };
		const row = status();
		assert.ok(row.includes(ui.theme.fg(role, formatContext(state.usage))), `${percent}: context uses ${role}`);
		assert.ok(row.includes(ui.theme.fg("muted", "~$0.250")), "context pressure must not color the estimate as a billing warning");
	}
	for (const unknown of [undefined, { tokens: null, contextWindow: 100000, percent: null }]) {
		state.usage = unknown;
		assert.ok(status().includes(ui.theme.fg("dim", "ctx —")));
	}
});

test("usage gauge is static, bounded to five cells, and omitted rather than displacing narrow status data", () => {
	const { ui, state, status } = statusFixture();
	for (const [percent, filled, role] of [[-1, 0, "accent"], [0, 0, "accent"], [20, 1, "accent"], [70, 4, "accent"], [91, 5, "error"], [140, 5, "error"]] as const) {
		state.usage = { tokens: 70000, contextWindow: 100000, percent };
		const row = status();
		const gauge = `[${"▰".repeat(filled)}${"▱".repeat(5 - filled)}]`;
		assert.ok(stripAnsi(row).includes(gauge), `${percent}: expected ${gauge}`);
		if (filled) assert.ok(row.includes(ui.theme.fg(role, "▰".repeat(filled))));
		if (filled < 5) assert.ok(row.includes(ui.theme.fg("dim", "▱".repeat(5 - filled))));
		assert.ok(!/[▰▱]/.test(stripAnsi(status(94))), "inner width below 90 omits the gauge");
		assert.ok(stripAnsi(status(80)).includes(formatContext(state.usage)), "numeric context is unchanged when gauge is omitted");
	}
	for (const percent of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
		state.usage = { tokens: 70000, contextWindow: 100000, percent };
		assert.ok(!/[▰▱]/.test(stripAnsi(status())), "unknown/nonfinite percentage cannot imply measured capacity");
	}
	state.usage = { tokens: null, contextWindow: 100000, percent: 70 };
	assert.ok(!/[▰▱]/.test(stripAnsi(status())), "unknown tokens cannot imply measured capacity");
});

test("gauge appears only at the exact full-metadata fit boundary and never displaces content", () => {
	const { ui, state, status } = statusFixture();
	state.usage = { tokens: 70000, contextWindow: 100000, percent: 70 };
	const full = ["/work/repo", "main", "review", "70.0k · 70%", "~$0.250", "2 agents", "anthropic/opus-4-8", "Elite"];
	let firstGaugeWidth: number | undefined;
	for (let width = 90; width <= 180; width++) {
		if (stripAnsi(status(width)).includes("[▰▰▰▰▱]")) { firstGaugeWidth = width; break; }
	}
	assert.ok(firstGaugeWidth !== undefined, "a sufficiently wide exact-fit status can show the gauge");
	const exactFit = stripAnsi(status(firstGaugeWidth));
	const oneColumnShort = stripAnsi(status(firstGaugeWidth - 1));
	for (const label of full) {
		assert.ok(exactFit.includes(label), `exact-fit retains ${label}`);
		assert.ok(oneColumnShort.includes(label), `one-column-short retains ${label}`);
	}
	assert.ok(exactFit.includes("[▰▰▰▰▱]"));
	assert.ok(!oneColumnShort.includes("[▰▰▰▰▱]"));
	assert.ok(ui.theme, "fixture uses the real active theme ruler/colors");
});

test("two-row status reservation shifts gauge admission by the measured spinner slot", () => {
	const normal = statusFixture();
	const firstGauge = (render: (width: number) => string) => {
		for (let width = 90; width <= 180; width++) if (stripAnsi(render(width)).includes("[▰▰▰▰▱]")) return width;
		return undefined;
	};
	const ordinaryWidth = firstGauge(normal.status);
	assert.ok(ordinaryWidth !== undefined);
	for (const columns of [1, 2, 3]) {
		const pyramid = statusFixture({ height: 2, columns });
		const pyramidWidth = firstGauge(pyramid.status);
		assert.ok(pyramidWidth !== undefined);
		assert.equal(pyramidWidth, ordinaryWidth + columns + 1, `columns=${columns}: gauge admission subtracts the exact status slot`);
		assert.ok(!stripAnsi(pyramid.status(pyramidWidth - 1)).includes("[▰▰▰▰▱]"));
		for (const label of ["/work/repo", "70.0k · 70%", "anthropic/opus-4-8", "Elite"]) assert.ok(stripAnsi(pyramid.status(pyramidWidth - 1)).includes(label));
	}
});

test("colored status stays within host columns and retains semantic narrowing with Unicode metadata", () => {
	const { editor, state, status } = statusFixture();
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		for (const persona of ["Elite", undefined, "🧑‍💻 界"]) {
			state.persona = persona;
			state.branch = "feature/界-का-long-branch";
			state.session = "review session with long metadata";
			for (let width = 12; width <= 200; width++) {
				const rows = editor.render(width);
				const expectedWidth = visibleWidth(rows[0]);
				for (const row of rows) {
					assert.ok(visibleWidth(row) <= width, `overflow at ${width}: ${row}`);
					assert.equal(visibleWidth(row), expectedWidth, `rail mismatch at ${width}`);
				}
				if (width >= 40) assert.ok(stripAnsi(status(width)).includes("repo"), `workspace lost at ${width}`);
				if (width >= 80) assert.ok(stripAnsi(status(width)).includes("70%"), `context lost at ${width}`);
			}
		}
		state.persona = "Elite";
		assert.ok(!/[▰▱]/.test(stripAnsi(status(80))), "gauge yields before existing metadata or numeric context");
		assert.ok(!stripAnsi(status(40)).includes("anthropic"), "provider yields at narrow widths");
		assert.ok(stripAnsi(status(40)).includes("Elite"), "persona survives provider/model degradation");
	} finally {
		useTerminalMetrics();
	}
});

test("waiting marker is static, uses the spinner gutter, and never rescans the session", () => {
	let entryScans = 0;
	let contextScans = 0;
	let spinnerFrames = 0;
	const ctx = {
		cwd: "C:\\work\\repo",
		model: { id: "claude-opus-4-8", provider: "claude-pro-max-native" },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getEntries: () => {
				entryScans++;
				return [];
			},
			getSessionName: () => {
				entryScans++;
				return "quality";
			},
		},
		getContextUsage: () => {
			contextScans++;
			return { tokens: 1000, contextWindow: 200000, percent: 0.5 };
		},
		ui: { theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} } as unknown as TUI;
	const editorTheme = {
		borderColor: identity,
		selectList: {
			text: identity,
			selectedText: identity,
			description: identity,
			selectedDescription: identity,
			scrollIndicator: identity,
		},
	} as unknown as EditorTheme;
	const editor = makeFramedEditorFactory({
		ctx,
		getPersona: () => "🎯 Elite",
		getSubagentCount: () => 0,
		getGitBranch: () => "main",
		getSessionName: () => "quality",
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
		getCost: () => "$0.250",
		isWorking: () => true,
		isWaitingForUser: () => true,
		spinnerFrame: () => {
			spinnerFrames++;
			return "⠹";
		},
		bindTui() {},
		bindEditor() {},
		maxWidth: 100,
		minMargin: 2,
	})(tui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
	editor.setText("render me");

	for (let i = 0; i < 20; i++) editor.render(120);

	assert.equal(entryScans, 0, "render must not walk a growing session");
	assert.equal(contextScans, 0, "render must not rebuild context usage");
	assert.equal(spinnerFrames, 0, "waiting for the user must not animate the spinner");
	const firstBodyRow = editor.render(120)[1] ?? "";
	assert.ok(firstBodyRow.includes("?"), "waiting marker should occupy the spinner gutter");
	assert.ok(!firstBodyRow.includes("⠹"), "waiting marker should replace the working spinner");
});

test("status keeps the repository basename ahead of provider detail at narrow and changing widths", () => {
	const ctx = {
		cwd: "D:/Sources/pi-persona",
		model: { id: "claude-opus-4-8", provider: "claude-pro-max-native" },
		modelRegistry: { isUsingOAuth: () => false },
		ui: { theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} } as unknown as TUI;
	const editorTheme = {
		borderColor: identity,
		selectList: {
			text: identity,
			selectedText: identity,
			description: identity,
			selectedDescription: identity,
			scrollIndicator: identity,
		},
	} as unknown as EditorTheme;
	const editor = makeFramedEditorFactory({
		ctx,
		getPersona: () => "1337",
		getSubagentCount: () => 3,
		getGitBranch: () => "feature/restore-context-indicator",
		getSessionName: () => "Fix session resume status",
		getContextUsage: () => ({ tokens: 182000, contextWindow: 200000, percent: 91 }),
		getCost: () => "~$0.250",
		isWorking: () => false,
		spinnerFrame: () => "",
		bindTui() {},
		bindEditor() {},
		maxWidth: 100,
		minMargin: 2,
	})(tui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
	editor.setText("status regression");

	for (const width of [40, 60, 80, 90, 120]) {
		const rendered = editor.render(width);
		const status = stripAnsi(rendered[rendered.length - 2] ?? "");
		assert.ok(status.includes("pi-persona"), `workspace identity should survive at terminal width ${width}: ${status}`);
		if (width >= 80) {
			assert.ok(status.includes("Sources/pi-persona"), `full workspace path should survive at ${width}: ${status}`);
			assert.ok(status.includes("91%"), `critical context percentage should survive at ${width}: ${status}`);
		}
	}
});

test("steady-state spinner renders reuse the base editor layout", () => {
	const ctx = {
		cwd: "C:\\work\\repo",
		model: { id: "claude-opus-4-8", provider: "claude-pro-max-native" },
		ui: { theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} } as unknown as TUI;
	const editorTheme = {
		borderColor: identity,
		selectList: {
			text: identity,
			selectedText: identity,
			description: identity,
			selectedDescription: identity,
			scrollIndicator: identity,
		},
	} as unknown as EditorTheme;
	const editor = makeFramedEditorFactory({
		ctx,
		getPersona: () => undefined,
		getSubagentCount: () => 0,
		getSessionName: () => undefined,
		getContextUsage: () => undefined,
		getCost: () => "",
		isWorking: () => true,
		spinnerFrame: () => "⠹",
		bindTui() {},
		bindEditor() {},
		maxWidth: 100,
		minMargin: 2,
	})(tui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
	editor.setText("a long enough steady-state prompt to exercise wrapping and framing");

	const originalRender = CustomEditor.prototype.render;
	const hostMouse = CustomEditor.prototype as unknown as {
		handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	};
	const originalMouse = hostMouse.handleMouse;
	let baseRenders = 0;
	let mouseCalls = 0;
	let lastMouseEvent: unknown;
	let wideMouseEvent: TuiMouseEvent | undefined;
	// A complete TuiMouseEvent: pi-tui >=0.85 types handleMouse against the full
	// shape, so a partial stub no longer typechecks.
	const clickEvent = (x: number, width: number): TuiMouseEvent =>
		({
			type: "click",
			button: "left",
			x,
			y: 0,
			width,
			height: 24,
			screenX: x,
			screenY: 0,
		}) as TuiMouseEvent;
	const selectionEvent = (type: "drag" | "release", x: number, width: number): TuiMouseEvent =>
		({ type, button: "left", x, y: 0, width, height: 24, screenX: x, screenY: 0 }) as TuiMouseEvent;
	CustomEditor.prototype.render = function (width: number): string[] {
		baseRenders++;
		return originalRender.call(this, width);
	};
	hostMouse.handleMouse = (event: TuiMouseEvent) => {
		mouseCalls++;
		lastMouseEvent = event;
		return undefined;
	};
	try {
		for (let i = 0; i < 20; i++) editor.render(120);
		assert.equal(baseRenders, 1, "spinner-only redraws should not relayout unchanged editor text");
		assert.ok((editor.render(120)[1] ?? "").includes("⠹"), "working spinner stays visible when no user reply is pending");
		for (const type of ["drag", "release"] as const) {
			editor.handleMouse(selectionEvent(type, 17, 120));
			editor.render(120);
			assert.equal(baseRenders, 1, `${type} must preserve the cached layout when Pi leaves it unhandled`);
		}
		editor.setText("changed prompt");
		editor.render(120);
		editor.handleMouse(clickEvent(17, 120));
		wideMouseEvent = lastMouseEvent as TuiMouseEvent;
		editor.render(120);
		for (const width of [8, 9, 10, 11]) {
			editor.render(width); // the base renderer is used when the inner width is < 4
			editor.handleMouse(clickEvent(3, width));
			assert.equal((lastMouseEvent as TuiMouseEvent).x, 3, `width ${width}: x must stay in the base viewport`);
			assert.equal((lastMouseEvent as TuiMouseEvent).width, width, `width ${width}: base viewport must match render`);
		}
	} finally {
		CustomEditor.prototype.render = originalRender;
		hostMouse.handleMouse = originalMouse;
	}
	assert.equal(baseRenders, 7, "editor mutations and narrow fallback should trigger fresh base layouts");
	assert.equal(mouseCalls, 7, "click, drag, and release events must still reach the base editor");
	// Only x/width are translated into the raw-editor viewport. screenX/screenY
	// stay absolute terminal coordinates for renderer hit testing.
	assert.equal(wideMouseEvent?.x, 4, "framed x must be translated for the base editor");
	assert.equal(wideMouseEvent?.width, 94, "framed width must be the raw-editor viewport");
	assert.equal(wideMouseEvent?.screenX, 17, "screenX must stay absolute");
	assert.equal(editor.render(120).some((line) => line.includes("changed prompt")), true, "editor mutations invalidate the cached layout");
});

test("real Pi ruler and editor preserve three-cell Skynet geometry and mouse viewport", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	const ctx = { cwd: "C:\\work\\repo", model: undefined, ui: { theme: { fg: (_role: string, text: string) => text } } } as unknown as ExtensionContext;
	const tui = { terminal: { rows: 40, columns: 140 }, requestRender() {} } as unknown as TUI;
	const theme = { borderColor: identity, selectList: { text: identity, selectedText: identity, description: identity, selectedDescription: identity, scrollIndicator: identity } } as unknown as EditorTheme;
	const editor = makeFramedEditorFactory({
		ctx, getPersona: () => undefined, getSubagentCount: () => 0, getSessionName: () => undefined,
		getContextUsage: () => undefined, getCost: () => "", isWorking: () => true,
		spinnerFrame: () => " ▲ ", spinnerRows: () => [" ▲ ", "△ △"], spinnerHeight: () => 2, spinnerColumns: () => 3, bindTui() {}, bindEditor() {}, maxWidth: 180, minMargin: 2,
	})(tui, theme, { matches: () => false } as unknown as KeybindingsManager);
	editor.setText("Skynet spinner alignment with wrapped input: 界🙂 and enough text to wrap across narrow viewports");
	const hostMouse = CustomEditor.prototype as unknown as { handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined };
	const originalMouse = hostMouse.handleMouse;
	let mouse: TuiMouseEvent | undefined;
	hostMouse.handleMouse = (event) => { mouse = event; return undefined; };
	try {
		for (let width = 12; width <= 120; width++) {
			const rows = editor.render(width);
			for (const row of rows) assert.ok(visibleWidth(row) <= width, `Skynet overflow at ${width}: ${row}`);
			const body = stripAnsi(rows[1] ?? "");
			const { boxWidth, leftMargin, fallback } = chooseBox(width, 180, 2);
			const expected = editorWidthFor(boxWidth, 3);
			if (width >= 30 && !fallback && expected >= 4) assert.ok(visibleWidth(body) <= width, `pyramid body width at ${width}`);
			editor.handleMouse(({ type: "click", button: "left", x: leftMargin + 3, y: 1, width, height: 24, screenX: leftMargin + 3, screenY: 1 }) as TuiMouseEvent);
			if (fallback || expected < 4) assert.equal(mouse?.width, width);
			else assert.equal(mouse?.width, expected, `mouse viewport at ${width}`);
		}
	} finally {
		hostMouse.handleMouse = originalMouse;
		useTerminalMetrics();
	}
});

test("three-cell Skynet autocomplete preserves host row and mouse geometry", async () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} } as unknown as TUI;
	const palette = statusTheme("1337-skynet");
	const theme = { borderColor: identity, selectList: { text: identity, selectedText: identity, description: identity, selectedDescription: identity, scrollIndicator: identity } } as unknown as EditorTheme;
	const editor = makeFramedEditorFactory({
		ctx: { cwd: "C:\\work\\repo", model: undefined, ui: { theme: palette } } as unknown as ExtensionContext,
		getPersona: () => undefined, getSubagentCount: () => 0, getSessionName: () => "hidden while menu open",
		getContextUsage: () => undefined, getCost: () => "", isWorking: () => true,
		spinnerFrame: () => " ▲ ", spinnerRows: () => [" ▲ ", "△ △"], spinnerHeight: () => 2, spinnerColumns: () => 3,
		bindTui() {}, bindEditor() {}, maxWidth: 180, minMargin: 2,
	})(tui, theme, { matches: () => false } as unknown as KeybindingsManager);
	editor.setAutocompleteProvider({
		triggerCharacters: ["@"],
		async getSuggestions() { return { prefix: "@", items: [{ value: "@first", label: "FIRST_SUGGESTION" }, { value: "@second", label: "SECOND_SUGGESTION" }] }; },
		applyCompletion(lines, cursorLine, cursorCol, item) { return { lines, cursorLine, cursorCol }; },
	});
	editor.setText("@");
	const internals = editor as unknown as Record<string, unknown>;
	(editor as unknown as { forceFileAutocomplete: (explicitTab?: boolean) => void }).forceFileAutocomplete(false);
	await (internals.autocompleteRequestTask as Promise<void>);
	assert.equal(editor.isShowingAutocomplete(), true, "the real base editor should own an active menu");

	const width = 76;
	const rows = editor.render(width);
	const visibleContentRows = internals.renderedVisibleLineCount as number;
	const firstSuggestion = rows.findIndex((row) => row.includes("FIRST_SUGGESTION"));
	assert.notEqual(firstSuggestion, -1, "real autocomplete renders its first suggestion");
	assert.equal(firstSuggestion, visibleContentRows + 2, "first suggestion row matches the base editor's mouse row");
	assert.ok(!rows.some((row) => row.includes("hidden while menu open")), "status row is omitted while autocomplete is open");
	for (const row of rows) assert.ok(visibleWidth(row) <= width, `host ruler sees overflow at ${width}: ${row}`);

	const hostMouse = CustomEditor.prototype as unknown as { handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined };
	const originalMouse = hostMouse.handleMouse;
	let forwarded: TuiMouseEvent | undefined;
	hostMouse.handleMouse = (event) => { forwarded = event; return undefined; };
	try {
		editor.handleMouse(({ type: "click", button: "left", x: 12, y: firstSuggestion, width, height: 24, screenX: 12, screenY: firstSuggestion }) as TuiMouseEvent);
	} finally {
		hostMouse.handleMouse = originalMouse;
		useTerminalMetrics();
	}
	const { boxWidth, leftMargin, fallback } = chooseBox(width, 180, 2);
	assert.equal(fallback, false);
	assert.equal(forwarded?.y, firstSuggestion, "autocomplete row indices are not shifted for mouse routing");
	assert.equal(forwarded?.width, editorWidthFor(boxWidth, 3), "base mouse viewport reserves all three Skynet cells");
	assert.equal(forwarded?.x, 12 - leftMargin - 1 - 2, "mouse x maps into the reduced editor viewport");
});

test("framed autocomplete rows map to the base editor's expected rows", () => {
	const V = 3;
	const H = 2;
	// Raw base layout: top rule, V content rows, bottom rule, H autocomplete rows.
	const raw = ["─".repeat(20), "c0", "c1", "c2", "─".repeat(20), "a0", "a1"];
	const stubTui = { terminal: { rows: 40, cols: 120, write: () => {} } } as unknown as TUI;
	const stubTheme = {
		fg: (_t: string, s: string) => s,
		borderColor: (_t: string, s: string) => s,
		selectList: { text: identity, selectedText: identity, description: identity, selectedDescription: identity, scrollIndicator: identity },
	} as unknown as EditorTheme;

	const editor = makeFramedEditorFactory({
		ctx: { cwd: "C:\\work\\repo", model: undefined, modelRegistry: { isUsingOAuth: () => false }, ui: { theme: stubTheme } } as unknown as ExtensionContext,
		getPersona: () => undefined,
		getSubagentCount: () => 0,
		getSessionName: () => undefined,
		getContextUsage: () => undefined,
		getCost: () => "",
		isWorking: () => false,
		spinnerFrame: () => "",
		bindTui() {},
		bindEditor() {},
		maxWidth: 100,
		minMargin: 2,
	})(stubTui, stubTheme, { matches: () => false } as unknown as KeybindingsManager);

	const hostMouse = CustomEditor.prototype as unknown as {
		handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	};
	const originalMouse = hostMouse.handleMouse;
	const originalRender = CustomEditor.prototype.render;

	// Stand in for the base renderer so the frame receives the exact layout above.
	CustomEditor.prototype.render = function (): string[] {
		const self = this as unknown as Record<string, number>;
		self.renderedVisibleLineCount = V;
		self.renderedAutocompleteHeight = H;
		return raw;
	};

	let framedRows: string[] = [];
	try {
		framedRows = editor.render(120);
	} finally {
		CustomEditor.prototype.render = originalRender;
	}

	const firstSuggestion = framedRows.findIndex((l: string) => l.includes("a0"));
	const secondSuggestion = framedRows.findIndex((l: string) => l.includes("a1"));
	assert.notEqual(firstSuggestion, -1, "framed output should contain the first suggestion row");
	assert.notEqual(secondSuggestion, -1, "framed output should contain the second suggestion row");

	const internals = editor as unknown as Record<string, number>;
	internals.renderedVisibleLineCount = V;
	internals.renderedAutocompleteHeight = H;

	const forwarded: number[] = [];
	hostMouse.handleMouse = (event: TuiMouseEvent) => {
		forwarded.push(event.y);
		return undefined;
	};
	try {
		const click = (y: number): TuiMouseEvent =>
			({ type: "click", button: "left", x: 10, y, width: 120, height: 24, screenX: 10, screenY: 0 }) as TuiMouseEvent;
		editor.handleMouse(click(firstSuggestion));
		editor.handleMouse(click(secondSuggestion));
	} finally {
		hostMouse.handleMouse = originalMouse;
	}

	assert.deepEqual([firstSuggestion, secondSuggestion], [V + 2, V + 3], "suggestions must appear at the base editor's own row indices");
	assert.deepEqual(forwarded, [firstSuggestion, secondSuggestion], "mouse forwarding must not remap suggestion rows");
});
