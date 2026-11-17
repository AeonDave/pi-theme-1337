import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CustomEditor, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ACTIVITY_ELAPSED_MS, ACTIVITY_MIN_COLUMNS, makeFramedEditorFactory, SESSION_MIN_COLUMNS } from "../src/editor.ts";
import { editorWidthFor, statusSlotWidth } from "../src/frame.ts";
import { chooseBox } from "../src/width.ts";
import { stripAnsi, useTerminalMetrics } from "../src/width.ts";
import { shortCwd, type ContextUsageLike } from "../src/format.ts";
import { nextQuota, nextQuotaMessage, quotaView, QUOTA_STALE_MS, type QuotaView } from "../src/quota.ts";
import type { Activity } from "../src/tool-activity.ts";

const identity = (text: string) => text;

const PALETTES = ["1337", "1337-amber", "1337-ice", "1337-cyber", "1337-cyberpunk-2077", "1337-cyberpunk-2077-edgerunner", "1337-neon", "1337-cosmos", "1337-poison", "1337-magma", "1337-fallout", "1337-skynet", "1337-skynet-dark"];
const THINKING_TOKENS = { minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" } as const;

/** Use actual bundled palettes and the host's ANSI emitter, not marker strings. */
function statusTheme(name: string): Theme {
	const palette = JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8"));
	const resolve = (value: string | number): string | number =>
		typeof value === "string" && value in palette.vars ? resolve(palette.vars[value]) : value;
	const colors = Object.fromEntries(Object.entries(palette.colors).map(([key, value]) => [key, resolve(value as string | number)]));
	return new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
}

interface FixtureOptions {
	height?: number;
	columns?: number;
	color?: { kind: "rgb"; r: number; g: number; b: number };
	working?: boolean;
	waiting?: boolean;
	activity?: () => Activity | undefined;
	reasoning?: boolean;
	thinking?: string;
	cwd?: string;
	persona?: string;
	provider?: string;
	modelId?: string;
}

function statusFixture(options: FixtureOptions = {}) {
	const ui = { theme: statusTheme("1337") };
	const state = {
		usage: { tokens: 136_900, contextWindow: 1_000_000, percent: 13 } as ContextUsageLike | undefined,
		persona: ("persona" in options ? options.persona : "Elite") as string | undefined,
		branch: "main",
		session: "review" as string | undefined,
		cost: "~$48.89",
		delta: "+$1.24",
		quota: undefined as QuotaView | undefined,
		thinking: options.thinking,
	};
	// Reasoning stays off by default so the established rows carry no level.
	const model = { id: options.modelId ?? "gpt-6.1-sol", provider: options.provider ?? "openai", reasoning: options.reasoning ?? false };
	const editor = makeFramedEditorFactory({
		ctx: { cwd: options.cwd ?? "/work/repo", model, ui } as unknown as ExtensionContext,
		getPersona: () => state.persona,
		getGitBranch: () => state.branch,
		getSessionName: () => state.session,
		getContextUsage: () => state.usage,
		getCost: () => state.cost,
		getRunDelta: () => state.delta,
		getQuota: () => state.quota,
		getThinkingLevel: () => state.thinking,
		isWorking: () => options.working ?? false,
		isWaitingForUser: () => options.waiting ?? false,
		getActivity: options.activity,
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
	return { editor, ui, state, model, status: (width = 200) => editor.render(width).at(-2)!, top: (width = 200) => editor.render(width)[0]! };
}

/** Where the right group starts in a colored status row: the first of its pieces present. */
function rightStart(row: string, fixture: ReturnType<typeof statusFixture>): number {
	const { theme } = fixture.ui;
	const { usage, cost, persona } = fixture.state;
	const roles = ["accent", "warning", "error"] as const;
	const pieces = [
		theme.fg("dim", "["),
		theme.fg("dim", "ctx —"),
		theme.fg("muted", cost),
		...(persona ? [theme.fg("text", persona)] : []),
		...roles.flatMap((role) => usage?.tokens != null ? [theme.fg(role, `${(usage.tokens / 1000).toFixed(1)}k`), theme.fg(role, `${Math.round(usage.percent ?? 0)}%`)] : []),
	];
	const found = pieces.map((piece) => row.indexOf(piece, row.indexOf("│") + 2)).filter((at) => at !== -1);
	return found.length ? Math.min(...found) : -1;
}

test("status hierarchy uses active palette roles without adding columns or another row", () => {
	const { editor, ui, status } = statusFixture();
	let plain: string | undefined;
	for (const name of PALETTES) {
		ui.theme = statusTheme(name);
		const row = status();
		for (const [role, label] of [
			["text", " /work/repo"], ["accent", "main"], ["muted", "review"],
			["accent", "▰"], ["dim", "▱▱▱▱"], ["dim", "]"],
			["accent", "136.9k"], ["dim", "/1M"], ["accent", "13%"], ["muted", "~$48.89"], ["dim", " +$1.24"], ["dim", " · "],
			["text", "Elite"],
		] as const) assert.ok(row.includes(ui.theme.fg(role, label)), `${name}: ${label} must use ${role}`);
		plain ??= stripAnsi(row);
		assert.equal(stripAnsi(row), plain, "palette switches must not change geometry or data");
		assert.match(plain, /^ *│ \/work\/repo · main · review +\[▰▱▱▱▱\] 136\.9k\/1M · 13% · ~\$48\.89 \+\$1\.24 · Elite │$/);
		const rows = editor.render(200);
		assert.equal(rows.length, 4, "one input row, one status row, two borders");
		assert.match(stripAnsi(rows[0]).trim(), /^╭─+ openai\/gpt-6\.1-sol ──╮$/, "the model moved into the top border");
		assert.match(stripAnsi(rows.at(-1)!).trim(), /^╰─+╯$/, "the bottom border stays plain");
		assert.ok(!/agents?\b/.test(stripAnsi(rows.join("\n"))), "no agent count");
		assert.ok(!stripAnsi(row).includes("gpt"), "no model on the status row");
	}
});

test("without a persona the right group simply ends after the cost", () => {
	const { status, editor } = statusFixture({ persona: undefined });
	assert.match(stripAnsi(status()), /\[▰▱▱▱▱\] 136\.9k\/1M · 13% · ~\$48\.89 \+\$1\.24 │$/);
	for (let width = 20; width <= 200; width++) assert.ok(!stripAnsi(editor.render(width).join("\n")).includes("·  "), `@${width}: no dangling separator`);
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
	for (const [percent, role] of [[0, "accent"], [70, "accent"], [70.4, "accent"], [70.5, "warning"], [90, "warning"], [90.4, "warning"], [90.5, "error"]] as const) {
		state.usage = { tokens: 70000, contextWindow: 100000, percent };
		const row = status();
		assert.ok(row.includes(ui.theme.fg(role, "70.0k")) && row.includes(ui.theme.fg(role, `${Math.round(percent)}%`)), `${percent}: context uses ${role}`);
		assert.ok(row.includes(ui.theme.fg("muted", "~$48.89")), "context pressure must not color the estimate as a billing warning");
		assert.ok(row.includes(ui.theme.fg("dim", " +$1.24")), "the run delta recedes");
	}
	state.usage = { tokens: 70000, contextWindow: 100000, percent: null };
	assert.match(stripAnsi(status()), /70\.0k\/100k · ~\$48\.89/, "a missing percentage leaves the token count standing");
	state.usage = { tokens: null, contextWindow: 100000, percent: null };
	assert.ok(status().includes(ui.theme.fg("dim", "ctx —")));
	assert.match(stripAnsi(status()), /ctx — · ~\$48\.89 \+\$1\.24 · Elite │$/, "unknown usage takes no gauge or denominator");
});

test("with no usage, no cost and no persona the right group is empty", () => {
	const { state, status } = statusFixture({ persona: undefined });
	state.usage = undefined;
	state.cost = "";
	for (let width = 20; width <= 200; width++) {
		const plain = stripAnsi(status(width));
		assert.doesNotMatch(plain, /ctx|\$|%|·\s+│/, `@${width}: ${plain}`);
	}
	assert.match(stripAnsi(status()), /^ *│ \/work\/repo · main · review +│$/);
	state.delta = "+$9.99";
	assert.doesNotMatch(stripAnsi(status()), /\+\$/, "a delta never shows without the cost");
	state.persona = "Elite";
	assert.match(stripAnsi(status()), /review +Elite │$/, "a persona alone stands without a separator");
});

test("the context window is a compact denominator after the token count", () => {
	const { state, status } = statusFixture();
	for (const [window, label] of [[200_000, "/200k"], [1_000_000, "/1M"], [128_000, "/128k"], [1_048_576, "/1.05M"]] as const) {
		state.usage = { tokens: 136_900, contextWindow: window, percent: 13 };
		assert.ok(stripAnsi(status()).includes(`136.9k${label} · 13%`), `${window} → ${label}`);
	}
	for (const window of [0, -1, Number.NaN]) {
		state.usage = { tokens: 136_900, contextWindow: window, percent: 13 };
		assert.ok(stripAnsi(status()).includes("136.9k · 13%"), `${window}: no denominator`);
		assert.ok(!stripAnsi(status()).includes("136.9k/"));
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
		assert.ok(!/[▰▱]/.test(stripAnsi(status(60))), "a row too narrow for the full content omits the gauge");
		assert.ok(stripAnsi(status(80)).includes(`${Math.round(percent)}%`), "the percentage is unchanged when gauge is omitted");
	}
	for (const percent of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
		state.usage = { tokens: 70000, contextWindow: 100000, percent };
		assert.ok(!/[▰▱]/.test(stripAnsi(status())), "unknown/nonfinite percentage cannot imply measured capacity");
	}
	state.usage = { tokens: null, contextWindow: 100000, percent: 70 };
	assert.ok(!/[▰▱]/.test(stripAnsi(status())), "unknown tokens cannot imply measured capacity");
});

test("gauge appears only at the exact full-content fit boundary and never displaces content", () => {
	const { status } = statusFixture();
	const full = ["/work/repo · main · review", "136.9k · 13%", "~$48.89", "Elite"];
	let firstGaugeWidth: number | undefined;
	for (let width = 20; width <= 180; width++) {
		if (stripAnsi(status(width)).includes("[▰▱▱▱▱]")) { firstGaugeWidth = width; break; }
	}
	assert.ok(firstGaugeWidth !== undefined, "a sufficiently wide exact-fit status can show the gauge");
	const exactFit = stripAnsi(status(firstGaugeWidth));
	const oneColumnShort = stripAnsi(status(firstGaugeWidth - 1));
	for (const label of full) {
		assert.ok(exactFit.includes(label), `exact-fit retains ${label}`);
		assert.ok(oneColumnShort.includes(label), `one-column-short retains ${label}`);
	}
	assert.ok(exactFit.includes("[▰▱▱▱▱]"));
	assert.ok(!oneColumnShort.includes("[▰▱▱▱▱]"));
	assert.ok(!exactFit.includes("/1M") && !exactFit.includes("+$1.24"), "the gauge is admitted before the denominator and the delta");
	assert.ok(visibleWidth(exactFit.trim()) - 2 < 90, "the gauge has no width floor of its own");
});

test("two-row status reservation shifts gauge admission by the measured spinner slot", () => {
	const normal = statusFixture();
	const firstGauge = (render: (width: number) => string) => {
		for (let width = 20; width <= 180; width++) if (stripAnsi(render(width)).includes("[▰▱▱▱▱]")) return width;
		return undefined;
	};
	const ordinaryWidth = firstGauge(normal.status);
	assert.ok(ordinaryWidth !== undefined);
	for (const columns of [1, 2, 3]) {
		const pyramid = statusFixture({ height: 2, columns });
		const pyramidWidth = firstGauge(pyramid.status);
		assert.ok(pyramidWidth !== undefined);
		assert.equal(pyramidWidth, ordinaryWidth + columns + 1, `columns=${columns}: gauge admission subtracts the exact status slot`);
		assert.ok(!stripAnsi(pyramid.status(pyramidWidth - 1)).includes("[▰▱▱▱▱]"));
		for (const label of ["/work/repo · main · review", "136.9k · 13%", "~$48.89", "Elite"]) assert.ok(stripAnsi(pyramid.status(pyramidWidth - 1)).includes(label));
	}
});

/**
 * The status row's priority, asserted as an order at every width: ornaments
 * (delta → window → gauge) only with the full left and full core; the left
 * gives up its detail before the core right narrows; the right drops the cost,
 * then the tokens, then trims the persona, and the percentage stands last.
 */
for (const persona of ["Elite Operator", undefined]) {
	test(`the status row surrenders in order at every width, ${persona ? "with" : "without"} a persona`, () => {
		const fixture = statusFixture({ persona });
		const { editor } = fixture;
		const seen = new Set<string>();
		const core = `136.9k · 13% · ~$48.89${persona ? ` · ${persona}` : ""} `;
		for (let width = 20; width <= 200; width++) {
			const rows = editor.render(width);
			const box = visibleWidth(rows[0]);
			for (const row of rows) assert.equal(visibleWidth(row), box, `@${width}: every row is the box width`);
			const plain = stripAnsi(rows.at(-2)!);
			const at = `@${width}: ${plain}`;
			const statusWidth = visibleWidth(plain.trim()) - 2;
			const fullLeft = plain.includes("/work/repo · main · review ");
			const gauge = plain.includes("[▰");
			const delta = plain.includes("+$1.24");
			const window = plain.includes("/1M");
			const cost = plain.includes("~$48.89");
			const tokens = plain.includes("136.9k");
			const percent = plain.includes("13%");
			const personaWhole = !!persona && plain.includes(persona);
			const personaTrimmed = !!persona && !personaWhole && /13% · Eli\S*…/.test(plain);
			if (delta) assert.ok(window && gauge && cost && fullLeft, `the delta is the first ornament to go: ${at}`);
			if (window) assert.ok(gauge && fullLeft, `the window goes before the gauge: ${at}`);
			if (gauge) assert.ok(fullLeft && cost && tokens && (!persona || personaWhole), `the gauge needs the full left and the full core: ${at}`);
			if (cost) assert.ok(tokens && percent && (!persona || personaWhole), `the cost is the first core piece to go: ${at}`);
			if (tokens) assert.ok(percent, `the token count goes before the percentage: ${at}`);
			if (personaTrimmed) assert.ok(!tokens && percent, `the persona trims only after the token count: ${at}`);
			if (personaWhole || personaTrimmed) assert.ok(percent, `the percentage outlives the persona: ${at}`);
			// The core never yields while the left still had detail to give up.
			if (!cost) assert.ok(visibleWidth(core) + 1 + visibleWidth(" …/repo") > statusWidth, `the core narrowed before the left reached its floor: ${at}`);
			if (width >= 24) assert.ok(percent, `the percentage is the last thing standing: ${at}`);
			if (delta) seen.add("delta");
			if (window && !delta) seen.add("window");
			if (gauge && !window) seen.add("gauge");
			if (cost && !gauge && fullLeft) seen.add("core");
			if (cost && !fullLeft) seen.add("left-yields");
			if (!cost && tokens) seen.add("no-cost");
			if (!tokens && personaWhole) seen.add("no-tokens");
			if (personaTrimmed) seen.add("persona-trims");
			if (percent && !tokens && !personaWhole && !personaTrimmed) seen.add("percent");
		}
		const expected = ["delta", "window", "gauge", "core", "left-yields", "no-cost", "percent", ...(persona ? ["no-tokens", "persona-trims"] : [])];
		for (const state of expected) assert.ok(seen.has(state), `the sweep must reach ${state}: ${[...seen].join(", ")}`);
	});
}

test("warning and critical usage keep their color down to a lone percentage", () => {
	for (const [percent, role] of [[95, "error"], [75, "warning"]] as const) {
		const { ui, state, status } = statusFixture();
		state.usage = { tokens: percent * 1000, contextWindow: 100000, percent };
		let alone = 0;
		for (let width = 200; width >= 20; width--) {
			const row = status(width);
			const text = stripAnsi(row);
			assert.ok(row.includes(ui.theme.fg(role, `${percent}%`)), `@${width}: the percentage uses ${role}: ${text}`);
			if (text.includes(`${percent}.0k`)) assert.ok(row.includes(ui.theme.fg(role, `${percent}.0k`)), `@${width}: tokens use ${role}`);
			if (/ \d+% │$/.test(text)) alone++;
		}
		assert.ok(alone > 0, `${percent}%: the sweep reaches the lone percentage`);
	}
	const unknown = statusFixture();
	unknown.state.usage = { tokens: null, contextWindow: 100000, percent: null };
	for (let width = 200; width >= 24; width--) {
		const text = stripAnsi(unknown.status(width));
		assert.ok(!/\d+%/.test(text), `@${width}`);
		assert.ok(text.includes("ctx —"), `@${width}: the unknown marker is the last thing standing: ${text}`);
	}
});

test("the last percentage standing is shown whole or not at all, never clipped by its pad", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		for (const percent of [71, 114, 7]) {
			for (const persona of ["Elite", undefined]) {
				const fixture = statusFixture({ persona });
				fixture.state.usage = { tokens: percent * 1000, contextWindow: 100000, percent };
				let flush = 0;
				for (let width = 200; width >= 8; width--) {
					const text = stripAnsi(fixture.status(width));
					assert.ok(!/\d…/.test(text) && !/…%/.test(text), `${percent}% @${width}: a clipped number: ${text}`);
					if (text.includes(`${percent}%│`)) flush++;
				}
				assert.ok(flush > 0, `${percent}%: the sweep reaches the bare percentage against the rail`);
			}
		}
	} finally {
		useTerminalMetrics();
	}
});

test("colored status stays within host columns and retains semantic narrowing with Unicode metadata", () => {
	const { editor, state, status } = statusFixture();
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		for (const persona of ["Elite", undefined, "🧑‍💻 界", "💻 Dev"]) {
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
				if (width >= 30) assert.ok(stripAnsi(status(width)).includes("13%"), `context lost at ${width}`);
			}
		}
		state.persona = "Elite";
		assert.ok(!/[▰▱]/.test(stripAnsi(status(80))), "gauge yields before existing metadata or numeric context");
		assert.ok(stripAnsi(status(40)).includes("Elite"), "the persona outlives the cost and the token count");
	} finally {
		useTerminalMetrics();
	}
});

