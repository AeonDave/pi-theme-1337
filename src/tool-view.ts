/** Pure, standalone transcript views. Execution and image rendering remain the host's. */
import type { Theme, ThemeBg, ThemeColor, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	codePointAtIndex,
	formatDuration,
	isLineSeparator,
	isLoneSurrogate,
	isUnsafeCodePoint,
	plural,
	recordOf,
	sanitizeInlineText,
	skipTerminalSequence,
	textOf,
} from "./format.ts";
import { changedSpans, type DiffSpan } from "./diff-spans.ts";
import { toolWords } from "./tool-lexicon.ts";
import { clipTextRows, stripAnsi, truncateToWidth, visibleWidth } from "./width.ts";

export type CallContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Row = {
	text: string;
	color: ThemeColor;
	background?: ThemeBg;
	dot?: ThemeColor;
	wrap?: boolean;
	/**
	 * Plain sanitized text painted `dim` right after a non-wrapping row's text, so
	 * metadata recedes behind the title. Rungs, widest first: the first that fits
	 * whole beside the title is shown, and none is ever clipped.
	 */
	meta?: readonly string[];
	/**
	 * Fuller spellings of a non-wrapping row, widest first, each shown only whole
	 * (with the first meta rung that still fits beside it); `text` is the fallback.
	 */
	texts?: readonly string[];
	/** A non-wrapping row whose END matters: when it does not fit it is cut from the left. */
	tail?: boolean;
	incomplete?: boolean;
	emphasis?: DiffSpan[];
	highlight?: (text: string, offset: number, theme: Theme) => string | undefined;
	/**
	 * Already painted spellings of a non-wrapping, multi-colored row, widest
	 * first: the first that fits is shown untouched (repainting would break its
	 * inner colors). Only the last is truncated, and only when none fits. A
	 * last rung of "" always fits and emits no line at all: whole or absent.
	 */
	painted?: readonly string[];
};
export type ViewRow = Row;
const PREVIEW_ROWS = 16;
const PREVIEW_CHARS = 8192;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Bound the input as well as the output: an unterminated control string must not
// make a one-row header scan megabytes of otherwise invisible payload.
const label = (value: unknown): string => sanitizeInlineText(textOf(value).slice(0, PREVIEW_CHARS));

/** A tool's path argument as its row prints it: sanitized, forward slashes, relative to `cwd` when inside it. */
export function pathLabel(value: unknown, cwd: string): string {
	const path = label(value).replaceAll("\\", "/");
	const root = label(cwd).replaceAll("\\", "/").replace(/\/+$/, "");
	const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
	const compare = (s: string) => windows ? s.toLowerCase() : s;
	if (path && root && compare(path) === compare(root)) return ".";
	if (root && compare(path).startsWith(`${compare(root)}/`)) return path.slice(root.length + 1);
	return path || ".";
}

/**
 * Spell every unsafe code point (and LS/PS, and an unpaired surrogate) as visible
 * `\uXXXX` text: arguments are shown for inspection, so a hidden control is named,
 * not dropped. Copies verbatim runs; expanded arguments may be megabytes.
 */
export function safeExpandedText(text: string): string {
	let out = "";
	let run = 0;
	for (let i = 0; i < text.length;) {
		const cp = codePointAtIndex(text, i);
		const size = cp > 0xffff ? 2 : 1;
		if (cp !== 0x0a && (isUnsafeCodePoint(cp) || isLineSeparator(cp) || isLoneSurrogate(cp))) {
			out += text.slice(run, i) + `\\u${cp.toString(16).padStart(4, "0")}`;
			run = i + size;
		}
		i += size;
	}
	return out + text.slice(run);
}

/**
 * Arguments are model output: a BigInt or a cycle makes JSON.stringify throw,
 * and this runs inside render. Same placeholder as the adapter's fallback row.
 */
function expandedArguments(args: Record<string, unknown>): string {
	let json: string;
	try { json = JSON.stringify(args, null, 2) ?? ""; } catch { json = "[unavailable arguments]"; }
	return safeExpandedText(json);
}

function heading(name: string, args: Record<string, unknown>, cwd: string): string {
	const verb = toolWords(name)?.title;
	if (!verb) return label(name) || "Tool";
	switch (name) {
		case "bash": return `${verb} ${commandTitle(args.command)}`;
		case "grep": case "find": return `${verb} “${label(args.pattern)}” in ${pathLabel(args.path, cwd)}`;
		case "read": return `${verb} ${pathLabel(args.path, cwd)}${label(readRange(args.offset, args.limit))}`;
		default: return `${verb} ${pathLabel(args.path, cwd)}`;
	}
}

