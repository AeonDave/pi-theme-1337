/**
 * `npm run preview` — what a session looks like in each bundled palette, without
 * launching Pi. Not a test (the `npm test` glob is test/*.test.ts), like parity.ts.
 *
 * Every row comes from the package's real code inside the host's real components:
 * ToolExecutionComponent rows resolved to createSwitchableToolView(createToolView),
 * folded by a real createToolRunRegistry fed the calls src/index.ts makes, the
 * host's AssistantMessageComponent, makeFramedEditorFactory for the editor, and
 * the host's CustomEntryComponent around createRunSummaryRow for summary rows.
 * Only the captions are authored here. The host passes its *global* theme to
 * renderers, markdown and syntax highlighting, so each palette is installed with
 * setThemeInstance before any of its components is built (never reused across
 * palettes: components capture the theme they were built with). Neither theme
 * helper nor the app KeybindingsManager is a root export, hence the dist imports,
 * as test/tool-adapter.test.ts does.
 *
 * The terminal is never changed (no OSC 11): the palette's page background is
 * painted into the printed cells instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent, getLanguageFromPath, getSelectListTheme, highlightCode, keyHint, ToolExecutionComponent,
	type ExtensionContext, type Theme, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	Box, Container, getCapabilities, setKeybindings, Text, truncateToWidth as piTruncateToWidth, visibleWidth as piVisibleWidth, type TUI,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { makeFramedEditorFactory } from "../src/editor.ts";
import { nextQuota, nextQuotaMessage, quotaView, type QuotaView } from "../src/quota.ts";
import { createRunSummaryRow, RUN_SUMMARY_TYPE, RUN_SUMMARY_VERSION, type RunSummaryData } from "../src/run-summary.ts";
import { normalizeHex } from "../src/background.ts";
import { DEFAULT_MAX_WIDTH } from "../src/config.ts";
import { DEFAULT_SPINNER, parseSpinner, type SpinnerProfile } from "../src/spinner.ts";
import { createActivityTracker, createRunClock, currentActivity, type Activity } from "../src/tool-activity.ts";
import { createFlatToolView, createSwitchableToolView } from "../src/tool-adapter.ts";
import { createToolRunRegistry, type ToolRunRegistry } from "../src/tool-groups.ts";
import { createToolView } from "../src/tool-view.ts";
import { stripAnsi, useTerminalMetrics, visibleWidth } from "../src/width.ts";

// Exactly as src/index.ts: measure with the renderer's own ruler.
useTerminalMetrics({
	visibleWidth: piVisibleWidth,
	truncateToWidth: (text, max, ellipsis = "…") => piTruncateToWidth(text, max, ellipsis),
});
// Pi's default app bindings (no user file is read), so hints say what Pi says: "ctrl+o to expand".
const keybindings = new KeybindingsManager();
setKeybindings(keybindings);

// Mirrors src/index.ts MAX_WIDTH / MIN_MARGIN (not exported; importing index.ts would boot the extension).
const MAX_WIDTH = DEFAULT_MAX_WIDTH;
const MIN_MARGIN = 2;
const THEMES = new URL("../themes/", import.meta.url);
const CWD = "/home/dev/src/pi-1337";
const USAGE = `usage: npm run preview -- [palette ...] [--all] [--width N] [--plain] [--help]
  palette    one or more bundled palette names (default: 1337)
  --all      every bundled palette
  --width N  render width, clamped to 40..160 (default: terminal columns, 100 when not a TTY)
  --plain    strip ANSI (for piping and diffing runs)`;

type Lines = string[];
type Result = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError: boolean; durationMs?: number };

/** One palette's live objects: its Theme, a fresh run registry, and the renderers index.ts would register. */
interface Session {
	theme: Theme;
	runs: ToolRunRegistry;
	renderers(name: string): ToolRenderers;
	spinner: SpinnerProfile;
	nextId(): string;
}

