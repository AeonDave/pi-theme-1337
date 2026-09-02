/**
 * Width-parity check against a real pi checkout — the one invariant the unit
 * tests structurally cannot prove.
 *
 * `frameEditor` pads every row to a fixed column count. It measures with the
 * ruler `width.ts` exposes; the terminal is painted by pi-tui, which measures
 * with its own. If ours ever reads a cluster narrower than pi-tui does, the row
 * is padded past the terminal edge, wraps, and pi's differential renderer loses
 * a row — that is how a stale piece of border survives a repaint (and why pi
 * throws `Rendered line exceeds terminal width` on a differential pass).
 *
 * A unit test can't catch that: measuring the frame with the same ruler that
 * built it cancels the error out. So this drives pi's *real* editor and measures
 * the result with pi's *real* `visibleWidth`.
 *
 * It loads pi-tui through its **package entry**, the same surface `index.ts`
 * imports — so it also catches the other half of the problem: a helper that
 * exists in the repo but not in the published bundle you actually run against
 * (0.83.0 ships no `stripTerminalSequences`; importing it yielded `undefined`
 * and took the TUI down on the first render).
 *
 *   npm run test:parity                        # a pi checkout at ../pi
 *   PI_TUI=/path/to/pi-tui/dist/index.js …     # or the installed bundle — prefer this
 *
 * Skips (exit 0) when neither is found — it is not part of `npm test`.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { editorWidthFor, frameEditor, ROUNDED } from "../src/frame.ts";
import { chooseBox, useTerminalMetrics } from "../src/width.ts";

const local = (p: string) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const entry = process.env.PI_TUI ?? `${local("../../pi/")}packages/tui/src/index.ts`;

if (!existsSync(entry)) {
	console.log(`skip: no pi-tui at ${entry} (set PI_TUI to the bundle you run against)`);
	process.exit(0);
}

interface EditorLike {
	focused: boolean;
	setText(text: string): void;
	render(width: number): string[];
}

const tui = (await import(pathToFileURL(entry).href)) as {
	Editor: new (tui: unknown, theme: unknown, options: unknown) => EditorLike;
	visibleWidth?: (s: string) => number;
	truncateToWidth?: (s: string, max: number, ellipsis?: string) => string;
};

// The export surface index.ts depends on must actually be there. A named import
// that resolves to `undefined` is the failure this whole seam exists to survive.
for (const name of ["Editor", "visibleWidth", "truncateToWidth"] as const) {
	if (typeof tui[name] !== "function") {
		console.error(`FAIL: ${entry} exports no callable \`${name}\` — index.ts imports it`);
		process.exit(1);
	}
}
const piVisibleWidth = tui.visibleWidth as (s: string) => number;
const piTruncateToWidth = tui.truncateToWidth as (s: string, max: number, ellipsis?: string) => string;
const { Editor } = tui;

/** The wiring index.ts installs at load time (stripAnsi stays the built-in one). */
const injectPiMetrics = () =>
	useTerminalMetrics({
		visibleWidth: piVisibleWidth,
		truncateToWidth: (text, max, ellipsis = "…") => piTruncateToWidth(text, max, ellipsis),
	});

const nul = (s: string) => s;
const editor = new Editor({ terminal: { rows: 40, columns: 120 }, requestRender() {} }, {
	borderColor: nul,
	selectList: { text: nul, selectedText: nul, description: nul, selectedDescription: nul, scrollIndicator: nul },
}, { paddingX: 1 });
editor.focused = true;

// Scripts that terminals size differently — the cases the hand-rolled mirror got
// wrong: tabs, Indic/Burmese spacing marks, plane-2 wide ideographs, vertical forms.
const CORPUS = [
	"refactor the auth module",
	"perché non funziona? città però",
	"C:\\Users\\novad\\Desktop\\ctf\\web",
	"emoji 👨‍👩‍👧‍👦 e 🇮🇹 e 🎯",
	"check ✓ fail ✗ star ✦ bolt ⚡",
	"日本語のテキスト 한국어 텍스트",
	"สวัสดีครับ ทดสอบ",
	"नमस्ते दुनिया",
	"မြန်မာစာ စမ်းသပ်",
	"العربية اختبار мир текст",
	"con\ttab\tdentro",
	"combining é ü ñ ā café",
	"tangut \u{17000} kana \u{1B000} hexagram ䷀ halffill 〿",
	"vertical ︐︑ forms",
	"…/desktop/ctf · main",
	"a".repeat(240),
	"parola ".repeat(30),
];

const MAX_WIDTH = 100;
const MIN_MARGIN = 2;
const rnd = (n: number) => Math.floor(Math.random() * n);

function sweep(): { cases: number; bad: number; overflow: number; examples: string[] } {
	let cases = 0;
	let bad = 0;
	let overflow = 0;
	const examples: string[] = [];

	for (let i = 0; i < 5000; i++) {
		const cols = 20 + rnd(120);
		let text = "";
		for (let p = 0, n = 1 + rnd(3); p < n; p++) text += `${CORPUS[rnd(CORPUS.length)]} `;
		if (rnd(4) === 0) text += `\n${CORPUS[rnd(CORPUS.length)]}`;
		editor.setText(text);

		const { fallback, boxWidth, leftMargin } = chooseBox(cols, MAX_WIDTH, MIN_MARGIN);
		const editorWidth = editorWidthFor(boxWidth);
		if (fallback || editorWidth < 4) continue;
		const raw = editor.render(editorWidth); // pi's editor, laid out with pi's ruler
		if (raw.length < 2) continue;

		const rows = frameEditor(raw, {
			boxWidth,
			leftMargin,
			style: ROUNDED,
			border: nul,
			prompt: "›",
			spinner: "⠹",
			statusLeft: " ~/…/ctf · main",
			statusCenter: "60.0k · 22%",
			statusRight: [{ pre: "anthropic/opus-4-8 · Elite " }, { pre: "Elite " }],
		});
		cases++;

		const want = leftMargin + boxWidth;
		for (const row of rows) {
			const got = piVisibleWidth(row); // measured the way the terminal will paint it
			if (got === want) continue;
			bad++;
			if (got > cols) overflow++;
			if (examples.length < 5) {
				examples.push(`    cols=${cols} got=${got} want=${want} text=${JSON.stringify(text.slice(0, 60))}`);
			}
		}
	}
	return { cases, bad, overflow, examples };
}

const report = (label: string, r: ReturnType<typeof sweep>) => {
	console.log(`${label}: ${r.cases} framed renders, ${r.bad} mis-measured rows, ${r.overflow} wider than the terminal`);
	for (const line of r.examples) console.log(line);
};

// The pass that must hold: production geometry, end to end, against a real editor.
injectPiMetrics();
const injected = sweep();
report("pi-tui ruler (production)", injected);

// Diagnostic: how far the dependency-free mirror in width.ts has drifted from
// pi-tui. Production no longer depends on it — only the unit tests do — so this
// reports rather than fails. A number climbing here means the mirror is rotting.
useTerminalMetrics();
const mirror = sweep();
report("built-in mirror (tests only)", mirror);
if (mirror.bad > 0) console.log("  ^ the mirror has drifted from pi-tui — harmless in production, but fix it before trusting the unit tests");

if (injected.bad > 0) process.exit(1);