/**
 * A script's first line, not its lines folded into one: "set -e for f in …"
 * reads as another command. " …" says more lines follow (the expanded row
 * prints them). Only a bounded head is inspected; a head that ends past the
 * first line is itself more of the script.
 */
function commandTitle(value: unknown): string {
	const command = textOf(value);
	const head = command.slice(0, PREVIEW_CHARS);
	let first = "";
	for (const { start, end } of lineSpans(head)) {
		const line = label(head.slice(start, end));
		if (!line) continue;
		if (first) return `${first} …`;
		if (end === head.length && command.length > head.length) return line; // the first line runs past the head
		first = line;
		if (end < head.length && command.length > head.length) return `${first} …`;
	}
	return first;
}

/** The host shell's own ceiling (`MAX_TIMEOUT_MS` in its bash tool): a longer timeout is refused, never run. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Stock Pi's ` (timeout 30s)` for a command that is still running, as one meta
 * rung. The argument is the model's, so only what the host's shell would run
 * is shown — a finite, positive number of seconds within its ceiling — and it
 * is spelled here, to the millisecond the host schedules: digits and a
 * decimal point, never the raw value. "" for anything else.
 */
function timeoutRung(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value * 1000 > MAX_TIMEOUT_MS) return "";
	const seconds = Math.round(value * 1000) / 1000;
	return seconds > 0 ? ` (timeout ${seconds}s)` : "";
}

/** Stock Pi's read range (`formatReadLineRange`), mirrored: `:110-131`, `:110`, or "" when malformed. */
function readRange(offset: unknown, limit: unknown): string {
	if (offset == null && limit == null) return "";
	const start = offset == null ? 1 : lineNumber(offset);
	if (start === undefined) return "";
	if (limit == null) return `:${start}`;
	const count = lineNumber(limit);
	if (count === undefined) return "";
	const end = start + count - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}

function lineNumber(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The role of the status dot every row of this package leads with. */
export function statusRole(context: CallContext): ThemeColor {
	if (context.isError) return "error";
	if (!context.isPartial) return "success"; // includes resumed results without timing
	return context.executionStarted ? "accent" : "dim";
}

/** The role of the `└` a result hangs under: the color this package's own result rows take. */
export function resultRole(context: CallContext): ThemeColor {
	return context.isError ? "error" : context.isPartial ? "accent" : "toolOutput";
}

/** Side padding of a row `width` columns wide: padding yields before content, even with pathological settings. */
function sidePad(width: number, outputPad: unknown): number {
	const requested = typeof outputPad === "number" && Number.isFinite(outputPad) ? Math.max(0, Math.floor(outputPad)) : 0;
	return Math.min(requested, Math.max(0, Math.floor((width - 2) / 2)));
}

/** Columns a flat row's lead takes: "● ", "└ ", or the two spaces that align the lines under them. */
const LEAD = 2;

/** The width a third-party renderer gets inside the flat shell: the row minus its side padding and the lead. */
export function flatInnerWidth(width: number, outputPad: unknown): number {
	return Math.max(1, width - 2 * sidePad(width, outputPad) - LEAD);
}

/** Where one slot's lines sit in a flat row: `skipped` leading blank lines were dropped, `count` are shown of `total`. */
export interface FlatSpan { skipped: number; count: number; total: number }
export interface FlatRow {
	lines: string[];
	/** Columns before the renderer's own cells, and how many it was given: mouse events map through these. */
	left: number;
	inner: number;
	call: FlatSpan;
	result: FlatSpan;
}

const isBlankLine = (line: string): boolean => line === "" || stripAnsi(line).trim() === "";

/**
 * A third-party renderer's own lines in this package's flat shell: the call
 * after one status dot, the result under a `└` connector, later lines aligned
 * under the first. The lines are never rewritten or wrapped — one wider than
 * the room it was rendered for is clipped — and only the blank rows a slot
 * opens or closes with are dropped: they are its padding, not its content. A
 * result with no call line above it takes the dot, unless it is rendered on
 * its own (`resultOnly`, the HTML exporter's result slot).
 * `call` and `result` must hold only strings and no image-protocol line: the caller keeps such rows out.
 */
export function flatRow(call: readonly string[], result: readonly string[], width: number, outputPad: unknown,
	dot: string, connector: string, resultOnly = false): FlatRow {
	const pad = sidePad(width, outputPad);
	const inner = Math.max(1, width - 2 * pad - LEAD);
	const indent = " ".repeat(pad);
	const rest = `${indent}  `;
	const lines: string[] = [];
	const place = (source: readonly string[], lead: string): FlatSpan => {
		let start = 0;
		let end = source.length;
		while (start < end && isBlankLine(source[start]!)) start++;
		while (end > start && isBlankLine(source[end - 1]!)) end--;
		for (let i = start; i < end; i++) {
			const line = source[i]!;
			// Measuring a styled line is the host ruler's fast path, truncating one is not: only a line that is too wide pays for it.
			lines.push((i === start ? `${indent}${lead} ` : rest) + (visibleWidth(line) <= inner ? line : truncateToWidth(line, inner, "")));
		}
		return { skipped: start, count: end - start, total: source.length };
	};
	const callSpan = place(call, dot);
	const resultSpan = place(result, callSpan.count || resultOnly ? connector : dot);
	// A row narrower than the lead itself: clip, never let a line reach past the terminal edge.
	return { lines: pad + LEAD + inner > width ? clipTextRows(lines, width) : lines, left: pad + LEAD, inner, call: callSpan, result: resultSpan };
}

/** Preserve printable output, spaces and line breaks; never replay terminal controls. */
export function safeOutput(text: string): string {
	let out = "";
	let run = 0; // start of the pending verbatim run: plain output is copied in slices, not per char
	let i = 0;
	while (i < text.length) {
		const next = skipTerminalSequence(text, i);
		if (next !== i) {
			out += text.slice(run, i);
			i = run = next;
			continue;
		}
		const cp = codePointAtIndex(text, i);
		const size = cp > 0xffff ? 2 : 1;
		let replacement: string;
		if (cp === 0x0a) {
			i += size;
			continue;
		}
		if (isLineSeparator(cp)) replacement = "\n";
		else if (cp === 0x09) replacement = "   ";
		else if (isLoneSurrogate(cp)) replacement = "\ufffd"; // measured 0 columns, painted as 1
		else if (isUnsafeCodePoint(cp)) replacement = "";
		else {
			i += size;
			continue;
		}
		out += text.slice(run, i) + replacement;
		i = run = i + size;
	}
	return out + text.slice(run);
}

/** Index spans avoid splitting a large file into an array just to preview its head. */
function* lineSpans(text: string): Generator<{ start: number; end: number }> {
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		yield { start, end };
		start = end + 1;
	}
}