function openSession(name: string): Session {
	const theme = loadThemeFromPath(fileURLToPath(new URL(`${name}.json`, THEMES)), "truecolor");
	setThemeInstance(theme);
	const runs = createToolRunRegistry();
	const expandHint = () => keyHint("app.tools.expand", "to expand");
	const cache = new Map<string, ToolRenderers>();
	let id = 0;
	return {
		theme, runs,
		spinner: readSpinner(name),
		nextId: () => `call-${++id}`,
		renderers(tool) {
			let renderers = cache.get(tool);
			if (!renderers) {
				renderers = createSwitchableToolView(createToolView(tool, expandHint, {
					highlightCode: (code, path) => {
						const language = getLanguageFromPath(path);
						return language ? highlightCode(code, language) : code.split("\n");
					},
				}), undefined, () => true, { Box, Container, Text, toolName: tool, expandHint,
					imagesSupported: () => getCapabilities().images !== null, groups: runs }, Symbol(`pi1337-tool-row:${tool}`));
				cache.set(tool, renderers);
			}
			return renderers;
		},
	};
}

function readSpinner(name: string): SpinnerProfile {
	try {
		const sidecar = JSON.parse(readFileSync(new URL(`${name}.pi1337`, THEMES), "utf8")) as { spinner?: unknown };
		return parseSpinner(sidecar.spinner) ?? DEFAULT_SPINNER;
	} catch { return DEFAULT_SPINNER; }
}

/** A host tool row announced through the events index.ts forwards to the registry. */
function startCall(s: Session, tool: string, args: Record<string, unknown>) {
	const id = s.nextId();
	const row = new ToolExecutionComponent(tool, id, args, { outputPad: 1 }, s.renderers(tool), { requestRender() {} } as TUI, CWD);
	row.setArgsComplete();
	row.markExecutionStarted();
	s.runs.onToolStart(id, tool, { args, cwd: CWD });
	return {
		row,
		partial(text: string) { row.updateResult(result(text, false), true); },
		end(text: string, options: { isError?: boolean; durationMs?: number; details?: unknown } = {}) {
			row.updateResult(result(text, options.isError ?? false, options.durationMs, options.details), false);
		},
	};
}
type Call = ReturnType<typeof startCall>;

const result = (text: string, isError: boolean, durationMs?: number, details?: unknown): Result =>
	({ content: [{ type: "text", text }], details, isError, durationMs });

/** An assistant message: painted by the host, and it closes the open run (index.ts message_* handlers). */
function say(s: Session, text: string) {
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse" };
	s.runs.onMessage(message);
	return new AssistantMessageComponent(message as ConstructorParameters<typeof AssistantMessageComponent>[0], true, undefined, "∴ thinking", 1);
}

const path = (file: string) => `${CWD}/${file}`;
const caption = (s: Session, width: number, text: string): Lines => ["", s.theme.fg("dim", piTruncateToWidth(` ${text}`, width, "…"))];
const rows = (width: number, components: Array<{ render(width: number): string[] }>): Lines => components.flatMap(c => c.render(width));

// ---- scenes ---------------------------------------------------------------