// ---- the border's one label ------------------------------------------------

/** A terminal width whose framed box is exactly `box` columns. */
const widthForBox = (box: number) => {
	for (let width = 1; width <= 400; width++) if (chooseBox(width, 180, 2).boxWidth === box && !chooseBox(width, 180, 2).fallback) return width;
	throw new Error(`no width for box ${box}`);
};

test("the owner's row keeps the gauge longest: the delta goes, then the denominator, then the gauge, then left detail", () => {
	for (const delta of ["+$1.24", ""]) {
		const { state, status } = statusFixture({ cwd: "D:/dev/Sources/pi-persona", persona: "💻 Dev" });
		state.session = undefined;
		state.delta = delta;
		const row = (box: number) => stripAnsi(status(widthForBox(box)));
		const deltaPattern = delta ? " \\+\\$1\\.24" : "";
		assert.match(row(100), new RegExp(`│ …/Sources/pi-persona · main +\\[▰▱▱▱▱\\] 136\\.9k/1M · 13% · ~\\$48\\.89${deltaPattern} · 💻 Dev │$`));
		const narrowest = (has: (plain: string) => boolean) => {
			let box = 100;
			while (box > 20 && has(row(box - 1))) box--;
			for (let narrower = box - 1; narrower >= 20; narrower--) assert.ok(!has(row(narrower)), `box ${narrower} came back: ${row(narrower)}`);
			return box;
		};
		const fullLeft = narrowest((plain) => plain.includes("│ …/Sources/pi-persona · main "));
		const gauge = narrowest((plain) => plain.includes("[▰▱▱▱▱]"));
		const window = narrowest((plain) => plain.includes("136.9k/1M"));
		assert.equal(gauge, 71);
		assert.ok(window > gauge, `the denominator (${window}) goes before the gauge (${gauge})`);
		if (delta) assert.ok(narrowest((plain) => plain.includes("+$1.24")) > window, "the delta goes before the denominator");
		assert.ok(fullLeft < gauge, `left detail (${fullLeft}) yields only after the gauge (${gauge})`);
		assert.match(row(gauge - 1), /│ …\/Sources\/pi-persona · main +136\.9k · 13% · ~\$48\.89 · 💻 Dev │$/);
	}
});

