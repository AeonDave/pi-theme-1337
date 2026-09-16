import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
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
		handleMouse?: (event: unknown) => unknown;
	};
	const originalMouse = hostMouse.handleMouse;
	let baseRenders = 0;
	let mouseCalls = 0;
	let lastMouseEvent: unknown;
	CustomEditor.prototype.render = function (width: number): string[] {
		baseRenders++;
		return originalRender.call(this, width);
	};
	hostMouse.handleMouse = (event: unknown) => {
		mouseCalls++;
		lastMouseEvent = event;
		return event;
	};
	try {
		for (let i = 0; i < 20; i++) editor.render(120);
		assert.equal(baseRenders, 1, "spinner-only redraws should not relayout unchanged editor text");
		editor.setText("changed prompt");
		editor.render(120);
		editor.handleMouse({ type: "click", x: 17, width: 120 });
		editor.render(120);
	} finally {
		CustomEditor.prototype.render = originalRender;
		hostMouse.handleMouse = originalMouse;
	}
	assert.equal(baseRenders, 3, "editor mutations should trigger one fresh base layout");
	assert.equal(mouseCalls, 1, "host mouse events must still reach the base editor");
	assert.deepEqual(lastMouseEvent, { type: "click", x: 4, width: 94 }, "framed coordinates must be translated for the base editor");
	assert.equal(editor.render(120).some((line) => line.includes("changed prompt")), true, "editor mutations invalidate the cached layout");
});