/** 1 + 2: one exploration run, while open and after it settles and folds. */
function explorationScenes(s: Session, width: number): Lines {
	const intro = say(s, "Let me see how the run registry decides what folds.");
	const readGroups = startCall(s, "read", { path: path("src/tool-groups.ts") });
	readGroups.end("/**\n * Pure registry that folds runs of consecutive exploration calls.", { durationMs: 12 });
	const readAdapter = startCall(s, "read", { path: path("src/tool-adapter.ts") });
	readAdapter.end("import type { ToolRenderers } from \"@earendil-works/pi-coding-agent\";", { durationMs: 9 });
	const grep = startCall(s, "grep", { pattern: "decisionFor", path: CWD });
	grep.partial("src/tool-adapter.ts:117:  ? dependencies.groups.decisionFor(ctx.toolCallId) : normal;");
	const open: Call[] = [readGroups, readAdapter, grep];
	const out = [...caption(s, width, "1. exploration run, still running: nothing folds yet"),
		...rows(width, [intro, ...open.map(c => c.row)])];

	grep.end("src/tool-adapter.ts:117:  ? dependencies.groups.decisionFor(ctx.toolCallId) : normal;\nsrc/tool-groups.ts:27:  decisionFor(callId: string): GroupDecision;", { durationMs: 41 });
	const failed = startCall(s, "grep", { pattern: "foldMarker(", path: path("src") });
	failed.end("Invalid regular expression: missing )", { isError: true, durationMs: 6 });
	const reread = startCall(s, "read", { path: path("src/tool-groups.ts"), offset: 95, limit: 20 });
	reread.end("const foldable = (call: RunCall): boolean => call.ended && !call.failed && !call.images;", { durationMs: 8 });
	const find = startCall(s, "find", { pattern: "*.test.ts", path: path("test") });
	find.end("test/tool-groups.test.ts\ntest/tool-adapter.test.ts", { durationMs: 15 });
	const next = say(s, "The tally sits on the last foldable call; failures keep their own row.");
	// The tally names its files when the row has room for them, and counts them when it has not.
	const narrow = Math.min(width, 44);
	return [...out, ...caption(s, width, "2. same run settled, next message arrived: tally names the files + failure"),
		...rows(width, [intro, ...open.map(c => c.row), failed.row, reread.row, find.row, next]),
		...caption(s, width, `2b. the same tally in ${narrow} columns: counted`), ...rows(narrow, [find.row])];
}

/** 3: bash rows in every state, and what quiet rows found. */
function bashScene(s: Session, width: number): { lines: Lines; failed: { args: Record<string, unknown>; text: string } } {
	const slow = startCall(s, "bash", { command: "npm test" });
	slow.end("# tests 337\n# pass 337\n# fail 0", { durationMs: 6400 });
	// Two searches read fine as rows (no tally): each header says what it found.
	const found = startCall(s, "grep", { pattern: "tallyDetails", path: path("src") });
	found.end("src/tool-groups.ts:22:import { isFoldableTool, tallyDetails } from \"./tool-lexicon.ts\";\nsrc/tool-groups.ts:118:\tconst detailed = tallyDetails(members);\nsrc/tool-lexicon.ts:131:export function tallyDetails(calls: Iterable<TalliedCall>): string {", { durationMs: 30 });
	const none = startCall(s, "grep", { pattern: "foldMarker", path: path("src") });
	none.end("No matches found", { durationMs: 25 });
	const quick = startCall(s, "bash", { command: "git status --short" });
	quick.end(" M src/tool-groups.ts\n M test/tool-groups.test.ts", { durationMs: 140 });
	const script = startCall(s, "bash", { command: "set -e\nfor f in src/tool-*.ts; do\n  wc -l \"$f\"\ndone" });
	script.end("  131 src/tool-lexicon.ts\n  188 src/tool-groups.ts\n  319 src/tool-adapter.ts", { durationMs: 60 });
	// Long enough that only its newest lines fit: the preview must follow the run's end.
	const running = startCall(s, "bash", { command: "npm run test:unit", timeout: 120 });
	const cases = ["width math", "path formatting", "rule detection", "status row", "run tallies", "tool rows", "theme contract"];
	running.partial(["", "> pi-1337@0.5.0 test:unit", "> node --import tsx --test test/*.test.ts", "",
		...Array.from({ length: 44 }, (_, i) => `ok ${i + 1} - ${cases[i % cases.length]} ${Math.floor(i / cases.length) + 1}`)].join("\n"));
	const failedArgs = { command: "node --import tsx --test test/frame.test.ts" };
	const failedText = [
		"not ok 3 - status row narrows semantically",
		"  error: 'Expected values to be strictly equal'",
		"  expected: '…/pi-1337 · main'",
		"  actual:   '…/pi-1337 · mai'",
		"  at test/frame.test.ts:212:10",
		"# fail 1",
	].join("\n");
	const failed = startCall(s, "bash", failedArgs);
	failed.end(failedText, { isError: true, durationMs: 1900 });
	return {
		lines: [...caption(s, width, "3. outcomes: bash slow, grep found / none, bash quick, script, running, failed"),
			...rows(width, [slow, found, none, quick, script, running, failed].map(c => c.row))],
		failed: { args: failedArgs, text: failedText },
	};
}

