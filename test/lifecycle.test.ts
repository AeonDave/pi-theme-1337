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
		registerEntryRenderer() {},
		appendEntry() {},
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
		registerEntryRenderer() {},
		appendEntry() {},
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

/** Drive the extension on Pi's built-in `light` theme (no sourcePath, appearance light). */
async function runLightSession(themeEnv: string | undefined, body: (h: {
	start(): Promise<void>;
	toggle(): Promise<void>;
	theme: { name: string; appearance: "light" | "dark" };
	setThemeCalls: string[];
	calls: string[];
}) => Promise<void>): Promise<void> {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-1337-light-"));
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
		registerEntryRenderer() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const theme = {
		name: "light",
		appearance: "light" as "light" | "dark",
		sourcePath: undefined as string | undefined,
		fg: (_color: string, text: string) => text,
	};
	const setThemeCalls: string[] = [];
	const calls: string[] = [];
	const footerData = {
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => null,
		onBranchChange: () => () => {},
	};
	const tui = { terminal: { write: () => {} }, invalidate() {}, requestRender() {} } as unknown as TUI;
	const ui = {
		theme,
		setTheme: (name: string) => {
			setThemeCalls.push(name);
			theme.name = name;
			theme.appearance = name === "light" ? "light" : "dark";
			theme.sourcePath = name === "light" ? undefined : join(import.meta.dirname, "..", "themes", `${name}.json`);
			return { success: true };
		},
		setFooter: (factory: unknown) => {
			calls.push(factory ? "footer:on" : "footer:off");
			if (typeof factory === "function") (factory as (t: TUI, themeValue: typeof theme, data: typeof footerData) => unknown)(tui, theme, footerData);
		},
		setEditorComponent: (factory: unknown) => calls.push(factory ? "editor:on" : "editor:off"),
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
	const saved = { state: process.env.PI_1337_STATE_DIR, theme: process.env.PI_1337_THEME, disable: process.env.PI_1337_DISABLE, bg: process.env.PI_1337_BG };
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	process.env.PI_1337_STATE_DIR = stateDir; // empty: no config-file palette
	restore("PI_1337_THEME", themeEnv);
	delete process.env.PI_1337_DISABLE;
	process.env.PI_1337_BG = "off";
	try {
		pi1337(api);
		await body({
			start: async () => {
				await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			},
			toggle: async () => {
				await commands.get("theme-1337")?.handler("", ctx);
			},
			theme,
			setThemeCalls,
			calls,
		});
	} finally {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		restore("PI_1337_STATE_DIR", saved.state);
		restore("PI_1337_THEME", saved.theme);
		restore("PI_1337_DISABLE", saved.disable);
		restore("PI_1337_BG", saved.bg);
		rmSync(stateDir, { recursive: true, force: true });
	}
}

test("a light session keeps its theme and still gets the framed chrome", async () => {
	await runLightSession(undefined, async ({ start, toggle, theme, setThemeCalls, calls }) => {
		await start();
		assert.equal(theme.name, "light");
		assert.deepEqual(setThemeCalls, [], "no dark palette is forced onto a light theme");
		assert.ok(calls.includes("editor:on"), "framed editor installed");
		assert.ok(calls.includes("footer:on"), "footer installed");

		await toggle(); // off
		assert.ok(calls.includes("editor:off"));
		await toggle(); // on
		assert.equal(calls.filter((c) => c === "editor:on").length, 2, "re-enable reinstalls the editor");
		assert.equal(theme.name, "light");
		assert.deepEqual(setThemeCalls, [], "toggling off and on changes no theme");
	});
});

test("a light session with an explicit palette pin switches and restores on toggle-off", async () => {
	await runLightSession("1337-ice", async ({ start, toggle, theme, setThemeCalls }) => {
		await start();
		assert.equal(theme.name, "1337-ice");
		await toggle(); // off
		assert.equal(theme.name, "light", "toggle-off restores the light theme");
		assert.deepEqual(setThemeCalls, ["1337-ice", "light"]);
	});
});

// ---- the editor slot is shared with other extensions ------------------------

type SlotFactory = (...args: unknown[]) => unknown;

/**
 * Drive the extension against a host-shaped editor slot: `setEditorComponent`
 * stores the factory and instantiates it at once, as Pi does, and
 * `getEditorComponent` hands the stored factory back (absent with `getter: false`,
 * the shape of a host or mock from before the getter existed).
 */
async function runEditorSlot(body: (h: {
	start(): Promise<void>;
	toggle(): Promise<void>;
	shutdown(): Promise<void>;
	/** What another extension does: install its own editor factory. */
	install(factory: SlotFactory | undefined): void;
	slot(): SlotFactory | undefined;
	/** Every setEditorComponent call since the last `install`, as "set" / "unset". */
	ourCalls(): string[];
	calls: string[];
}) => Promise<void>, options: { getter?: boolean } = {}): Promise<void> {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-1337-slot-"));
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
		registerEntryRenderer() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const identity = (text: string) => text;
	const theme = { name: "1337", sourcePath: join(import.meta.dirname, "..", "themes", "1337.json"), fg: (_color: string, text: string) => text };
	const footerData = { getExtensionStatuses: () => new Map<string, string>(), getGitBranch: () => null, onBranchChange: () => () => {} };
	const tui = { terminal: { rows: 40, columns: 100, write() {} }, invalidate() {}, requestRender() {} } as unknown as TUI;
	const editorTheme = { borderColor: identity, selectList: {
		text: identity, selectedText: identity, description: identity, selectedDescription: identity, scrollIndicator: identity,
	} };
	let slot: SlotFactory | undefined;
	let ourCalls: string[] = [];
	const calls: string[] = [];
	const setEditorComponent = (factory: SlotFactory | undefined) => {
		ourCalls.push(factory ? "set" : "unset");
		slot = factory;
		factory?.(tui, editorTheme, { matches: () => false });
	};
	const ui = {
		theme,
		setTheme: () => ({ success: true }),
		setFooter: (factory: unknown) => {
			calls.push(factory ? "footer:on" : "footer:off");
			if (typeof factory === "function") (factory as (t: TUI, themeValue: typeof theme, data: typeof footerData) => unknown)(tui, theme, footerData);
		},
		setEditorComponent,
		...(options.getter === false ? {} : { getEditorComponent: () => slot }),
		setWorkingVisible: (visible: boolean) => calls.push(`working:${String(visible)}`),
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setTitle: () => {},
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
	const saved = { state: process.env.PI_1337_STATE_DIR, theme: process.env.PI_1337_THEME, disable: process.env.PI_1337_DISABLE, bg: process.env.PI_1337_BG };
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	process.env.PI_1337_STATE_DIR = stateDir;
	process.env.PI_1337_THEME = "off";
	delete process.env.PI_1337_DISABLE;
	process.env.PI_1337_BG = "off";
	const shutdown = async () => {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	};
	try {
		pi1337(api);
		await body({
			start: async () => {
				await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			},
			toggle: async () => {
				await commands.get("theme-1337")?.handler("", ctx);
			},
			shutdown,
			install(factory) {
				setEditorComponent(factory);
				ourCalls = [];
			},
			slot: () => slot,
			ourCalls: () => ourCalls,
			calls,
		});
	} finally {
		await shutdown(); // release process.stderr ownership whatever the body asserted
		restore("PI_1337_STATE_DIR", saved.state);
		restore("PI_1337_THEME", saved.theme);
		restore("PI_1337_DISABLE", saved.disable);
		restore("PI_1337_BG", saved.bg);
		rmSync(stateDir, { recursive: true, force: true });
	}
}

/** Another extension's editor factory, counting how often the host built it. */
function foreignEditor(failFrom = Infinity) {
	const factory = Object.assign((): unknown => {
		factory.built++;
		if (factory.built >= failFrom) throw new Error("foreign editor failed to construct");
		return { render: () => [], invalidate() {} };
	}, { built: 0 });
	return factory;
}

test("toggle-off restores the editor another extension installed before us, and a re-enable repeats it", async () => {
	await runEditorSlot(async ({ start, toggle, install, slot, ourCalls, calls }) => {
		const foreign = foreignEditor();
		install(foreign);
		await start();
		const ours = slot();
		assert.ok(ours && ours !== foreign, "our framed editor takes the slot");
		await toggle(); // off
		assert.equal(slot(), foreign, "the earlier editor is back, not Pi's default");
		assert.equal(foreign.built, 2, "the host rebuilt it from its own factory");
		assert.deepEqual(ourCalls(), ["set", "set"], "one install, one restore: never an unset in between");
		assert.ok(calls.includes("footer:off") && calls.includes("working:true"), "the rest of the chrome is restored too");

		await toggle(); // on
		assert.ok(slot() && slot() !== foreign && slot() !== ours, "a fresh framed editor");
		await toggle(); // off
		assert.equal(slot(), foreign, "and the same editor comes back again");
	});
});

test("an editor another extension installed after us survives toggle-off and shutdown untouched", async () => {
	await runEditorSlot(async ({ start, toggle, shutdown, install, slot, ourCalls, calls }) => {
		await start();
		const later = foreignEditor();
		install(later);
		await toggle(); // off
		assert.equal(slot(), later, "not ours any more: left in place");
		assert.deepEqual(ourCalls(), [], "the slot was not touched at all");
		assert.equal(later.built, 1);
		assert.ok(calls.includes("footer:off") && calls.includes("working:true"), "our own chrome still goes");

		await toggle(); // on: ours over theirs, as at load
		assert.notEqual(slot(), later);
		install(later); // they take the slot back while we are on
		await shutdown();
		assert.equal(slot(), later, "shutdown leaves a foreign editor alone as well");
		assert.deepEqual(ourCalls(), []);
	});
});

test("shutdown empties our slot and never builds another extension's editor", async () => {
	await runEditorSlot(async ({ start, shutdown, install, slot, ourCalls }) => {
		const foreign = foreignEditor();
		install(foreign);
		await start();
		await shutdown();
		assert.equal(slot(), undefined, "the slot is emptied; the host is tearing the session down");
		assert.equal(foreign.built, 1, "its factory was not called during shutdown");
		assert.deepEqual(ourCalls(), ["set", "unset"]);
		await shutdown(); // a second shutdown finds nothing of ours
		assert.deepEqual(ourCalls(), ["set", "unset"]);
	});
});

test("a restore that throws falls back to Pi's own editor and still clears the rest", async () => {
	await runEditorSlot(async ({ start, toggle, install, slot, ourCalls, calls }) => {
		const foreign = foreignEditor(2); // builds once, fails when rebuilt
		install(foreign);
		await start();
		await toggle(); // off: must not throw
		assert.equal(foreign.built, 2, "the restore was attempted");
		assert.equal(slot(), undefined, "Pi's default editor instead of a half-installed one");
		assert.deepEqual(ourCalls(), ["set", "set", "unset"]);
		assert.ok(calls.includes("footer:off") && calls.includes("working:true"), "the failure did not stop the cleanup");
		await toggle(); // on again: nothing to restore this time
		await toggle(); // off
		assert.equal(slot(), undefined);
		assert.equal(foreign.built, 2, "the editor that was not restored is not remembered");
	});
});

test("our own factory is never remembered as the editor to restore", async () => {
	await runEditorSlot(async ({ start, toggle, install, slot }) => {
		const foreign = foreignEditor();
		install(foreign);
		await start();
		const first = slot();
		await start(); // session_start again in one session: apply() finds our own factory in the slot
		assert.notEqual(slot(), first);
		await toggle(); // off
		assert.equal(slot(), foreign, "the editor from before us, not our earlier factory");

		// Another extension hands our stale factory back while we are off.
		install(first);
		await toggle(); // on
		await toggle(); // off
		assert.notEqual(slot(), first, "a factory of ours is not what was there before us");
		assert.equal(slot(), undefined);
	});
});

test("a host without getEditorComponent keeps the unconditional reset", async () => {
	await runEditorSlot(async ({ start, toggle, shutdown, install, slot, ourCalls }) => {
		install(foreignEditor());
		await start();
		assert.deepEqual(ourCalls(), ["set"]);
		await toggle(); // off
		assert.equal(slot(), undefined, "ownership cannot be asked: the slot is reset, as it always was");
		await toggle(); // on
		await shutdown();
		assert.equal(slot(), undefined);
		assert.deepEqual(ourCalls(), ["set", "unset", "set", "unset"]);
	}, { getter: false });
});