test("the model identity sits in the top border in the palette's roles, each level in its own thinking token", () => {
	const { ui, state, top } = statusFixture({ reasoning: true });
	let distinctFromMuted = 0;
	for (const name of PALETTES) {
		ui.theme = statusTheme(name);
		const t = ui.theme;
		const model = t.fg("accent", "gpt-6.1-sol");
		for (const [level, token] of Object.entries(THINKING_TOKENS)) {
			state.thinking = level;
			const tail = `${t.fg("dim", " · ")}${t.fg(token, level)}`;
			const wide = top();
			assert.ok(wide.includes(` ${t.fg("dim", "openai/")}${model}${tail} ${t.fg("muted", "──╮")}`), `${name}: provider/model · ${level}`);
			// The provider yields first; the level stays while the model is whole.
			const second = top(widthForBox(8 + visibleWidth(`gpt-6.1-sol · ${level}`)));
			assert.ok(second.includes(` ${model}${tail} `) && !second.includes("openai"), `${name}: model · ${level}: ${stripAnsi(second)}`);
			// Below the level's floor the model stands alone.
			const alone = top(widthForBox(8 + 11));
			if (level.length > 3) assert.ok(alone.includes(` ${model} `) && !stripAnsi(alone).includes(level), `${name}: model alone: ${stripAnsi(alone)}`);
			if (t.fg(token, level) !== t.fg("muted", level)) distinctFromMuted++;
		}
	}
	assert.ok(distinctFromMuted > 0, "the level is painted with thinking tokens, not a generic role");
});

test("the border label narrows rung by rung and the top row stays exactly the box width", () => {
	const { editor, top } = statusFixture({ reasoning: true, thinking: "xhigh" });
	const seen = new Set<string>();
	for (let width = 12; width <= 200; width++) {
		const rows = editor.render(width);
		assert.equal(visibleWidth(rows[0]), visibleWidth(rows[1]), `@${width}`);
		const label = /╭─+ (.+) ──╮/.exec(stripAnsi(top(width)))?.[1];
		if (!label) { seen.add("plain"); continue; }
		if (label === "openai/gpt-6.1-sol · xhigh") seen.add("provider");
		else if (label === "gpt-6.1-sol · xhigh") seen.add("level");
		else if (/^gpt-\S*… · xhigh$/.test(label)) seen.add("model-trims");
		else if (label === "gpt-6.1-sol") seen.add("model");
		else if (/^g\S*…$/.test(label)) seen.add("last-trims");
		else assert.fail(`@${width}: unexpected label ${label}`);
	}
	assert.deepEqual([...seen].sort(), ["last-trims", "level", "model", "model-trims", "provider"]);
});

test("no level is shown for off, a missing level, a non-reasoning model, or text the host did not define", () => {
	const fixture = statusFixture({ reasoning: true });
	const baseline = fixture.top();
	const t = fixture.ui.theme;
	assert.ok(baseline.includes(` ${t.fg("dim", "openai/")}${t.fg("accent", "gpt-6.1-sol")} ${t.fg("muted", "──╮")}`), "no level → provider/model alone");
	for (const thinking of ["off", undefined, "", "HIGH", "turbo", "toString", "__proto__", "\x1b[2Jhigh‮", "high\nspoof"]) {
		assert.equal(statusFixture({ reasoning: true, thinking }).top(), baseline, `level ${JSON.stringify(thinking)} must show nothing`);
	}
	// A model that does not reason has no level to report, whatever the session carries.
	assert.equal(statusFixture({ reasoning: false, thinking: "high" }).top(), baseline);
	// No provider: the model alone, no dangling slash.
	assert.match(stripAnsi(statusFixture({ provider: "" }).top()), /─ gpt-6\.1-sol ──╮$/);
	// The level never touches the status row.
	for (let width = 20; width <= 200; width += 9) assert.equal(statusFixture({ reasoning: true, thinking: "high" }).status(width), fixture.status(width), `@${width}`);
});

test("a model id with nothing visible left offers no label: the plain rule, never an empty or dangling one", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		for (const modelId of ["claude-", "   ", "\x1b[2J", "\x1b]0;x\x07", "​"]) {
			for (const provider of ["anthropic", ""]) {
				const fixture = statusFixture({ modelId, provider, reasoning: true, thinking: "high" });
				for (const width of [40, 80, 200]) {
					const top = stripAnsi(fixture.top(width)).trim();
					assert.match(top, /^╭─+╮$/, `${JSON.stringify(modelId)} ${provider || "(no provider)"} @${width}: ${top}`);
				}
			}
		}
	} finally {
		useTerminalMetrics();
	}
});