/** 4: an edit with a replaced pair, an added line and context; then a write. */
function fileScene(s: Session, width: number): Lines {
	const diff = [
		" 104 \tfor (const call of members) fold.set(call, HIDDEN);",
		"-105 \tfold.set(members[0]!, { kind: \"summary\", sentence });",
		"+105 \tfold.set(members[members.length - 1]!, { kind: \"summary\", sentence });",
		" 106 \treturn fold;",
		"+107 \t// The carrier is the last foldable call.",
		" 108 }",
	].join("\n");
	const edit = startCall(s, "edit", { path: path("src/tool-groups.ts"), oldText: "members[0]", newText: "members[members.length - 1]" });
	edit.end("Successfully replaced text in src/tool-groups.ts.", { durationMs: 20, details: { diff } });
	const content = "# Changelog\n\n## Unreleased\n\n- Fold settled exploration runs into one tally row.\n";
	const write = startCall(s, "write", { path: path("CHANGELOG.md"), content });
	write.end("Successfully wrote 87 bytes to CHANGELOG.md", { durationMs: 4 });
	return [...caption(s, width, "4. edit diff (changed span in bold) and write"), ...rows(width, [edit.row, write.row])];
}

/** 5: Ctrl+O form of a read row and of the failed bash row. */
function expandedScene(s: Session, width: number, failed: { args: Record<string, unknown>; text: string }): Lines {
	const read = startCall(s, "read", { path: path("src/tool-lexicon.ts"), offset: 48, limit: 3 });
	read.end([
		"\t[\"bash\", { title: \"$\", doing: \"Running\", quiet: true }],",
		"\t[\"read\", { title: \"Read\", doing: \"Reading\", quiet: true, tally: READ }],",
		"\t[\"grep\", { title: \"Search\", doing: \"Searching\", quiet: true, tally: SEARCHED }],",
	].join("\n"), { durationMs: 7 });
	const bash = startCall(s, "bash", failed.args);
	bash.end(failed.text, { isError: true, durationMs: 1900 });
	for (const call of [read, bash]) call.row.setExpanded(true);
	return [...caption(s, width, "5. expanded: a read and the failed bash"), ...rows(width, [read.row, bash.row])];
}

/** 5b: third-party renderers (as pi-persona or an MCP adapter ships them) keep their content and take the flat shell. */
function thirdPartyScene(s: Session, width: number): Lines {
	// What such an extension registers: both hooks, the host's default box, its own colors.
	const renderers: ToolRenderers = {
		renderCall: (args, theme) => {
			const { title, detail } = args as { title: string; detail: string };
			return new Text(`${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", detail)}`, 0, 0);
		},
		renderResult: (value, _options, theme, context) => {
			const [first = "", ...rest] = value.content.flatMap(block => block.type === "text" ? block.text.split("\n") : []);
			const [verb = "", ...words] = first.split(" ");
			return new Text([`${theme.fg(context.isError ? "error" : "accent", theme.bold(verb))} ${theme.fg("toolOutput", words.join(" "))}`,
				...rest.map(line => theme.fg(context.isError ? "toolOutput" : "dim", line))].join("\n"), 0, 0);
		},
	};
	const call = (tool: string, args: Record<string, unknown>, text: string, isError = false) => {
		const id = s.nextId();
		const row = new ToolExecutionComponent(tool, id, args, { outputPad: 1 },
			createFlatToolView(renderers, () => true, { Box, Container, Text, toolName: tool }), { requestRender() {} } as TUI, CWD);
		row.setArgsComplete();
		row.markExecutionStarted();
		s.runs.onToolStart(id, tool, { args, cwd: CWD, rendersHere: false }); // as src/index.ts: never folds, ends the run above it
		row.updateResult(result(text, isError), false);
		return row;
	};
	const delegate = call("delegate", { title: "delegate", detail: "parallel (3) · high" }, [
		"launched auth-review · reviewer · opus-4-8 · high",
		"    token-tests · tester · sonnet-4-6 · high",
		"    docs-pass · writer · haiku-4-5 · medium",
	].join("\n"));
	const monitor = call("monitor", { title: "monitor arm", detail: "CI run finished" }, [
		"failed to arm CI run finished",
		"no workflow run matches branch feat/tool-runs",
	].join("\n"), true);
	return [...caption(s, width, "5b. third-party renderers in the flat shell: a launched delegate, a failed monitor"), ...rows(width, [delegate, monitor])];
}