function* textBlocks(result: ToolResult): Generator<string> {
	for (const block of result.content) if (block.type === "text") yield block.text;
}

function* fullText(text: string, color: ThemeColor = "toolOutput"): Generator<Row> {
	// Expanded output has no line or character cap. Empty/trailing rows are intentional.
	if (!text) return;
	const safe = safeOutput(text);
	for (const { start, end } of lineSpans(safe)) yield { text: safe.slice(start, end), color, wrap: true };
	if (!safe || safe.endsWith("\n")) yield { text: "", color, wrap: true };
}

function resultRows(result: ToolResult, expanded: boolean, partial: boolean, error: boolean, hint: string, headerOnly: boolean): Row[] {
	const color = error ? "error" : partial ? "accent" : "toolOutput";
	const images = result.content.reduce((count, block) => count + Number(block.type === "image"), 0);
	const attachments = images ? `${plural(images, "image attachment")} (display handled by host)` : "";
	const emptyText = error ? "Failed (no diagnostic text)" : partial ? "Running…" : "";
	const fallback: Row = { text: `└ ${[emptyText, attachments].filter(Boolean).join(" · ") || "No text output"}`, color };
	if (expanded) {
		const rows: Row[] = [];
		for (const text of textBlocks(result)) for (const row of fullText(text, color)) rows.push(row);
		return rows.length && (!images || rows.some(row => row.text.trim())) ? rows : [fallback];
	}
	if (headerOnly && !partial && !error) return images ? [fallback] : [];
	if (partial || error) return tailRows(result, error ? 3 : 2, color, hint, fallback);
	// Inspect only a bounded prefix, even when one text block contains a huge line.
	let prefix = "";
	let omitted = false;
	for (const text of textBlocks(result)) {
		const room = PREVIEW_CHARS - prefix.length;
		if (room <= 0) { omitted = true; break; }
		if (prefix) prefix += "\n";
		prefix += text.slice(0, room);
		if (text.length > room) { omitted = true; break; }
	}
	const safe = safeOutput(prefix);
	// `npm run` opens with a blank line: it must not spend a preview row. Only whole
	// blank lines go, so the first line keeps its indentation.
	const lines = safe.replace(/^(?:[^\S\n]*\n)+/, "").split("\n");
	const limit = 2;
	// A trailing newline is not more output: only printable later lines count.
	omitted ||= lines.slice(limit).some(line => line.trim());
	const rows: Row[] = lines.slice(0, limit).map((text, i) => ({ text: `${i === 0 ? "└ " : "  "}${text}`, color }));
	if (!safe.trim()) rows.splice(0, rows.length, fallback);
	if (omitted) rows.push({ text: `  … more output (${hint})`, color: "dim" });
	return rows;
}

