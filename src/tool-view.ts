/** Pure, standalone transcript views. Execution and image rendering remain the host's. */
import type { Theme, ThemeBg, ThemeColor, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { sanitizeInlineText } from "./format.ts";
import { truncateToWidth, visibleWidth } from "./width.ts";

type CallContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Row = {
	text: string;
	color: ThemeColor;
	background?: ThemeBg;
	dot?: ThemeColor;
	wrap?: boolean;
	emphasis?: { start: number; end: number };
	highlight?: (text: string, offset: number, theme: Theme) => string | undefined;
};
const BUILTINS = new Set(["bash", "read", "grep", "find", "ls", "edit", "write"]);
const PREVIEW_ROWS = 16;
const PREVIEW_CHARS = 8192;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function isPolishedTool(name: string): boolean {
	return BUILTINS.has(name);
}

const string = (value: unknown): string => typeof value === "string" ? value : "";
const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
// Bound the input as well as the output: an unterminated control string must not
// make a one-row header scan megabytes of otherwise invisible payload.
const label = (value: unknown): string => sanitizeInlineText(string(value).slice(0, PREVIEW_CHARS));

function pathLabel(value: unknown, cwd: string): string {
	const path = label(value).replaceAll("\\", "/");
	const root = label(cwd).replaceAll("\\", "/").replace(/\/+$/, "");
	const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
	const compare = (s: string) => windows ? s.toLowerCase() : s;
	if (path && root && compare(path) === compare(root)) return ".";
	if (root && compare(path).startsWith(`${compare(root)}/`)) return path.slice(root.length + 1);
	return path || ".";
}

function safeExpandedText(text: string): string {
	return Array.from(text, char => {
		const cp = char.codePointAt(0)!;
		if (cp === 0x0a) return char;
		if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x061c || cp === 0x200e || cp === 0x200f ||
			cp === 0x2028 || cp === 0x2029 || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
			return `\\u${cp.toString(16).padStart(4, "0")}`;
		}
		return char;
	}).join("");
}

function expandedArguments(args: Record<string, unknown>): string {
	return safeExpandedText(JSON.stringify(args, null, 2));
}

function heading(name: string, args: Record<string, unknown>, cwd: string): string {
	const path = pathLabel(args.path, cwd);
	switch (name) {
		case "bash": return `$ ${label(args.command)}`;
		case "read": return `Read ${path}`;
		case "edit": return `Update ${path}`;
		case "write": return `Write ${path}`;
		case "ls": return `List ${path}`;
		case "grep": return `Search “${label(args.pattern)}” in ${path}`;
		case "find": return `Find “${label(args.pattern)}” in ${path}`;
		default: return label(name) || "Tool";
	}
}

function status(context: CallContext): ThemeColor {
	if (context.isError) return "error";
	if (!context.isPartial) return "success"; // includes resumed results without timing
	return context.executionStarted ? "accent" : "dim";
}

/** Preserve printable output, spaces and line breaks; never replay terminal controls. */
function safeOutput(text: string): string {
	let mode: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
	let out = "";
	for (const char of text) {
		const cp = char.codePointAt(0)!;
		if (mode === "string" || mode === "stringEscape") {
			if (cp === 7 || cp === 0x9c || (mode === "stringEscape" && char === "\\")) mode = "text";
			else mode = cp === 27 ? "stringEscape" : "string";
			continue;
		}
		if (mode === "csi") {
			if (cp >= 0x40 && cp <= 0x7e) mode = "text";
			continue;
		}
		if (mode === "escape") {
			mode = char === "[" ? "csi" : "]P_^X".includes(char) ? "string" : "text";
			continue;
		}
		if (cp === 27) { mode = "escape"; continue; }
		if (cp === 0x9b) { mode = "csi"; continue; }
		if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(cp)) { mode = "string"; continue; }
		if (char === "\n" || cp === 0x2028 || cp === 0x2029) out += "\n";
		else if (char === "\t") out += "   ";
		else if (cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f) &&
			cp !== 0x61c && cp !== 0x200e && cp !== 0x200f &&
			!(cp >= 0x202a && cp <= 0x202e) && !(cp >= 0x2066 && cp <= 0x2069)) out += char;
	}
	return out;
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

const linesLabel = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

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
	const attachments = images ? `${images} image attachment${images === 1 ? "" : "s"} (display handled by host)` : "";
	const emptyText = error ? "Failed (no diagnostic text)" : partial ? "Running…" : "";
	const fallback: Row = { text: `└ ${[emptyText, attachments].filter(Boolean).join(" · ") || "No text output"}`, color };
	if (expanded) {
		const rows: Row[] = [];
		for (const text of textBlocks(result)) for (const row of fullText(text, color)) rows.push(row);
		return rows.length && (!images || rows.some(row => row.text.trim())) ? rows : [fallback];
	}
	if (headerOnly && !partial && !error) return images ? [fallback] : [];
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
	// Leading blank error rows must not consume the diagnostic budget.
	const lines = (error ? safe.trimStart() : safe).split("\n");
	const limit = error ? 3 : 2;
	omitted ||= lines.length > limit;
	const rows: Row[] = lines.slice(0, limit).map((text, i) => ({
		text: `${i === 0 ? partial && !error ? "└ Running: " : "└ " : "  "}${text}`, color,
	}));
	if (!safe.trim()) rows.splice(0, rows.length, fallback);
	if (omitted || error) rows.push({ text: omitted ? `  … more output (${hint})` : `  (${hint})`, color: "dim" });
	return rows;
}

function diffRow(text: string, wrap: boolean): Row {
	const sign = /^ {2,}\d+ ([+\- ]) /.exec(text)?.[1];
	return {
		text, wrap,
		color: sign === "+" ? "toolDiffAdded" : sign === "-" ? "toolDiffRemoved" : "toolDiffContext",
		background: sign === "+" ? "toolSuccessBg" : sign === "-" ? "toolErrorBg" : undefined,
	};
}