/** 6: the framed editor — border label, status groups and the activity overlay. */
function editorScene(s: Session, width: number): Lines {
	const tracker = createActivityTracker();
	const runClock = createRunClock(); // started for 6g only: the earlier frames show the tool label alone
	let working = false;
	const now = 70_000; // injected clock: every call below has outlived the grace period
	const make = (options: { reasoning: boolean; persona?: string; delta?: string; maxWidth?: number; provider?: string; id?: string; quota?: QuotaView; session?: string }) => {
		const editor = makeFramedEditorFactory({
			ctx: { cwd: CWD, model: { id: options.id ?? "claude-opus-4-8", provider: options.provider ?? "anthropic", reasoning: options.reasoning }, ui: { theme: s.theme } } as unknown as ExtensionContext,
			getThinkingLevel: () => "high",
			getPersona: () => options.persona,
			getGitBranch: () => "feat/tool-runs",
			getSessionName: () => options.session ?? "fold tallies",
			getContextUsage: () => ({ tokens: 136_900, contextWindow: 1_000_000, percent: 13.7 }),
			getCost: () => "~$48.89",
			getRunDelta: () => options.delta ?? "",
			getQuota: () => options.quota,
			isWorking: () => working,
			isWaitingForUser: () => false,
			getActivity: (): Activity | undefined => currentActivity(tracker, runClock, now),
			spinnerFrame: () => s.spinner.frames[0]!,
			spinnerRows: () => s.spinner.frameRows(0),
			spinnerColor: () => s.spinner.color,
			spinnerHeight: () => s.spinner.height,
			spinnerColumns: () => s.spinner.columns,
			bindTui() {},
			bindEditor() {},
			maxWidth: options.maxWidth ?? MAX_WIDTH,
			minMargin: MIN_MARGIN,
		})(
			{ terminal: { rows: 40, columns: width }, requestRender() {} } as unknown as TUI,
			{ borderColor: (text: string) => s.theme.fg("borderMuted", text), selectList: getSelectListTheme() },
			keybindings,
		);
		editor.focused = true;
		editor.setText("tighten the tally wording");
		return editor;
	};
	const out: Lines = [];
	const frame = (editor: ReturnType<typeof make>, text: string) => out.push(...caption(s, width, text), ...editor.render(width));
	const persona = make({ reasoning: true, persona: "💻 Dev", delta: "+$1.24" });
	frame(persona, "6a. idle: model · level in the border; usage, cost, run delta and a persona");
	frame(make({ reasoning: false, provider: "openai", id: "gpt-4.1" }), "6b. a reasoning-off model, no persona, no run yet");
	frame(make({ reasoning: true, persona: "💻 Dev", delta: "+$1.24", maxWidth: 48 }), "6c. a narrow box: ornaments go first, then detail");
	working = true;
	tracker.onStart("a", "bash", { command: "npm test" }, now - 1_200);
	frame(persona, "6d. working, activity label (younger than 3 s: no counter)");
	tracker.clear();
	tracker.onStart("a", "bash", { command: "npm test" }, now - 14_000);
	tracker.onStart("b", "read", { path: path("src/frame.ts") }, now - 900);
	tracker.onStart("c", "grep", { pattern: "statusOverlay" }, now - 900);
	frame(persona, "6e. working, label + elapsed time + two siblings");
	tracker.clear();
	tracker.onStart("d", "bash", { command: "node --import tsx --test test/frame.test.ts test/editor.test.ts test/tool-groups.test.ts" }, now - 65_000);
	frame(persona, "6f. working, label longer than the workspace cells (its time yields before it trims)");
	tracker.clear();
	runClock.start(now - 45_000);
	frame(persona, "6g. working, no tool named (thinking or streaming): the run clock");
	// Subscription quota: views built by the real reducer from the headers a provider
	// sends (percent used per window), at an injected clock of its own. An unnamed
	// session, so the row has room to show each form at the usual widths.
	working = false;
	runClock.stop();
	const quota = (fiveHour: number | undefined, week: number | undefined, limited = false): QuotaView | undefined => {
		const at = Date.UTC(2026, 10, 17, 12);
		const seconds = at / 1000;
		const headers = {
			...(fiveHour === undefined ? {} : { "anthropic-ratelimit-unified-5h-utilization": String(fiveHour / 100), "anthropic-ratelimit-unified-5h-reset": String(seconds + 2 * 3600) }),
			...(week === undefined ? {} : { "anthropic-ratelimit-unified-7d-utilization": String(week / 100), "anthropic-ratelimit-unified-7d-reset": String(seconds + 3 * 86_400) }),
		};
		let state = nextQuota(undefined, { status: 200, headers, api: "anthropic-messages", provider: "anthropic" }, at);
		if (limited) state = nextQuotaMessage(state, { role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }, "anthropic", at);
		return quotaView(state, { provider: "anthropic", api: "anthropic-messages" }, at);
	};
	const withQuota = (view: QuotaView | undefined) => make({ reasoning: true, persona: "💻 Dev", delta: "+$1.24", quota: view, session: "" });
	frame(withQuota(quota(43, 12)), "6h. quota, two windows, calm: five-hour and weekly, percent used");
	frame(withQuota(quota(undefined, 85)), "6i. quota, one window above 70%: it warns and stays while detail goes");
	frame(withQuota(quota(43, 12, true)), "6j. quota, the usage limit reached: limit replaces the windows");
	frame(withQuota(undefined), "6k. no quota known: the row as it is without one");
	return out;
}