test("hostile provider, model and level text never reaches the terminal and keeps the box exact", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		const fixture = statusFixture({ reasoning: true, thinking: "\x1b[2Jhigh", provider: "op\x1b[2Jen‮ai\n", modelId: "gpt\x1b]0;pwned\x07-6\u0007.1⚖️" });
		for (let width = 12; width <= 200; width++) {
			const rows = fixture.editor.render(width);
			const joined = rows.join("\n");
			assert.ok(!joined.includes("\x1b[2J") && !joined.includes("\x1b]0;"), `@${width}: controls never reach the frame`);
			assert.ok(!/[‪-‮️]/u.test(joined) && !stripAnsi(joined).includes("pwned"), `@${width}`);
			for (const row of rows) assert.equal(visibleWidth(row), visibleWidth(rows[0]), `@${width}: ${row}`);
		}
		assert.match(stripAnsi(fixture.top()), / openai\/gpt-6\.1⚖ ──╮$/, "printable text survives; the bogus level does not");
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
		ctx, getPersona: () => undefined, getSessionName: () => undefined,
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
		getPersona: () => undefined, getSessionName: () => "hidden while menu open",
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

test("an activity paints over the workspace and never moves the right group", () => {
	const activity = (): Activity => ({ label: "Running npm test…", more: 0, elapsedMs: 1000 });
	for (const width of [60, 80, 100, 140]) {
		const idle = statusFixture();
		const before = idle.status(width);
		const after = statusFixture({ working: true, activity }).status(width);
		const at = rightStart(before, idle);
		assert.notEqual(at, -1, `width ${width}: the idle row has a right group`);
		assert.ok(after.endsWith(before.slice(at)), `width ${width}: the right group changed: ${stripAnsi(before)} → ${stripAnsi(after)}`);
		assert.equal(visibleWidth(after), visibleWidth(before));
		const plain = stripAnsi(after);
		assert.match(plain, /^ *│ Running npm test… /, `width ${width}: the whole label shows in the workspace's place: ${plain}`);
		assert.ok(!plain.includes("/work/repo"), `width ${width}: the workspace yields while the label is up`);
		assert.ok(!plain.includes("▸"), "no glyph marks the label");
	}
	const { ui, status } = statusFixture({ working: true, activity });
	const wide = status(140);
	assert.ok(wide.includes(ui.theme.fg("text", "Running npm test…")), "the label uses the workspace slot's own role");
	assert.ok(stripAnsi(wide).includes("[▰▱▱▱▱] 136.9k/1M · 13% · ~$48.89 +$1.24 · Elite"), "the ornaments are not evicted by a label");
});

for (const persona of ["Elite", undefined]) {
	test(`the right group is byte-identical idle and working at every width, ${persona ? "with" : "without"} a persona`, () => {
		let compared = 0;
		for (const more of [0, 2]) {
			for (const elapsedMs of [1000, 14_000, 65_000]) {
				const activity = (): Activity => ({ label: "Running npm test…", more, elapsedMs });
				const idle = statusFixture({ persona });
				const busy = statusFixture({ persona, working: true, activity });
				for (let width = 40; width <= 200; width++) {
					const before = idle.status(width);
					const after = busy.status(width);
					const at = rightStart(before, idle);
					assert.notEqual(at, -1, `@${width}: the idle row has a right group`);
					assert.ok(after.endsWith(before.slice(at)), `@${width} +${more} ${elapsedMs}ms: ${stripAnsi(before)} → ${stripAnsi(after)}`);
					assert.equal(visibleWidth(after), visibleWidth(before), `@${width}: row width`);
					assert.equal(stripAnsi(after).length - stripAnsi(before.slice(at)).length, stripAnsi(before).length - stripAnsi(before.slice(at)).length, `@${width}: shifted`);
					if (stripAnsi(after).includes("Running")) compared++;
				}
			}
		}
		assert.ok(compared > 500, `the overlay must be visible across the sweep (${compared})`);
	});
}

test("parallel calls append a dim count after the label", () => {
	const { ui, status } = statusFixture({ working: true, activity: () => ({ label: "Running npm test…", more: 2, elapsedMs: 1000 }) });
	const row = status(140);
	assert.ok(row.includes(ui.theme.fg("text", "Running npm test…") + ui.theme.fg("dim", " +2")));
	assert.ok(!stripAnsi(status(140)).includes("more"));
	const single = statusFixture({ working: true, activity: () => ({ label: "Running npm test…", more: 0, elapsedMs: 1000 }) }).status(140);
	assert.ok(!stripAnsi(single).includes("+0"), "a lone call shows no count");
	// The count is the first thing to yield: a cramped slot keeps the verb and drops " +2".
	const cramped = [40, 44, 48, 52, 56, 60].map(width => stripAnsi(status(width)));
	assert.ok(cramped.some(row => /│ Run/.test(row) && !row.includes(" +2 ")), `the label outlives its count: ${cramped.join(" | ")}`);
	assert.ok(cramped.every(row => !/│ …? *\+2/.test(row)), "the count never survives alone");
});

test("a long call shows its dim elapsed time after the label, before the count", () => {
	const at = (elapsedMs: number, more = 0) => statusFixture({ working: true, activity: () => ({ label: "Running npm test…", more, elapsedMs }) });
	for (const elapsedMs of [500, 1000, ACTIVITY_ELAPSED_MS - 1]) {
		const plain = stripAnsi(at(elapsedMs).status(140));
		assert.match(plain, /│ Running npm test… {2}/, `${elapsedMs} ms: no counter yet`);
		assert.doesNotMatch(plain, /\d+s\b/, `${elapsedMs} ms: no counter yet`);
	}
	assert.match(stripAnsi(at(ACTIVITY_ELAPSED_MS).status(140)), /│ Running npm test… 3s /, "the counter appears at the threshold");
	const { ui, status } = at(14_000);
	assert.ok(status(140).includes(ui.theme.fg("text", "Running npm test…") + ui.theme.fg("dim", " 14s")), "the time recedes, dim, after the label");
	const siblings = at(14_000, 2);
	assert.match(stripAnsi(siblings.status(140)), /│ Running npm test… 14s \+2 /);
	assert.ok(siblings.status(140).includes(siblings.ui.theme.fg("dim", " 14s +2")));
	assert.match(stripAnsi(at(65_000).status(140)), /│ Running npm test… 1m 05s /);
});

test("a cramped row drops the count, then the elapsed time, and only then trims the label", () => {
	const { status } = statusFixture({ working: true, activity: () => ({ label: "Running npm test…", more: 2, elapsedMs: 14_000 }) });
	// Not monotonic in width: once the right group narrows a narrower row can
	// hold more. The ordering is per row: what is shown is always a prefix of
	// label → time → count, and the label trims only when it stands alone.
	const seen = new Set<string>();
	for (let width = 200; width >= 20; width--) {
		const plain = stripAnsi(status(width));
		const label = /│ (Run\S*(?: \S+)*?…)(?= )/.exec(plain)?.[1];
		if (!label) continue; // the workspace keeps cells too few for any useful rung
		const whole = label === "Running npm test…";
		const shown = plain.includes("Running npm test… 14s +2") ? 3 : plain.includes("Running npm test… 14s") ? 2 : whole ? 1 : 0;
		seen.add(String(shown));
		if (!whole) assert.ok(!/14s|\+2 /.test(plain), `width ${width}: the label trims only after count and time are gone: ${plain}`);
		if (!plain.includes("14s")) assert.ok(!plain.includes(" +2 "), `width ${width}: the count never outlives the time: ${plain}`);
	}
	assert.deepEqual([...seen].sort(), ["0", "1", "2", "3"], "every rung appears somewhere in the sweep");
});

test("the run clock reads Working… with a dim elapsed time in the workspace's place", () => {
	const clock = (elapsedMs: number) => statusFixture({ working: true, activity: () => ({ label: "Working…", more: 0, elapsedMs, run: true }) });
	const { ui, status } = clock(45_999);
	const row = status(140);
	assert.match(stripAnsi(row), /│ Working… 45s {2}/, "rounded down, in the tool label's own format");
	assert.ok(row.includes(ui.theme.fg("text", "Working…") + ui.theme.fg("dim", " 45s")), "the label in the slot's role, the time receding");
	assert.ok(!stripAnsi(row).includes("/work/repo"), "it takes the workspace's place");
	assert.ok(stripAnsi(row).includes("[▰▱▱▱▱] 136.9k/1M · 13% · ~$48.89 +$1.24 · Elite"), "the ornaments are not evicted by the clock");
	assert.match(stripAnsi(clock(ACTIVITY_ELAPSED_MS).status(140)), /│ Working… 3s /);
	assert.match(stripAnsi(clock(65_000).status(140)), /│ Working… 1m 05s /);
	assert.match(stripAnsi(clock(3_725_000).status(140)), /│ Working… 1h 02m /);
	// The frame decides nothing about the threshold: a younger entry simply has no time to show.
	assert.match(stripAnsi(clock(1_000).status(140)), /│ Working… {3}/);
	// Idle, and during a blocking prompt, it is neither consulted nor shown.
	let calls = 0;
	const activity = (): Activity => { calls++; return { label: "Working…", more: 0, elapsedMs: 45_000, run: true }; };
	for (const options of [{ activity }, { working: true, waiting: true, activity }]) {
		const plain = stripAnsi(statusFixture(options).status(140));
		assert.ok(!plain.includes("Working") && plain.includes("/work/repo"));
	}
	assert.equal(calls, 0);
});

test("the run clock arriving, advancing and yielding to a tool label never re-renders the base editor", () => {
	let current: Activity | undefined;
	const { status } = statusFixture({ working: true, activity: () => current });
	const originalRender = CustomEditor.prototype.render;
	let baseRenders = 0;
	CustomEditor.prototype.render = function (width: number): string[] {
		baseRenders++;
		return originalRender.call(this, width);
	};
	try {
		const shown: string[] = [];
		for (const next of [
			undefined,
			{ label: "Working…", more: 0, elapsedMs: 3_000, run: true as const },
			{ label: "Working…", more: 0, elapsedMs: 45_000, run: true as const },
			{ label: "Running npm test…", more: 0, elapsedMs: 600 },
			{ label: "Working…", more: 0, elapsedMs: 52_000, run: true as const },
			undefined,
		]) {
			current = next;
			shown.push(/│ (.*?) {2}/.exec(stripAnsi(status(140)))![1]!);
		}
		assert.deepEqual(shown, ["/work/repo · main · review", "Working… 3s", "Working… 45s", "Running npm test…", "Working… 52s", "/work/repo · main · review"]);
		assert.equal(baseRenders, 1, "only the first frame lays the input out; the overlay repaints over the cached raw lines");
	} finally {
		CustomEditor.prototype.render = originalRender;
	}
});

for (const persona of ["Elite", undefined]) {
	test(`the run clock leaves the right group byte-identical at every width, ${persona ? "with" : "without"} a persona`, () => {
		let timed = 0;
		let bare = 0;
		let yielded = 0;
		for (const elapsedMs of [3_000, 45_000, 65_000, 3_725_000]) {
			const idle = statusFixture({ persona });
			const busy = statusFixture({ persona, working: true, activity: () => ({ label: "Working…", more: 0, elapsedMs, run: true }) });
			for (let width = 40; width <= 200; width++) {
				const before = idle.status(width);
				const after = busy.status(width);
				const at = rightStart(before, idle);
				assert.notEqual(at, -1, `@${width}: the idle row has a right group`);
				assert.ok(after.endsWith(before.slice(at)), `@${width} ${elapsedMs}ms: ${stripAnsi(before)} → ${stripAnsi(after)}`);
				assert.equal(visibleWidth(after), visibleWidth(before), `@${width}: row width`);
				const plain = stripAnsi(after);
				// Whole rungs only: with its time, without it, or the row exactly as it was.
				if (/│ Working… \d/.test(plain)) timed++;
				else if (plain.includes("│ Working… ")) bare++;
				else {
					assert.equal(after, before, `@${width}: no room for the clock leaves the workspace row untouched`);
					yielded++;
				}
				assert.doesNotMatch(plain, /│ W[a-z]*…(?<!Working…)/, `@${width}: the label is never clipped: ${plain}`);
				assert.doesNotMatch(plain, /│ Working… \d+[a-z]?…/, `@${width}: the time is never clipped: ${plain}`);
			}
		}
		assert.ok(timed > 500, `the timed rung shows across the sweep (${timed})`);
		assert.ok(bare > 0, `the bare rung appears where the time does not fit (${bare})`);
		// Without a persona the right group is short enough that the bare rung always fits here.
		if (persona) assert.ok(yielded > 0, `the workspace returns where nothing fits (${yielded})`);
	});
}

test("idle and waiting-for-user never consult or show the activity", () => {
	let calls = 0;
	const activity = (): Activity => { calls++; return { label: "Running npm test…", more: 1, elapsedMs: 14_000 }; };
	for (const options of [{ activity }, { working: true, waiting: true, activity }]) {
		const { status } = statusFixture(options);
		const plain = stripAnsi(status(140));
		assert.ok(!plain.includes("Running npm test"), "idle and waiting keep the workspace");
		assert.ok(plain.includes("/work/repo"));
	}
	assert.equal(calls, 0, "the activity is read only while working");
	assert.ok(stripAnsi(statusFixture({ working: true, activity: () => undefined }).status(140)).includes("/work/repo"), "no activity, no overlay");
});

test("hostile and emoji-ambiguous activity text keeps exact host geometry", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		const hostile = "Reading \u001b[2J\u001b]0;pwned\u0007stats.py‮\nnext ⚖️…";
		for (const options of [{ height: 2, columns: 3 }, {}]) {
			const fixture = statusFixture({ working: true, ...options, activity: () => ({ label: hostile, more: 3, elapsedMs: 1000 }) });
			for (const width of [60, 120, 200]) {
				const rows = fixture.editor.render(width);
				const expected = visibleWidth(rows[0]);
				for (const row of rows) assert.equal(visibleWidth(row), expected, `row drifts at ${width}: ${row}`);
				const raw = rows.at(-2)!;
				const statusRow = stripAnsi(raw);
				assert.match(statusRow, /│ (Read|….repo)/, "the label, or the workspace when its cells are too few");
				if (width >= 120) assert.match(statusRow, /│ Reading stats\.py next ⚖… \+3 /, "printable text survives; the label stays one line");
				assert.ok(!raw.includes("\u001b[2J") && !raw.includes("\u001b]0;") && !statusRow.includes("pwned"), "controls never reach the frame");
				assert.ok(!/[‪-‮\n]/u.test(statusRow), "bidi and newlines never reach the frame");
				assert.ok(!statusRow.includes("️"), "width-ambiguous VS16 is normalized away");
			}
		}
	} finally {
		useTerminalMetrics();
	}
});