/**
 * Running and failed calls preview their END: the newest progress line, the
 * exception and the exit status are what say how it is going. Only a bounded
 * suffix is inspected (never the whole output, never split whole), and the
 * omitted earlier output is announced above the tail, where it was.
 */
function tailRows(result: ToolResult, limit: number, color: ThemeColor, hint: string, fallback: Row): Row[] {
	let window = "";
	let cut = false;
	for (let i = result.content.length - 1; i >= 0; i--) {
		const block = result.content[i]!;
		if (block.type !== "text" || !block.text) continue;
		const room = PREVIEW_CHARS - window.length;
		if (room <= 0) { cut = true; break; }
		const piece = block.text.length > room ? block.text.slice(block.text.length - room) : block.text;
		window = window ? `${piece}\n${window}` : piece;
		if (block.text.length > room) { cut = true; break; }
	}
	let lines = nonBlankLines(window);
	let endOfHugeLine = false;
	if (cut) {
		// The window may open inside an escape sequence or halfway through a line:
		// start at its first line boundary (a carriage return is one too), unless
		// nothing printable follows it.
		const boundary = window.search(/[\n\r]/);
		const whole = boundary === -1 ? [] : nonBlankLines(window.slice(boundary + 1));
		if (whole.length) lines = whole;
		else {
			// One huge line: its end is what is new. The window may open with the rest
			// of a control string whose introducer was cut off, or half a surrogate pair.
			const first = window.charCodeAt(0);
			lines = nonBlankLines(dropCutControlString(first >= 0xdc00 && first <= 0xdfff ? window.slice(1) : window));
			endOfHugeLine = true;
		}
	}
	const omitted = cut || lines.length > limit;
	const tail = lines.slice(-limit);
	if (!tail.length) return omitted ? [{ text: `└ … earlier output (${hint})`, color: "dim" }] : [fallback];
	if (!omitted) return tail.map((text, i) => ({ text: `${i === 0 ? "└ " : "  "}${text}`, color }));
	return [{ text: `└ … earlier output (${hint})`, color: "dim" },
		...tail.map(text => ({ text: `  ${text}`, color, tail: endOfHugeLine }))];
}

/**
 * Printable, non-blank lines as a terminal would leave them: a carriage return
 * rewrites its line, so a progress meter shows its newest value, not its first.
 */
function nonBlankLines(window: string): string[] {
	const rewritten = window.split("\n").map(line => {
		const settled = line.replace(/\r+$/, "");
		return settled.slice(settled.lastIndexOf("\r") + 1);
	}).join("\n");
	return safeOutput(rewritten).split("\n").filter(line => line.trim());
}

/** Drop the remains of an OSC/DCS/APC payload when its terminator comes before any introducer. */
function dropCutControlString(window: string): string {
	const introducer = window.search(/[\x1b\x90\x98\x9b\x9d-\x9f]/);
	if (introducer !== -1 && window.charCodeAt(introducer) === 0x1b && window.charCodeAt(introducer + 1) === 0x5c) {
		return window.slice(introducer + 2); // ESC \ with nothing opened before it
	}
	const terminator = window.search(/[\x07\x9c]/);
	return terminator !== -1 && (introducer === -1 || terminator < introducer) ? window.slice(terminator + 1) : window;
}

/** Characters of a tail row inspected when it is cut from the left: more than any terminal is wide. */
const TAIL_SCAN = 1024;