/** 7: end-of-run summary rows, through Pi's own entry component (its spacer included). */
function summaryScene(s: Session, width: number): Lines {
	const base: RunSummaryData = {
		v: RUN_SUMMARY_VERSION, outcome: "done", durationMs: 134_000, edited: 0, added: 0, removed: 0, wrote: 0,
		commands: 0, commandsFailed: 0, tools: 0, toolsFailed: 0, cost: 0, files: [], moreFiles: 0,
	};
	const files: RunSummaryData["files"] = [
		{ path: "src/tool-groups.ts", kind: "edit", added: 31, removed: 5, lines: 0, script: false },
		{ path: "src/tool-lexicon.ts", kind: "edit", added: 9, removed: 2, lines: 0, script: false },
		{ path: "test/tool-groups.test.ts", kind: "edit", added: 2, removed: 0, lines: 0, script: true },
		{ path: "CHANGELOG.md", kind: "write", added: 0, removed: 0, lines: 40, script: false },
	];
	const forms: RunSummaryData[] = [
		{ ...base, edited: 3, added: 42, removed: 7, wrote: 1, commands: 6, commandsFailed: 1, tools: 14, toolsFailed: 1, cost: 1.24, files, modelMs: 92_000, thinkingMs: 40_000, outputTokens: 4_416 },
		{ ...base, outcome: "interrupted", durationMs: 62_000, edited: 1, added: 3, commands: 2, tools: 4 },
		{ ...base, outcome: "failed", durationMs: 12_000, commands: 2, commandsFailed: 1, tools: 2, toolsFailed: 1 },
		{ ...base, durationMs: 38_000, tools: 9 },
		// Settled while pi-persona still had work in the background: not "Done".
		{ ...base, durationMs: 9_000, tools: 7, cost: 0.08, waiting: { agents: 3, monitors: 1, timers: 1, scripts: 1 } },
	];
	const row = (data: RunSummaryData, expanded = false) => {
		const component = new CustomEntryComponent({ type: "custom", customType: RUN_SUMMARY_TYPE, data, id: "preview", parentId: null, timestamp: "" },
			(entry, options, theme) => createRunSummaryRow(entry.data, options.expanded, theme, 1, () => keyHint("app.tools.expand", "to expand")));
		component.setExpanded(expanded);
		return component;
	};
	return [...caption(s, width, "7. run summaries: done, interrupted, failed, tool calls only, background work still running"), ...rows(width, forms.map(data => row(data))),
		...caption(s, width, "7b. the first one expanded: where the time went, then one row per file"), ...rows(width, [row(forms[0]!, true)])];
}