test("a 200-character label never widens the box", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		const label = `Running ${"界a".repeat(64)}${"x".repeat(8)}…`;
		assert.ok(visibleWidth(label) >= 200);
		const idle = statusFixture();
		const busy = statusFixture({ working: true, activity: () => ({ label, more: 1, elapsedMs: 14_000 }) });
		for (let width = 12; width <= 200; width++) {
			const before = idle.editor.render(width);
			const after = busy.editor.render(width);
			assert.equal(after.length, before.length, `row count at ${width}`);
			for (let i = 0; i < after.length; i++) {
				assert.ok(visibleWidth(after[i]) <= width, `overflow at ${width}: ${after[i]}`);
				assert.equal(visibleWidth(after[i]), visibleWidth(before[i]), `box width changed at ${width}`);
			}
		}
		const trimmed = stripAnsi(busy.status(140));
		assert.match(trimmed, /^\s*│ Running 界a.*… /, "the label trims with …");
		assert.ok(!trimmed.includes(" +1 "), "a label that has to trim has already given up its count");
		assert.ok(!trimmed.includes("14s"), "and its elapsed time");
	} finally {
		useTerminalMetrics();
	}
});

// ---- the left group gives up whole details ---------------------------------

/** Every prefix of `value` the row may show clipped: at least `min` columns with its `…`. */
const clippedForms = (value: string, min: number): string[] => {
	const out: string[] = [];
	for (let kept = value.length - 1; kept >= min - 1; kept--) out.push(`${value.slice(0, kept)}…`);
	return out;
};

/** A detail (the text after the last ` · `) of one to four characters and an ellipsis: a clipped stub. */
const endsInStub = (group: string) => /^[^…]{1,4}…$/u.test(group.split(" · ").at(-1)!.trim());

const LEFT_CASES = [
	{ cwd: "/work/repo", branch: "main", session: "review", persona: "Elite" },
	{ cwd: "D:/dev/Sources/pi-1337", branch: "feat/tool-runs", session: "fold tallies", persona: "💻 Dev" },
	{ cwd: "/home/me/src/proj", branch: "m", session: undefined, persona: undefined },
	{ cwd: "/home/me/src/proj", branch: "", session: "Fix session resume status", persona: "Elite" },
	{ cwd: "D:/Sources/pi-persona", branch: "feature/restore-context-indicator", session: "Fix session resume status", persona: "1337" },
	{ cwd: "/x", branch: "detached", session: "a session name that goes on and on and on", persona: undefined },
	{ cwd: "/srv/app", branch: "", session: undefined, persona: "Elite" },
] as const;