/** Keep the end of a row that does not fit: its indent, "…", then the last graphemes that do. */
function truncateStart(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	const indent = /^[ └]*/.exec(text)![0];
	const budget = room - visibleWidth(indent) - 1;
	if (budget <= 0) return truncateToWidth(text, room, "…");
	const scanned = text.length > TAIL_SCAN;
	const graphemes = Array.from(GRAPHEMES.segment(scanned ? text.slice(-TAIL_SCAN) : text.slice(indent.length)), item => item.segment);
	let kept = "";
	let used = 0;
	// When the scan window was sliced, its first grapheme may be half of one: never take it.
	for (let i = graphemes.length - 1; i >= (scanned ? 1 : 0); i--) {
		const size = visibleWidth(graphemes[i]!);
		if (used + size > budget) break;
		kept = graphemes[i] + kept;
		used += size;
	}
	return `${indent}…${kept}`;
}

function diffRow(text: string, wrap: boolean): Row {
	const sign = /^ {2,}\d+ ([+\- ]) /.exec(text)?.[1];
	return {
		text, wrap,
		color: sign === "+" ? "toolDiffAdded" : sign === "-" ? "toolDiffRemoved" : "toolDiffContext",
		background: sign === "+" ? "toolSuccessBg" : sign === "-" ? "toolErrorBg" : undefined,
	};
}

/** Old/new line numbers use different coordinate spaces after insertions/deletions. */
function emphasizeReplacements(rows: Row[], complete: boolean): void {
	let removed: Array<{ row: Row; offset: number }> = [];
	let added: Array<{ row: Row; offset: number }> = [];
	const flush = () => {
		// Uneven groups lack an unambiguous positional pairing. Keep full-line color.
		if (removed.length === added.length) for (let i = 0; i < removed.length; i++) {
			const before = removed[i]!;
			const after = added[i]!;
			if (before.row.incomplete || after.row.incomplete) continue;
			const spans = changedSpans(before.row.text.slice(before.offset), after.row.text.slice(after.offset));
			before.row.emphasis = spans.before.map(span => ({ start: span.start + before.offset, end: span.end + before.offset }));
			after.row.emphasis = spans.after.map(span => ({ start: span.start + after.offset, end: span.end + after.offset }));
		}
		removed = [];
		added = [];
	};
	for (const row of rows) {
		const match = /^ {2,}\d+ ([+-]) /.exec(row.text);
		if (!match) { flush(); continue; }
		if (match[1] === "-" && added.length) flush();
		(match[1] === "-" ? removed : added).push({ row, offset: match[0].length });
	}
	if (complete) flush(); // The preview may end halfway through a larger change group.
}