function scene(name: string, width: number): Lines {
	const s = openSession(name);
	// Transcript order matters: each scene's calls reach the one registry in sequence.
	const header = s.theme.fg("accent", s.theme.bold(piTruncateToWidth(name, width, "…")));
	const exploration = explorationScenes(s, width);
	const bash = bashScene(s, width);
	const files = fileScene(s, width);
	const expanded = expandedScene(s, width, bash.failed);
	return [header, ...exploration, ...bash.lines, ...files, ...expanded, ...thirdPartyScene(s, width), ...editorScene(s, width), ...summaryScene(s, width)];
}

// ---- output ---------------------------------------------------------------

/** The palette's page background under every cell, re-asserted after each inner reset. */
function canvas(pageBg: string | undefined, width: number): (line: string) => string {
	const hex = normalizeHex(pageBg);
	if (!hex) return line => line;
	const bg = `\x1b[48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
	return line => bg + line.replace(/\x1b\[(?:0|49)?m/g, match => match + bg) + " ".repeat(Math.max(0, width - visibleWidth(line))) + "\x1b[0m";
}

function paletteNames(): string[] {
	return readdirSync(THEMES).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).sort();
}

function main(argv: string[]): number {
	const names: string[] = [];
	let all = false;
	let plain = false;
	let width: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") { process.stdout.write(`${USAGE}\n`); return 0; }
		else if (arg === "--all") all = true;
		else if (arg === "--plain") plain = true;
		else if (arg === "--width") {
			const value = Number(argv[++i]);
			if (!Number.isFinite(value)) { process.stderr.write(`--width needs a number\n${USAGE}\n`); return 1; }
			width = value;
		} else if (arg.startsWith("-")) { process.stderr.write(`unknown option ${arg}\n${USAGE}\n`); return 1; }
		else names.push(arg);
	}
	const valid = paletteNames();
	const unknown = names.filter(name => !valid.includes(name));
	if (unknown.length) {
		process.stderr.write(`unknown palette ${unknown.join(", ")}; valid: ${valid.join(", ")}\n`);
		return 1;
	}
	const selected = all ? valid : names.length ? names : ["1337"];
	const columns = width ?? (process.stdout.isTTY ? process.stdout.columns : 100);
	width = Math.min(160, Math.max(40, Math.floor(columns)));

	const out: string[] = [];
	for (const [index, name] of selected.entries()) {
		const lines = scene(name, width);
		// A preview that wraps would misrepresent the theme: refuse to print one.
		for (const [row, line] of lines.entries()) {
			if (visibleWidth(line) > width) {
				process.stderr.write(`${name}: row ${row} is ${visibleWidth(line)} columns wide (limit ${width}): ${JSON.stringify(stripAnsi(line))}\n`);
				return 1;
			}
		}
		const pageBg = (JSON.parse(readFileSync(new URL(`${name}.json`, THEMES), "utf8")) as { export?: { pageBg?: string } }).export?.pageBg;
		if (index > 0) out.push("");
		// The host's assistant rows carry OSC 133 prompt-zone marks; a preview must not plant them in scrollback.
		const paint = canvas(pageBg, width);
		out.push(...lines.map(plain ? stripAnsi : line => paint(line.replace(/\x1b\]133;[^\x07]*\x07/g, ""))));
	}
	process.stdout.write(`${out.join("\n")}\n`);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
