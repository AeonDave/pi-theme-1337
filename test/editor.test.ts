import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { makeFramedEditorFactory } from "../src/editor.ts";

const identity = (text: string) => text;

test("spinner renders consume cached status and never rescan the session", () => {
	let entryScans = 0;
	let contextScans = 0;
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
		spinnerFrame: () => "⠹",
		bindTui() {},
		bindEditor() {},
		maxWidth: 100,
		minMargin: 2,
	})(tui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
	editor.setText("render me");

	for (let i = 0; i < 20; i++) editor.render(120);

	assert.equal(entryScans, 0, "render must not walk a growing session");
	assert.equal(contextScans, 0, "render must not rebuild context usage");
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
	assert.equal(mouseCalls, 5, "host mouse events must still reach the base editor");
	// Only x/width are translated into the raw-editor viewport. screenX/screenY
	// stay absolute terminal coordinates for renderer hit testing.
	assert.equal(wideMouseEvent?.x, 4, "framed x must be translated for the base editor");
	assert.equal(wideMouseEvent?.width, 94, "framed width must be the raw-editor viewport");
	assert.equal(wideMouseEvent?.screenX, 17, "screenX must stay absolute");
	assert.equal(editor.render(120).some((line) => line.includes("changed prompt")), true, "editor mutations invalidate the cached layout");
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