test("the left group gives up whole details at every width, idle and under the activity overlay", () => {
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		const interiorOf = (row: string) => {
			const plain = stripAnsi(row);
			return plain.slice(plain.indexOf("│") + 1, plain.lastIndexOf("│"));
		};
		const seen = new Set<string>();
		for (const { cwd, branch, session, persona } of LEFT_CASES) {
			const fixtures = {
				idle: statusFixture({ cwd, persona }),
				tool: statusFixture({ cwd, persona, working: true, activity: () => ({ label: "Running npm test…", more: 2, elapsedMs: 14_000 }) }),
				clock: statusFixture({ cwd, persona, working: true, activity: () => ({ label: "Working…", more: 0, elapsedMs: 45_000, run: true }) }),
			};
			for (const fixture of Object.values(fixtures)) Object.assign(fixture.state, { branch, session });
			const path = shortCwd(cwd);
			const segments = path.split("/").filter(Boolean);
			const compact = `…/${segments.at(-1)}`;
			const withBranch = branch ? `${path} · ${branch}` : path;
			// The whole forms, widest first; a session name is the one detail that may clip.
			const forms: [name: string, text: string][] = [
				...(session ? [["session", `${withBranch} · ${session}`] as [string, string]] : []),
				...(session ? clippedForms(session, SESSION_MIN_COLUMNS).map(clip => ["session clipped", `${withBranch} · ${clip}`] as [string, string]) : []),
				...(branch ? [["branch", withBranch] as [string, string]] : []),
				["path", path],
				...(segments.length > 1 ? [["basename", compact] as [string, string]] : []),
			];
			const overlays = {
				tool: ["Running npm test… 14s +2", "Running npm test… 14s", "Running npm test…", ...clippedForms("Running npm test…", ACTIVITY_MIN_COLUMNS)],
				clock: ["Working… 45s", "Working…"],
			};
			for (let width = 20; width <= 160; width++) {
				const where = `${cwd} · ${branch} · ${session} · ${persona} @${width}`;
				const idleRows = fixtures.idle.editor.render(width);
				for (const row of idleRows) assert.ok(visibleWidth(row) <= width, `${where}: wider than the terminal`);
				const idle = interiorOf(idleRows.at(-2)!);
				const form = forms.find(([, text]) => idle.startsWith(` ${text} `));
				assert.ok(form, `${where}: the left group is not one of its whole forms: │${idle}│`);
				const right = idle.slice(1 + form[1].length);
				// Its cells end where the gap begins: one space at least, then the right group, no left detail.
				assert.match(right, /^ +(?! |·)|^ +$/u, `${where}: the left group ran into the right: │${idle}│`);
				assert.ok(!endsInStub(form[1]), `${where}: a clipped stub: │${idle}│`);
				seen.add(form[0]);

				for (const mode of ["tool", "clock"] as const) {
					const busyRows = fixtures[mode].editor.render(width);
					const busy = interiorOf(busyRows.at(-2)!);
					for (let i = 0; i < busyRows.length; i++) assert.equal(visibleWidth(busyRows[i]!), visibleWidth(idleRows[i]!), `${where} ${mode}: the box moved`);
					const group = right.trimStart();
					assert.ok(busy.endsWith(group), `${where} ${mode}: the right group changed: │${idle}│ → │${busy}│`);
					const lead = busy.slice(0, busy.length - group.length);
					assert.equal(visibleWidth(lead), visibleWidth(idle) - visibleWidth(group), `${where} ${mode}: the overlay left its cells`);
					if (busy === idle) continue; // no room for a useful rung: the workspace keeps its place
					assert.ok(lead.startsWith(" ") && lead.endsWith(" "), `${where} ${mode}: the overlay touches its neighbours: │${busy}│`);
					assert.ok(overlays[mode].includes(lead.trim()), `${where} ${mode}: the overlay is not one of its whole forms: │${busy}│`);
					assert.ok(!endsInStub(lead), `${where} ${mode}: a clipped stub: │${busy}│`);
					seen.add(lead.trim() === overlays[mode][0] ? `${mode} whole` : `${mode} narrowed`);
				}
			}
		}
		assert.deepEqual([...seen].sort(), ["basename", "branch", "clock narrowed", "clock whole", "path", "session", "session clipped", "tool narrowed", "tool whole"],
			"every form appears somewhere in the sweep");
	} finally {
		useTerminalMetrics();
	}
});

test("a branch is shown whole or not at all, where it used to be clipped to a stub", () => {
	// The reported rows: `…/proj · m…` and `/…/src/pi-1337 · fe…` at terminal width 60.
	const fixture = statusFixture({ cwd: "D:/dev/Sources/pi-1337", persona: "💻 Dev" });
	Object.assign(fixture.state, { branch: "feat/tool-runs", session: "fold tallies" });
	const shown = new Set<string>();
	for (let width = 20; width <= 160; width++) {
		const plain = stripAnsi(fixture.status(width));
		assert.doesNotMatch(plain, /fe(?!at\/tool-runs)|feat\/tool-runs…/, `@${width}: the branch is clipped: ${plain}`);
		shown.add(plain.includes("feat/tool-runs") ? "whole" : "absent");
	}
	assert.deepEqual([...shown].sort(), ["absent", "whole"]);
	assert.match(stripAnsi(fixture.status(60)), /│ …\/Sources\/pi-1337 +136\.9k · 13% · ~\$48\.89 · 💻 Dev │$/, "the path alone, whole, beside an unchanged right group");
});

test("a long session name shortens to a readable minimum, then goes whole; a short one is never clipped", () => {
	const long = statusFixture({ cwd: "/work/repo", persona: undefined });
	Object.assign(long.state, { session: "Fix session resume status" });
	const clipped: number[] = [];
	for (let width = 20; width <= 160; width++) {
		const match = /main · (Fix[^·]*?)… /.exec(stripAnsi(long.status(width)));
		if (match) clipped.push(match[1]!.length);
	}
	assert.ok(clipped.length > 0, "the sweep clips the long name somewhere");
	assert.ok(Math.min(...clipped) >= SESSION_MIN_COLUMNS - 1, `never fewer than ${SESSION_MIN_COLUMNS - 1} characters before the ellipsis: ${Math.min(...clipped)}`);
	// The floor itself, in literals: nine characters and the ellipsis, reached and never undercut.
	assert.equal(SESSION_MIN_COLUMNS, 10);
	assert.equal(Math.min(...clipped), 9, "the shortest form the sweep shows keeps exactly nine characters");
	const shortest = new Set<string>();
	for (let width = 20; width <= 160; width++) {
		const match = /main · (Fix[^·]*?…) /.exec(stripAnsi(long.status(width)));
		if (match && match[1]!.length === 10) shortest.add(match[1]!);
	}
	assert.deepEqual([...shortest], ["Fix sessi…"]);
	for (let width = 20; width <= 160; width++) {
		assert.doesNotMatch(stripAnsi(long.status(width)), /main · Fix[^·…]{0,5}… /, `@${width}: fewer than nine characters is never shown`);
	}
	const short = statusFixture({ cwd: "/work/repo", persona: undefined });
	for (let width = 20; width <= 160; width++) {
		assert.doesNotMatch(stripAnsi(short.status(width)), /· r[a-z]*…/, `@${width}: "review" is whole or absent`);
	}
});

test("the prompt sigil is $ in bash mode: bashMode when the output reaches the model, dim when !! keeps it out", () => {
	const { editor, ui } = statusFixture();
	const sigilRow = (input: string) => { editor.setText(input); return editor.render(120)[1]!; };
	const { theme } = ui;
	assert.ok(sigilRow("explain this").includes(` ${theme.fg("accent", "›")}`));
	for (const input of ["!npm test", "  !npm test", "!"]) {
		assert.ok(sigilRow(input).includes(` ${theme.fg("bashMode", "$")}`), `${JSON.stringify(input)}: bashMode $`);
	}
	for (const input of ["!!npm test", " \t!!npm test", "!!", "!!!"]) {
		const row = sigilRow(input);
		assert.ok(row.includes(` ${theme.fg("dim", "$")}`), `${JSON.stringify(input)}: dim $`);
		assert.ok(!row.includes(theme.fg("bashMode", "$")), `${JSON.stringify(input)}: not bashMode`);
	}
	assert.notEqual(theme.fg("dim", "$"), theme.fg("bashMode", "$"), "the palette tells the two apart");
	// No label joins the sigil: the row is the input and its gutters, nothing else.
	assert.match(stripAnsi(sigilRow("!!ls")), /│ \$ !!ls +│$/);
});

