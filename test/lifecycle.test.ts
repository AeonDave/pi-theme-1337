import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import pi1337 from "../src/index.ts";
import { OSC11_RESET, osc11Set } from "../src/background.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

test("shutdown restores terminal tint and all chrome after a real apply", async () => {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
		registerShortcut() {},
	} as unknown as ExtensionAPI;
	pi1337(api);

	const terminalWrites: string[] = [];
	const calls: string[] = [];
	let widgetCalls = 0;
	let footerComponent: { render(width: number): string[] } | undefined;
	const tui = {
		terminal: { write: (text: string) => terminalWrites.push(text) },
		requestRender: (force?: boolean) => calls.push(`render:${String(force)}`),
	} as unknown as TUI;
	const theme = {
		name: "1337-skynet",
		sourcePath: join(import.meta.dirname, "..", "themes", "1337-skynet.json"),
		fg: (_color: string, text: string) => text,
	};
	const footerData = {
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => null,
		onBranchChange: () => () => {},
	};
	const ui = {
		theme,
		setTheme: () => ({ success: true }),
		setFooter: (factory: unknown) => {
			calls.push(factory ? "footer:on" : "footer:off");
			if (typeof factory === "function") {
				footerComponent = (factory as (t: TUI, themeValue: typeof theme, data: typeof footerData) => { render(width: number): string[] })(tui, theme, footerData);
			}
		},
		setEditorComponent: (factory: unknown) => calls.push(factory ? "editor:on" : "editor:off"),
		setWorkingVisible: (visible: boolean) => calls.push(`working:${String(visible)}`),
		setHiddenThinkingLabel: () => {},
		setWidget: () => {
			widgetCalls++;
		},
		notify: () => {},
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui,
		cwd: "D:\\work",
		model: undefined,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: { getSessionName: () => undefined, getEntries: () => [] },
		getContextUsage: () => undefined,
		isIdle: () => true,
	} as unknown as ExtensionContext;

	const previousBg = process.env.PI_1337_BG;
	const previousTheme = process.env.PI_1337_THEME;
	process.env.PI_1337_BG = "on";
	process.env.PI_1337_THEME = "off";
	try {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.ok(terminalWrites.includes(osc11Set("#0c0304")), "apply paints the configured terminal background");

		const writesBeforeSwitch = terminalWrites.length;
		const widgetsBeforeSwitch = widgetCalls;
		theme.sourcePath = join(import.meta.dirname, "..", "themes", "1337-fallout.json");
		footerComponent?.render(80);
		footerComponent?.render(80);
		assert.equal(terminalWrites.length, writesBeforeSwitch, "footer render performs no terminal mutation");
		assert.equal(widgetCalls, widgetsBeforeSwitch, "footer render performs no widget mutation");
		await Promise.resolve();
		assert.equal(terminalWrites.length, writesBeforeSwitch + 2, "one deferred switch resets and repaints the tint");
		assert.equal(widgetCalls, widgetsBeforeSwitch + 1, "repeated renders coalesce to one avatar refresh");

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		assert.equal(terminalWrites.at(-1), OSC11_RESET, "shutdown must return the terminal to its configured background");
		assert.ok(calls.includes("editor:off"));
		assert.ok(calls.includes("footer:off"));
		assert.ok(calls.includes("working:true"));
	} finally {
		// If an assertion fires before shutdown, still restore process.stderr ownership.
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		if (previousBg === undefined) delete process.env.PI_1337_BG;
		else process.env.PI_1337_BG = previousBg;
		if (previousTheme === undefined) delete process.env.PI_1337_THEME;
		else process.env.PI_1337_THEME = previousTheme;
	}
});