/** Match replacement rows by their authoritative line number, not the edit arguments. */
function emphasizeReplacements(rows: Row[]): void {
	const removed = new Map<string, Row>();
	for (const row of rows) {
		const match = /^ {2,}(\d+) ([+-]) (.*)$/s.exec(row.text);
		if (!match) continue;
		if (match[2] === "-") { removed.set(match[1], row); continue; }
		const before = removed.get(match[1]);
		if (!before) continue;
		const bodyStart = row.text.length - match[3].length;
		const oldStart = /^ {2,}\d+ - /.exec(before.text)![0].length;
		const old = Array.from(GRAPHEMES.segment(before.text.slice(oldStart)), item => item.segment);
		const next = Array.from(GRAPHEMES.segment(match[3]), item => item.segment);
		let left = 0;
		let right = 0;
		while (left < Math.min(old.length, next.length) && old[left] === next[left]) left++;
		while (right < Math.min(old.length, next.length) - left && old[old.length - right - 1] === next[next.length - right - 1]) right++;
		const range = (parts: string[], offset: number) => ({
			start: offset + parts.slice(0, left).join("").length,
			end: offset + parts.slice(0, parts.length - right).join("").length,
		});
		before.emphasis = range(old, oldStart);
		row.emphasis = range(next, bodyStart);
		removed.delete(match[1]);
	}
}

function fileRows(name: string, args: Record<string, unknown>, result: ToolResult, expanded: boolean, hint: string, highlightCode?: (code: string, path: string) => string[]): Row[] | undefined {
	const source = name === "edit" ? object(result.details).diff : args.content;
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
				} else rows.push(diffRow(`${gutter}${body}`, expanded));
			} else rows.push(diffRow(content, expanded));
		} else rows.push({ text: `+${count} ${content}`, color: "toolDiffAdded", background: "toolSuccessBg", wrap: expanded });
	}
	if (name === "edit") emphasizeReplacements(rows);
	const summary = name === "write" ? `File-content preview: ${linesLabel(count)}` : `Added ${linesLabel(added)}, removed ${linesLabel(removed)}`;
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
			const escaped = Array.from(item.segment, char => `\\u{${char.codePointAt(0)!.toString(16)}}`).join("");
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
	if (row.emphasis) {
		const start = Math.max(0, row.emphasis.start - offset);
		const end = Math.min(text.length, row.emphasis.end - offset);
		if (end > start) decorated = text.slice(0, start) + theme.bold(text.slice(start, end)) + text.slice(end);
	}
	decorated = row.dot && text.startsWith("●")
		? theme.fg(row.dot, "●") + theme.fg(row.color, text.slice(1))
		: theme.fg(row.color, decorated);
	if (row.background) decorated = theme.bg(row.background, decorated + " ".repeat(Math.max(0, room - visibleWidth(text))));
	return decorated;
}

function view(theme: Theme, context: CallContext, build: () => Row[]): Component {
	let rows: Row[] | undefined;
	let rendered: { width: number; pad: number; lines: string[] } | undefined;
	return {
		invalidate() { rows = undefined; rendered = undefined; },
		render(width) {
			width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			if (!width) return [];
			const requestedPad = Number.isFinite(context.outputPad) ? Math.max(0, Math.floor(context.outputPad)) : 0;
			// Sacrifice padding before content, including with pathological settings.
			const pad = Math.min(requestedPad, Math.max(0, Math.floor((width - 2) / 2)));
			if (rendered?.width === width && rendered.pad === pad) return rendered.lines;
			const room = width - 2 * pad;
			const indent = " ".repeat(pad);
			const output: string[] = [];
			rows ??= build();
			for (const row of rows) {
				const chunks = row.wrap ? wrap(row.text, room) : [{ text: truncateToWidth(row.text, room, "…"), offset: 0 }];
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

export function createToolView(toolName: string, expandHint: () => string, dependencies: ToolViewDependencies = {}): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			return view(theme, context, () => {
				const duration = !context.isPartial && typeof context.durationMs === "number" && Number.isFinite(context.durationMs) && context.durationMs >= 0
					? ` · ${Math.round(context.durationMs)}ms` : "";
				const hint = !context.expanded && !context.isPartial && !context.isError && ["bash", "read", "grep", "find", "ls"].includes(toolName)
					? ` (${label(expandHint()) || "expand"})` : "";
				const rows: Row[] = [{ text: `● ${heading(toolName, object(args), context.cwd)}${duration}${hint}`, color: "toolTitle", dot: status(context) }];
				if (context.expanded) {
					const allArgs = object(args);
					if (toolName === "bash") {
						for (const row of fullText(safeExpandedText(string(allArgs.command)))) rows.push(row);
						const { command: _command, ...otherArgs } = allArgs;
						if (Object.keys(otherArgs).length) for (const row of fullText(expandedArguments(otherArgs), "toolOutput")) rows.push(row);
					} else {
					for (const row of fullText(expandedArguments(allArgs), "toolOutput")) rows.push(row);
					}
				}
				return rows;
			});
		},
		renderResult(result, options, theme, context) {
			return view(theme, context, () => {
				const hint = label(expandHint()) || "expand";
				const partial = options.isPartial || context.isPartial;
				if (!partial && !context.isError && (toolName === "edit" || toolName === "write")) {
					const rows = fileRows(toolName, object(context.args), result, options.expanded, hint, dependencies.highlightCode);
					if (rows) return rows;
				}
				return resultRows(result, options.expanded, partial, context.isError, hint,
					["bash", "read", "grep", "find", "ls"].includes(toolName));
			});
		},
	};
}