// ---- quota -----------------------------------------------------------------

/** One digest over every row of a sweep: what the row was before quota existed. */
function rowDigest(usage: ContextUsageLike | undefined): string {
	const digest = createHash("sha256");
	for (const money of [{ cost: "", delta: "" }, { cost: "~$48.89", delta: "" }, { cost: "~$48.89", delta: "+$1.24" }]) {
		for (const persona of [undefined, "Elite", "💻 Dev"]) {
			for (const left of [{ branch: "main", session: "review" as string | undefined }, { branch: "", session: undefined }]) {
				for (const height of [1, 2]) {
					const { editor, state } = statusFixture({ persona, height, cwd: "D:/dev/Sources/pi-persona" });
					Object.assign(state, { usage, ...money, ...left });
					for (let width = 12; width <= 200; width++) digest.update(`${width}\n${editor.render(width).join("\n")}\n`);
				}
			}
		}
	}
	return digest.digest("hex");
}

test("no quota known: every row is byte-identical to the row before quota existed", () => {
	// Recorded from the editor as it stood before the quota item was added.
	const recorded: readonly (readonly [string, ContextUsageLike | undefined, string])[] = [
		["no usage", undefined, "d65400f1f930f8f0276a03fec35b921e54adcd9f8e5afd488169ebb65a449e56"],
		["unknown usage", { tokens: null, contextWindow: 200_000, percent: null }, "9ea47d1048896fa4f02867b29c63a67658475b940aee2683e483b63e36c36d57"],
		["calm", { tokens: 136_900, contextWindow: 1_000_000, percent: 13 }, "3c6f6c3d1ea49cd276de5ece870fd7ce62baab0f1c37b4e5d45b14962d6d50c7"],
		["warning", { tokens: 150_000, contextWindow: 200_000, percent: 75 }, "9906bcb2ad4976fdb7b72358b22ecbbe152147acdc6646fcb7cfc59f3f3f4ba9"],
		["critical", { tokens: 191_000, contextWindow: 200_000, percent: 95.5 }, "152eeb90ad8a20bb567e2175646d23226b02d3cb0e40685c56dedec3427f7db8"],
	];
	const actual = recorded.map(([name, usage]) => [name, rowDigest(usage)]);
	assert.deepEqual(actual, recorded.map(([name, , expected]) => [name, expected]));
	// A view that has nothing to print, and a host that offers none, are the same row.
	const { editor, state } = statusFixture();
	const none = editor.render(120).join("\n");
	state.quota = { windows: [], hot: false, aged: false, limited: false, two: "", one: "", limit: "" };
	assert.equal(editor.render(120).join("\n"), none);
});

const QUOTA_NOW = Date.UTC(2026, 10, 17, 12);

/** A real view, built by the reducer from the headers a subscription sends: percent used per window. */
function quotaOf(fiveHour: number | undefined, week: number | undefined, options: { limited?: boolean; later?: number } = {}): QuotaView | undefined {
	const seconds = QUOTA_NOW / 1000;
	const headers = {
		...(fiveHour === undefined ? {} : { "anthropic-ratelimit-unified-5h-utilization": String(fiveHour / 100), "anthropic-ratelimit-unified-5h-reset": String(seconds + 4 * 3600) }),
		...(week === undefined ? {} : { "anthropic-ratelimit-unified-7d-utilization": String(week / 100), "anthropic-ratelimit-unified-7d-reset": String(seconds + 3 * 86400) }),
	};
	let quota = nextQuota(undefined, { status: 200, headers, api: "anthropic-messages", provider: "sub" }, QUOTA_NOW);
	if (options.limited) quota = nextQuotaMessage(quota, { role: "assistant", stopReason: "error", errorMessage: "You have reached your usage limit." }, "sub", QUOTA_NOW);
	return quotaView(quota, { provider: "sub", api: "anthropic-messages" }, QUOTA_NOW + (options.later ?? 0));
}

/** The narrowest box that still shows something, having checked it never comes back below that. */
function narrowestBox(row: (box: number) => string, has: (plain: string) => boolean, from = 140): number {
	assert.ok(has(row(from)), `shown at box ${from}: ${row(from)}`);
	let box = from;
	while (box > 12 && has(row(box - 1))) box--;
	for (let narrower = box - 1; narrower >= 12; narrower--) assert.ok(!has(row(narrower)), `box ${narrower} came back: ${row(narrower)}`);
	return box;
}

test("quota sits between the cost and the persona, in semantic roles", () => {
	const { state, status, ui } = statusFixture();
	const { theme } = ui;
	state.quota = quotaOf(43, 12);
	assert.match(stripAnsi(status()), /│ \/work\/repo · main · review +\[▰▱▱▱▱\] 136\.9k\/1M · 13% · ~\$48\.89 \+\$1\.24 · 5h 43% · wk 12% · Elite │$/);
	const separator = theme.fg("dim", " · ");
	// Label dim, a calm percentage muted; both windows shortest first, joined by the row's own separator.
	assert.ok(status().includes(`${separator}${theme.fg("dim", "5h ")}${theme.fg("muted", "43%")}${separator}${theme.fg("dim", "wk ")}${theme.fg("muted", "12%")}${separator}${theme.fg("text", "Elite")}`));

	state.persona = undefined;
	assert.match(stripAnsi(status()), /~\$48\.89 \+\$1\.24 · 5h 43% · wk 12% │$/, "without a persona the quota ends the row");
	state.persona = "Elite";

	// One window.
	state.quota = quotaOf(undefined, 85);
	assert.match(stripAnsi(status()), /~\$48\.89 \+\$1\.24 · wk 85% · Elite │$/);
	assert.ok(status().includes(`${theme.fg("dim", "wk ")}${theme.fg("warning", "85%")}`), "above 70 the percentage warns");

	// Thresholds are the context percentage's, judged on the printed integer.
	for (const [percent, role] of [[0, "muted"], [70, "muted"], [71, "warning"], [90, "warning"], [91, "error"], [100, "error"]] as const) {
		state.quota = quotaOf(undefined, percent);
		assert.ok(status().includes(`${theme.fg("dim", "wk ")}${theme.fg(role, `${percent}%`)}`), `${percent}% is ${role}`);
	}

	// The limit replaces the windows, in the error role.
	state.quota = quotaOf(43, 12, { limited: true });
	assert.match(stripAnsi(status()), /~\$48\.89 \+\$1\.24 · limit · Elite │$/);
	assert.ok(status().includes(`${separator}${theme.fg("error", "limit")}${separator}`));
	assert.ok(!/\d+h |wk /.test(stripAnsi(status())), "no window beside it");

	// Usage is not the cost: the context percentage keeps its own color whatever the quota says.
	state.quota = quotaOf(undefined, 95);
	assert.ok(status().includes(theme.fg("accent", "13%")));
	assert.ok(status().includes(theme.fg("muted", "~$48.89")));
});

test("an aged calm percentage recedes to dim at the same width; a hot one never dims", () => {
	const { state, status, ui } = statusFixture();
	const { theme } = ui;
	const later = QUOTA_STALE_MS + 1;
	state.quota = quotaOf(43, 12);
	const fresh = status();
	state.quota = quotaOf(43, 12, { later });
	const aged = status();
	assert.equal(stripAnsi(aged), stripAnsi(fresh), "same text, same columns");
	assert.notEqual(aged, fresh);
	assert.ok(aged.includes(`${theme.fg("dim", "5h ")}${theme.fg("dim", "43%")}`) && aged.includes(`${theme.fg("dim", "wk ")}${theme.fg("dim", "12%")}`));
	assert.ok(!aged.includes(theme.fg("muted", "43%")));

	for (const [percent, role] of [[85, "warning"], [95, "error"]] as const) {
		state.quota = quotaOf(43, percent, { later });
		const row = status();
		assert.ok(row.includes(`${theme.fg("dim", "wk ")}${theme.fg(role, `${percent}%`)}`), `${percent}% stays ${role} however old`);
		assert.ok(row.includes(`${theme.fg("dim", "5h ")}${theme.fg("dim", "43%")}`), "the calm window beside it still recedes");
	}
	state.quota = quotaOf(43, 12, { limited: true, later });
	assert.ok(status().includes(theme.fg("error", "limit")));
});