function fileRows(name: string, args: Record<string, unknown>, result: ToolResult, expanded: boolean, hint: string, highlightCode?: (code: string, path: string) => string[]): Row[] | undefined {
	const source = name === "edit" ? recordOf(result.details).diff : args.content;
	if (typeof source !== "string" || (name === "edit" && !source)) return undefined;
	let count = 0;
	let added = 0;
	let removed = 0;
	const rows: Row[] = [];
	let lineNumberWidth = 1;
	for (const { start, end } of lineSpans(source)) {
		count++;
		if (name !== "edit") continue;
		const match = /^([+\- ])\s*(\d+)\s/.exec(source.slice(start, Math.min(end, start + 64)));
		if (match) lineNumberWidth = Math.max(lineNumberWidth, match[2].length);
	}
	// write numbers its own lines 1..count: the widest number is the last one.
	if (name !== "edit") lineNumberWidth = String(count).length;
	count = 0;
	for (const { start, end } of lineSpans(source)) {
		count++;
		const raw = source.slice(start, Math.min(end, start + 64));
		const parsed = name === "edit" ? /^([+\- ])\s*(\d+)\s/.exec(raw) : undefined;
		if (parsed?.[1] === "+") added++;
		if (parsed?.[1] === "-") removed++;
		if (!expanded && rows.length >= PREVIEW_ROWS) continue;
		const cap = expanded ? end : Math.min(end, start + PREVIEW_CHARS);
		const content = safeOutput(source.slice(start, cap)).replaceAll("\n", " ") + (cap < end ? "…" : "");
		if (name === "edit") {
			const line = /^([+\- ])\s*(\d+)\s(.*)$/s.exec(content);
			if (line) {
				const [, sign, number, body] = line;
				const gutter = `  ${number.padStart(lineNumberWidth)} ${sign} `;
				if (sign === " " && highlightCode) {
					const bodyOffset = gutter.length;
					rows.push({
						text: gutter + body, color: "toolDiffContext", wrap: expanded,
						highlight(text, offset, theme) {
							try {
								const code = offset === 0 ? text.slice(bodyOffset) : text;
								const highlighted = highlightCode(code, label(args.path))[0];
								if (highlighted === undefined || !/\x1b\[[0-?]*[ -/]*[@-~]/.test(highlighted) || visibleWidth(highlighted) !== visibleWidth(code)) return undefined;
								const gutter = offset === 0 ? theme.fg("toolDiffContext", text.slice(0, bodyOffset)) : "";
								return gutter + highlighted;
							} catch { return undefined; }
						},
					});
				} else rows.push({ ...diffRow(`${gutter}${body}`, expanded), incomplete: cap < end });
			} else rows.push(diffRow(content, expanded));
		} else rows.push({ text: `  ${String(count).padStart(lineNumberWidth)} + ${content}`, color: "toolDiffAdded", background: "toolSuccessBg", wrap: expanded });
	}
	if (name === "edit") emphasizeReplacements(rows, count === rows.length);
	const summary = name === "write" ? `Wrote ${plural(count, "line")}` : `Added ${plural(added, "line")}, removed ${plural(removed, "line")}`;
	const remainder = count - rows.length;
	rows.unshift({ text: `└ ${summary}`, color: "dim" });
	if (remainder > 0) rows.push({ text: `  … ${remainder} more lines (${hint})`, color: "dim" });
	if (expanded) for (const text of textBlocks(result)) for (const row of fullText(text)) rows.push(row);
	return rows;
}

/** Wrap sanitized text using only the host-installed ruler, preserving grapheme boundaries. */
function* wrap(text: string, room: number): Generator<{ text: string; offset: number }> {
	let current = "";
	let offset = 0;
	let used = 0;
	for (const item of GRAPHEMES.segment(text)) {
		const size = visibleWidth(item.segment);
		if (used + size > room && current) {
			yield { text: current, offset };
			current = "";
			offset = item.index;
			used = 0;
		}
		if (size > room) {
			// A one-cell viewport cannot draw a wide grapheme. A visible Unicode
			// spelling retains its identity rather than silently discarding it.
			const escaped = Array.from(item.segment, char => `\\u{${codePointAtIndex(char, 0).toString(16)}}`).join("");
			for (let i = 0; i < escaped.length; i += room) yield { text: escaped.slice(i, i + room), offset: item.index };
			offset = item.index + item.segment.length;
			continue;
		}
		current += item.segment;
		used += size;
	}
	if (current || !text) yield { text: current, offset };
}

function paint(row: Row, text: string, offset: number, room: number, theme: Theme): string {
	let decorated = text;
	if (row.emphasis?.length) {
		const sourceLength = !row.wrap && text !== row.text && text.endsWith("…") ? text.length - 1 : text.length;
		let cursor = 0;
		decorated = "";
		for (const span of row.emphasis) {
			const start = Math.max(0, span.start - offset);
			const end = Math.min(sourceLength, span.end - offset);
			if (end <= start) continue;
			decorated += text.slice(cursor, start) + theme.bold(text.slice(start, end));
			cursor = end;
		}
		decorated += text.slice(cursor);
	}
	decorated = row.dot && text.startsWith("●")
		? theme.fg(row.dot, "●") + theme.fg(row.color, text.slice(1))
		: theme.fg(row.color, decorated);
	if (row.background) decorated = theme.bg(row.background, decorated + " ".repeat(Math.max(0, room - visibleWidth(text))));
	return decorated;
}

/** Paint a non-wrapping row's `text` whole, with the widest meta rung that fits beside it; undefined when it does not fit. */
function whole(row: Row, text: string, room: number, theme: Theme, alone: boolean): string | undefined {
	const textWidth = visibleWidth(text);
	const meta = row.meta?.find(rung => rung && textWidth + visibleWidth(rung) <= room);
	if (meta) return paint(row, text, 0, room - visibleWidth(meta), theme) + theme.fg("dim", meta);
	return alone && textWidth <= room ? paint(row, text, 0, room, theme) : undefined;
}

/**
 * `key` names what the rows were built from beyond the view's own inputs (a
 * header's outcome arrives with the result): when it changes, rows rebuild.
 */
export function view(theme: Theme, context: { readonly outputPad?: number }, build: () => Row[], key?: () => unknown): Component {
	let rows: Row[] | undefined;
	let builtFor: unknown;
	let rendered: { width: number; pad: number; lines: string[] } | undefined;
	return {
		invalidate() { rows = undefined; rendered = undefined; },
		render(width) {
			width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			if (!width) return [];
			if (key && rows && key() !== builtFor) { rows = undefined; rendered = undefined; }
			const pad = sidePad(width, context.outputPad);
			if (rendered?.width === width && rendered.pad === pad) return rendered.lines;
			const room = width - 2 * pad;
			const indent = " ".repeat(pad);
			const output: string[] = [];
			if (!rows) {
				builtFor = key?.();
				rows = build();
			}
			for (const row of rows) {
				if (row.painted?.length) {
					const fit = row.painted.find(rung => visibleWidth(rung) <= room);
					// An empty rung is the row's way of being absent at this width: no line, not a blank one.
					if (fit !== "") output.push(indent + (fit ?? truncateToWidth(row.painted[row.painted.length - 1]!, room, "…")));
					continue;
				}
				if (!row.wrap && (row.meta || row.texts)) {
					let line: string | undefined;
					for (const text of row.texts ?? []) if ((line = whole(row, text, room, theme, true)) !== undefined) break;
					line ??= whole(row, row.text, room, theme, false);
					if (line !== undefined) {
						output.push(indent + line);
						continue;
					}
					// Never a clipped "(expan…": no rung fits, so the title alone truncates.
				}
				const chunks = row.wrap ? wrap(row.text, room)
					: [{ text: row.tail ? truncateStart(row.text, room) : truncateToWidth(row.text, room, "…"), offset: 0 }];
				for (const chunk of chunks) {
					const highlighted = row.highlight?.(chunk.text, chunk.offset, theme);
					output.push(indent + (highlighted !== undefined && visibleWidth(highlighted) <= room
						? highlighted : paint(row, chunk.text, chunk.offset, room, theme)));
				}
			}
			rendered = { width, pad, lines: output };
			return output;
		},
	};
}

/** Renderers contain presentation only; callers decide whether a tool should use them. */
export interface ToolViewDependencies {
	highlightCode?: (code: string, path: string) => string[];
}

/**
 * The row-local record a result leaves for its header. Both renderers of one
 * row get the same `context.state`, in either call order; keyed by the host's
 * content array (stable across re-renders of one result) so a result is
 * counted once, not on every expand toggle or frame.
 */
const OUTCOME = Symbol("pi1337-outcome");
type OutcomeRecord = { content: ToolResult["content"]; details: unknown; text: string };
type RowState = { [OUTCOME]?: OutcomeRecord };

function recordOutcome(state: RowState, toolName: string, args: Record<string, unknown>, result: ToolResult, settled: boolean): void {
	const last = state[OUTCOME];
	if (!settled) { state[OUTCOME] = undefined; return; }
	if (last?.content === result.content && last.details === result.details) return;
	state[OUTCOME] = { content: result.content, details: result.details, text: outcomeOf(toolName, args, result) };
}

const count = (n: number, one: string, many: string, more = false) => more ? `${n}+ ${many}` : plural(n, one, many);
const limitOf = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * What a settled, successful quiet call found — "6 matches", "no results",
 * "12 entries", "40 lines" — from the host tool's own result contract: zero
 * results are its exact sentinel text, a limit is `details.*LimitReached`
 * (so "100+"), a byte cap is `details.truncation.totalLines`. Otherwise rows
 * are counted once, up to the notice the host appends after a blank line.
 * "" whenever the result does not say reliably (grep with context lines mixes
 * match and context rows; another tool's text shape; images).
 */
function outcomeOf(toolName: string, args: Record<string, unknown>, result: ToolResult): string {
	if (result.content.length !== 1 || result.content[0]!.type !== "text") return "";
	const text = result.content[0]!.text;
	const details = recordOf(result.details);
	const truncation = recordOf(details.truncation);
	const total = truncation.truncated === true && typeof truncation.totalLines === "number" && Number.isInteger(truncation.totalLines) && truncation.totalLines > 0
		? truncation.totalLines : undefined;
	// Rows end where the host's notice block starts; a notice is appended only with details.
	const rows = () => countLines(text, Object.keys(details).length > 0);
	switch (toolName) {
		case "grep": {
			const limit = limitOf(details.matchLimitReached);
			if (limit) return count(limit, "match", "matches", true);
			if (text === "No matches found") return "no matches";
			if (args.context != null && !(Number(args.context) <= 0)) return "";
			return count(total ?? rows(), "match", "matches");
		}
		case "find": {
			const limit = limitOf(details.resultLimitReached);
			// The host's find lists directories too and calls its rows "results".
			if (limit) return count(limit, "result", "results", true);
			if (text === "No files found matching pattern") return "no results";
			return count(total ?? rows(), "result", "results");
		}
		case "ls": {
			const limit = limitOf(details.entryLimitReached);
			if (limit) return count(limit, "entry", "entries", true);
			if (text === "(empty directory)") return "empty";
			return count(total ?? rows(), "entry", "entries");
		}
		case "bash": {
			if (total) return count(total, "line", "lines");
			if (text === "(no output)" || !text) return "";
			const lines = countLines(text, false);
			return lines ? count(lines, "line", "lines") : "";
		}
		default: return "";
	}
}

/**
 * Lines as the host counts them (a trailing newline ends a line, it does not
 * start one), optionally stopping at the first blank line. One indexOf pass.
 */
export function countLines(text: string, untilBlank = false): number {
	let lines = 0;
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		if (untilBlank && newline === start) break;
		lines++;
		if (newline === -1) break;
		start = newline + 1;
	}
	return lines;
}

export function createToolView(toolName: string, expandHint: () => string, dependencies: ToolViewDependencies = {}): ToolRenderers {
	const quiet = toolWords(toolName)?.quiet === true;
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as RowState;
			const outcomeKey = () => state[OUTCOME];
			return view(theme, context, () => {
				// Sub-second timings are noise next to the title; settled slow calls earn one.
				const duration = !context.isPartial && typeof context.durationMs === "number" && Number.isFinite(context.durationMs) && context.durationMs >= 1000
					? ` · ${formatDuration(context.durationMs)}` : "";
				const settled = !context.expanded && !context.isPartial && !context.isError && quiet;
				const hint = settled ? ` (${label(expandHint()) || "expand"})` : "";
				// Derived from tool text, so it is sanitized like any other foreign label.
				const found = settled ? label(state[OUTCOME]?.text) : "";
				const outcome = found ? ` · ${found}` : "";
				// The hint is boilerplate every quiet row carries; a slow call's time is
				// not, and what the call found matters most of all.
				const meta = outcome ? [outcome + duration + hint, outcome + duration, outcome] : [duration + hint, duration];
				// A running command names the timeout the model chose, as stock Pi does. It is
				// the first rung to go, and gone with the final result: by then it either
				// held or the error says so.
				const timeout = toolName === "bash" && context.isPartial ? timeoutRung(recordOf(args).timeout) : "";
				const rows: Row[] = [{ text: `● ${heading(toolName, recordOf(args), context.cwd)}`, color: "toolTitle", dot: statusRole(context),
					meta: timeout ? [timeout + meta[0]!, ...meta] : meta }];
				if (context.expanded) {
					const allArgs = recordOf(args);
					if (toolName === "bash") {
						for (const row of fullText(safeExpandedText(textOf(allArgs.command)))) rows.push(row);
						const { command: _command, ...otherArgs } = allArgs;
						if (Object.keys(otherArgs).length) for (const row of fullText(expandedArguments(otherArgs), "toolOutput")) rows.push(row);
					} else {
					for (const row of fullText(expandedArguments(allArgs), "toolOutput")) rows.push(row);
					}
				}
				return rows;
			}, outcomeKey);
		},
		renderResult(result, options, theme, context) {
			if (quiet) recordOutcome(context.state as RowState, toolName, recordOf(context.args), result,
				!options.isPartial && !context.isPartial && !context.isError);
			return view(theme, context, () => {
				const hint = label(expandHint()) || "expand";
				const partial = options.isPartial || context.isPartial;
				if (!partial && !context.isError && (toolName === "edit" || toolName === "write")) {
					const rows = fileRows(toolName, recordOf(context.args), result, options.expanded, hint, dependencies.highlightCode);
					if (rows) return rows;
				}
				return resultRows(result, options.expanded, partial, context.isError, hint,
					toolWords(toolName)?.quiet === true);
			});
		},
	};
}

/**
 * One folded run's row: "● Read width.ts, frame.ts · searched 2 patterns (ctrl+o to expand)"
 * when that row fits whole (its hint only if that fits too), else the counted
 * "● Read 2 files, searched 2 patterns (…)". Built on the same rows as every
 * tool header, so it shares their indent, sanitizing, single-line truncation
 * and width cache.
 */
export function createRunSummaryView(sentence: string, theme: Theme, context: CallContext, expandHint: () => string, detailed = ""): Component {
	return view(theme, context, () => {
		const names = label(detailed);
		const counted = label(sentence);
		return [{
			text: `● ${counted}`, color: "toolTitle", dot: "success", meta: [` (${label(expandHint()) || "expand"})`],
			texts: names && names !== counted ? [`● ${names}`] : undefined,
		}];
	});
}
