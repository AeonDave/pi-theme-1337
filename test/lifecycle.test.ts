import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
		registerToolRenderer() {},
	} as unknown as ExtensionAPI;
	pi1337(api);

	const terminalWrites: string[] = [];
	const calls: string[] = [];
	let widgetCalls = 0;
	let footerComponent: { render(width: number): string[] } | undefined;
	const tui = {
		terminal: { write: (text: string) => terminalWrites.push(text) },
		invalidate() {},
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
		assert.equal(widgetCalls, widgetsBeforeSwitch, "bundled palette switches do not install an avatar widget");

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

test("reload keeps a Pi-selected palette ahead of the config-file fallback", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-1337-reload-theme-"));
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ theme: "cyber" }));
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const setThemeCalls: string[] = [];
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
		registerShortcut() {},
		registerToolRenderer() {},
	} as unknown as ExtensionAPI;
	const theme = {
		name: "dark",
		sourcePath: "",
		fg: (_color: string, text: string) => text,
	};
	const themePath = (name: string) => join(import.meta.dirname, "..", "themes", `${name}.json`);
	const footerData = {
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => null,
		onBranchChange: () => () => {},
	};
	const tui = {
		terminal: { write: () => {} },
		invalidate() {},
		requestRender() {},
	} as unknown as TUI;
	const ui = {
		theme,
		setTheme: (name: string) => {
			setThemeCalls.push(name);
			theme.name = name;
			theme.sourcePath = themePath(name);
			return { success: true };
		},
		setFooter: (factory: unknown) => {
			if (typeof factory === "function") {
				(factory as (t: TUI, themeValue: typeof theme, data: typeof footerData) => unknown)(tui, theme, footerData);
			}
		},
		setEditorComponent: () => {},
		setWorkingVisible: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
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
	const previousStateDir = process.env.PI_1337_STATE_DIR;
	const previousTheme = process.env.PI_1337_THEME;
	const previousDisable = process.env.PI_1337_DISABLE;
	const previousBg = process.env.PI_1337_BG;
	process.env.PI_1337_STATE_DIR = stateDir;
	delete process.env.PI_1337_THEME;
	delete process.env.PI_1337_DISABLE;
	process.env.PI_1337_BG = "off";
	try {
		pi1337(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		assert.equal(theme.name, "1337-cyber", "config-file theme seeds a foreign initial theme");

		// `/settings` changes Pi's persisted/current theme while this extension is active.
		theme.name = "1337-skynet";
		theme.sourcePath = themePath("1337-skynet");
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);
		assert.equal(theme.name, "1337-skynet", "shutdown keeps a later manual selection");

		// `/reload` installs a fresh extension factory after Pi has restored its settings.
		pi1337(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
		assert.equal(theme.name, "1337-skynet");
		assert.deepEqual(setThemeCalls, ["1337-cyber"], "the config file must not replace Pi's persisted palette on reload");
	} finally {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);
		if (previousStateDir === undefined) delete process.env.PI_1337_STATE_DIR;
		else process.env.PI_1337_STATE_DIR = previousStateDir;
		if (previousTheme === undefined) delete process.env.PI_1337_THEME;
		else process.env.PI_1337_THEME = previousTheme;
		if (previousDisable === undefined) delete process.env.PI_1337_DISABLE;
		else process.env.PI_1337_DISABLE = previousDisable;
		if (previousBg === undefined) delete process.env.PI_1337_BG;
		else process.env.PI_1337_BG = previousBg;
		rmSync(stateDir, { recursive: true, force: true });
	}
});