test("a calm quota is an ornament: delta, denominator, second window, gauge, then the binding window, all before left detail", () => {
	const { state, status } = statusFixture({ cwd: "D:/dev/Sources/pi-persona", persona: "💻 Dev" });
	state.session = undefined;
	state.quota = quotaOf(43, 12); // the five-hour window binds; the weekly one is the second
	const row = (box: number) => stripAnsi(status(widthForBox(box)));
	assert.match(row(120), /│ …\/Sources\/pi-persona · main +\[▰▱▱▱▱\] 136\.9k\/1M · 13% · ~\$48\.89 \+\$1\.24 · 5h 43% · wk 12% · 💻 Dev │$/);
	const delta = narrowestBox(row, (plain) => plain.includes("+$1.24"));
	const denominator = narrowestBox(row, (plain) => plain.includes("136.9k/1M"));
	const second = narrowestBox(row, (plain) => plain.includes("wk 12%"));
	const gauge = narrowestBox(row, (plain) => plain.includes("[▰▱▱▱▱]"));
	const binding = narrowestBox(row, (plain) => plain.includes("5h 43%"));
	const fullLeft = narrowestBox(row, (plain) => plain.includes("│ …/Sources/pi-persona · main "));
	assert.ok(delta > denominator && denominator > second && second > gauge && gauge > binding && binding > fullLeft,
		`delta ${delta} > denominator ${denominator} > second window ${second} > gauge ${gauge} > binding window ${binding} > full left ${fullLeft}`);
	// Each step is exactly the form the order promises.
	assert.match(row(delta - 1), /\[▰▱▱▱▱\] 136\.9k\/1M · 13% · ~\$48\.89 · 5h 43% · wk 12% · 💻 Dev │$/);
	assert.match(row(denominator - 1), /\[▰▱▱▱▱\] 136\.9k · 13% · ~\$48\.89 · 5h 43% · wk 12% · 💻 Dev │$/);
	assert.match(row(second - 1), /\[▰▱▱▱▱\] 136\.9k · 13% · ~\$48\.89 · 5h 43% · 💻 Dev │$/);
	assert.match(row(gauge - 1), /main +136\.9k · 13% · ~\$48\.89 · 5h 43% · 💻 Dev │$/);
	// Below that the row is the core alone. The gauge does not come back into the
	// room the quota left: an ornament is shown only while everything that
	// outranks it still fits, so nothing ever reappears as the row narrows.
	assert.match(row(binding - 1), /│ …\/Sources\/pi-persona · main +136\.9k · 13% · ~\$48\.89 · 💻 Dev │$/);
	const coreFrom = narrowestBox(row, (plain) => plain.includes("136.9k · 13% · ~$48.89 · 💻 Dev │"), binding - 1);
	// From there down a calm quota costs nothing: the row is the one it is without a quota.
	for (let box = coreFrom - 1; box >= 12; box--) {
		const withQuota = row(box);
		state.quota = undefined;
		assert.equal(withQuota, row(box), `box ${box}: the core narrows as it does without a quota`);
		state.quota = quotaOf(43, 12);
	}
});

test("a hot quota is content: it outlives left detail, the cost, the tokens and the persona, and yields only to the context percentage", () => {
	for (const [name, quota, text, second] of [
		["warning window", quotaOf(43, 85), "wk 85%", "5h 43%"],
		["critical window", quotaOf(96, 12), "5h 96%", "wk 12%"],
		["limit", quotaOf(43, 12, { limited: true }), "limit", undefined],
	] as const) {
		const { state, status } = statusFixture({ cwd: "D:/dev/Sources/pi-persona", persona: "💻 Dev" });
		state.session = undefined;
		state.quota = quota;
		const row = (box: number) => stripAnsi(status(widthForBox(box)));
		const fullLeft = narrowestBox(row, (plain) => plain.includes("│ …/Sources/pi-persona · main "));
		const gauge = narrowestBox(row, (plain) => plain.includes("[▰▱▱▱▱]"));
		const cost = narrowestBox(row, (plain) => plain.includes("~$48.89"));
		const tokens = narrowestBox(row, (plain) => plain.includes("136.9k"));
		const persona = narrowestBox(row, (plain) => plain.includes("💻")); // whole, then trimmed to "💻 D…", then gone
		const hot = narrowestBox(row, (plain) => plain.includes(text));
		const percent = narrowestBox(row, (plain) => plain.includes("13%"));
		assert.ok(gauge > fullLeft && fullLeft > cost && cost > tokens && tokens > persona && persona > hot && hot > percent,
			`${name}: gauge ${gauge} > full left ${fullLeft} > cost ${cost} > tokens ${tokens} > persona ${persona} > quota ${hot} > percent ${percent}`);
		// The second window is still an ornament: after the denominator, before the gauge.
		if (second) {
			const other = narrowestBox(row, (plain) => plain.includes(second));
			const denominator = narrowestBox(row, (plain) => plain.includes("136.9k/1M"));
			assert.ok(denominator > other && other > gauge, `${name}: denominator ${denominator} > second window ${other} > gauge ${gauge}`);
		}
		assert.match(row(gauge - 1), new RegExp(`│ …/Sources/pi-persona · main +136\\.9k · 13% · ~\\$48\\.89 · ${text} · 💻 Dev │$`), `${name}: the core keeps it`);
		assert.match(row(cost - 1), new RegExp(` 136\\.9k · 13% · ${text} · 💻 Dev │$`), `${name}: the cost goes first`);
		assert.match(row(tokens - 1), new RegExp(` 13% · ${text} · 💻 Dev │$`), `${name}: then the token count`);
		assert.match(row(persona - 1), new RegExp(` 13% · ${text} │$`), `${name}: then the persona`);
		assert.match(row(hot - 1), / 13% ?│$/, `${name}: the context percentage stands last`);
		assert.ok(!row(hot - 1).includes("·"), `${name}: nothing else beside it`);
	}
});

test("a quota text is whole or absent at every width, with or without usage, cost and persona", () => {
	const variants: readonly (readonly [string, QuotaView | undefined, readonly string[]])[] = [
		["two calm", quotaOf(43, 12), ["5h 43%", "wk 12%"]],
		["two, weekly hot", quotaOf(43, 85), ["5h 43%", "wk 85%"]],
		["two, both full", quotaOf(100, 100), ["5h 100%", "wk 100%"]],
		["one calm", quotaOf(undefined, 7), ["wk 7%"]],
		["one hot", quotaOf(96, undefined), ["5h 96%"]],
		["limit", quotaOf(43, 12, { limited: true }), ["limit"]],
		["limit alone", quotaOf(undefined, undefined, { limited: true }), ["limit"]],
		["aged", quotaOf(43, 12, { later: QUOTA_STALE_MS + 1 }), ["5h 43%", "wk 12%"]],
	];
	useTerminalMetrics({ visibleWidth, truncateToWidth });
	try {
		for (const [name, quota, texts] of variants) {
			assert.ok(quota, `${name}: the fixture builds a view`);
			for (const usage of [{ tokens: 136_900, contextWindow: 1_000_000, percent: 13 }, { tokens: null, contextWindow: 200_000, percent: null }, undefined]) {
				for (const persona of [undefined, "Elite", "🧑‍💻 界"]) {
					for (const cost of ["~$48.89", ""]) {
						for (const height of [1, 2]) {
							const { editor, state } = statusFixture({ persona, height, cwd: "D:/dev/Sources/pi-persona" });
							Object.assign(state, { usage, cost, quota, branch: "feature/界-का-long-branch", session: "review session with long metadata" });
							const seen = new Set<string>();
							for (let width = 12; width <= 200; width++) {
								const rows = editor.render(width);
								const expectedWidth = visibleWidth(rows[0]!);
								for (const line of rows) {
									assert.ok(visibleWidth(line) <= width, `${name} @${width}: overflow: ${line}`);
									assert.equal(visibleWidth(line), expectedWidth, `${name} @${width}: rail mismatch`);
								}
								const plain = stripAnsi(rows.at(-2)!);
								// Every trace of a quota text is the whole text: no "5h 4…", "wk…", "lim…".
								const traces = plain.match(/\d+h\b[^·│]*|wk\b[^·│]*|\blim[a-z…]*[^·│]*/g) ?? [];
								for (const trace of traces) assert.ok(texts.includes(trace.trim()), `${name} @${width}: clipped quota "${trace}" in: ${plain}`);
								for (const text of texts) if (plain.includes(text)) seen.add(text);
								assert.doesNotMatch(plain, /·\s+·|·\s+│|│\s+·/, `${name} @${width}: no dangling separator: ${plain}`);
							}
							assert.deepEqual([...seen].sort(), [...texts].sort(), `${name}: every form appears at some width`);
						}
					}
				}
			}
		}
	} finally {
		useTerminalMetrics();
	}
});
