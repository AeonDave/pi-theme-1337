/**
 * Pure end-of-run summary: a collector fed by the agent/tool events index.ts
 * already receives, and the transcript row that paints its result.
 *
 * index.ts appends the collected numbers ONCE, as a custom session entry, when
 * the run settles; the row is rebuilt from that entry on resume and `/tree`,
 * never recomputed. Custom entries never reach the model. The entry is foreign
 * data on the way back in (a session file can be edited), so the row validates
 * every field and renders nothing for anything it does not recognize.
 *
 * Every number comes from live events, because nested (codemode) results are
 * not persisted. Files changed by shell commands are invisible here, so the
 * row says "edited"/"wrote", never "changed".
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	backgroundDetail, backgroundSummary, backgroundWorkOf, formatDuration, plural, recordOf, sanitizeInlineText, textOf,
	type BackgroundWork,
} from "./format.ts";
import { countLines, pathLabel, view, type ViewRow } from "./tool-view.ts";

export const RUN_SUMMARY_TYPE = "pi1337-run-summary";
export const RUN_SUMMARY_VERSION = 1;
/** Files listed in the entry; the rest are counted in `moreFiles`. */
export const MAX_SUMMARY_FILES = 50;
/** Distinct paths tracked per run: past it the file counts become lower bounds, never unbounded memory. */
const MAX_TRACKED_FILES = 4096;
/** Calls whose start arguments await their end event; a lost end must not grow the map forever. */
const MAX_PENDING_CALLS = 256;
/** Characters of a stored path: sanitized again on render, and bounded here so the entry is too. */
const MAX_PATH_CHARS = 512;

export type RunOutcome = "done" | "interrupted" | "failed";

export interface RunSummaryFile {
	/** Display path as the tool rows print it (cwd-relative when inside the run's cwd). */
	path: string;
	/** "write" when any successful write touched it: a written file is reported as written. */
	kind: "edit" | "write";
	/** Exact lines added/removed by its edit calls, from the host's unified patch (edits only). */
	added: number;
	removed: number;
	/** Exact lines its last successful write carried (writes only). */
	lines: number;
	/** Every touch came from a nested (codemode script) call. */
	script: boolean;
}

/** The persisted entry: plain JSON, versioned, raw numbers (formatted only when painted). */
export interface RunSummaryData {
	v: typeof RUN_SUMMARY_VERSION;
	outcome: RunOutcome;
	/** Exact: the run's first agent_start → agent_settled on the injected clock (continuations included). */
	durationMs: number;
	/** Distinct paths changed only by the edit tool (exact for observed calls; shell edits are invisible). */
	edited: number;
	/** Exact +/− lines over those edited paths, from each result's patch. */
	added: number;
	removed: number;
	/** Distinct paths the write tool wrote (exact for observed calls). */
	wrote: number;
	/** Shell tool calls (bash, powershell) that ended, nested ones included, and how many failed. Exact. */
	commands: number;
	commandsFailed: number;
	/** Every tool call that ended, nested ones included, and how many failed. Calls cut off before
	 * their end event are not counted, so on an interrupted run this is a lower bound. */
	tools: number;
	toolsFailed: number;
	/** The run's estimated spend: the same delta the status row shows (total − total when the run began);
	 * 0 when the run began while the redesign was off and there is no baseline. */
	cost: number;
	files: RunSummaryFile[];
	moreFiles: number;
	// Everything below is optional: entries written before these fields existed
	// carry none of them and render exactly as they always did, and a malformed
	// value is read as absent rather than failing the entry.
	/**
	 * pi-persona's background work still running when the run settled (a
	 * snapshot of its `persona-background` status, as counts). Present → the row
	 * does not claim the work is done.
	 */
	waiting?: BackgroundWork;
	/**
	 * Time spent waiting on the model: the sum, over the run's turns, of
	 * turn_start → that turn's assistant message_end, on the injected clock.
	 * Absent when no turn was measured. Never more than durationMs.
	 */
	modelMs?: number;
	/**
	 * Time the model spent thinking: the sum of thinking_start → thinking_end
	 * over the run's assistant messages, on the injected clock. A part of
	 * modelMs, never beside it. Absent under one second, without a model time,
	 * or when it would exceed it (a stream that never closed its block).
	 */
	thinkingMs?: number;
	/**
	 * Sum of `usage.output` over the run's assistant messages. Absent when any
	 * of them reported none: a partial sum would be a guess.
	 */
	outputTokens?: number;
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Exact +/− from a unified patch: only lines inside hunks count, so the `---`/`+++` headers never do. */
export function patchLineCounts(patch: unknown): { added: number; removed: number } {
	const text = textOf(patch);
	let added = 0;
	let removed = 0;
	let inHunk = false;
	for (let start = 0; start < text.length;) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const first = text.charCodeAt(start);
		// Hunk lines always open with " ", "+", "-" or "\": a line opening with "@@" is a header.
		if (first === 0x40 && text.charCodeAt(start + 1) === 0x40) inHunk = true;
		else if (inHunk && first === 0x2b) added++;
		else if (inHunk && first === 0x2d) removed++;
		start = end + 1;
	}
	return { added, removed };
}

/** Same-file detection: tool rows print `src/a.ts` for both `./src/a.ts` and `/work/src/a.ts`. */
function fileKey(label: string, cwd: string): string {
	const key = label.replace(/^(?:\.\/)+/, "");
	return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\") || cwd.startsWith("//") ? key.toLowerCase() : key;
}

interface PendingCall {
	toolName: string;
	path?: string;
	key?: string;
	lines?: number;
}

interface TrackedFile extends RunSummaryFile {
	editAdded: number;
	editRemoved: number;
}

/** Event-fed record of one agent run. */
export interface RunCollector {
	/** The run's first agent_start: begins a fresh record. Pi's in-run continuations must not call it. */
	start(now: number): void;
	toolStart(callId: string, toolName: string, args: unknown, cwd: string): void;
	toolEnd(callId: string, toolName: string, result: unknown, isError: boolean, nested: boolean): void;
	/** turn_start: the model is asked from here until this turn's assistant message ends. */
	turnStart(now: number): void;
	/**
	 * message_update: the stream event it carries. `thinking_start` opens a
	 * thinking interval and `thinking_end` closes it; every other event (each
	 * streamed delta comes through here) is ignored at once.
	 */
	streamEvent(event: unknown, now: number): void;
	/**
	 * message_end: an assistant message closes its turn's model interval (and a
	 * thinking interval its stream left open) and adds its output tokens. Other
	 * roles (user, tool results, custom) are ignored.
	 */
	messageEnd(message: unknown, now: number): void;
	/** turn_end: the run fails when its last assistant message ended in an error. */
	turnEnd(message: unknown): void;
	/** The run's outcome as of now. */
	outcome(aborted: boolean): RunOutcome;
	/**
	 * agent_settled: the record, or undefined when no run was started or it is
	 * not worth a row (no tool call, not interrupted, not failed). Always resets.
	 * `waiting` is the background work still running at this moment, if any; it
	 * changes what the row says, never whether there is one.
	 */
	finish(now: number, aborted: boolean, cost: number, waiting?: BackgroundWork): RunSummaryData | undefined;
	reset(): void;
}

export function createRunCollector(): RunCollector {
	let startedAt: number | undefined;
	let turnStartedAt: number | undefined; // set by turn_start, consumed by that turn's assistant message_end
	let modelMs = 0;
	let modelTurns = 0; // turns whose model interval was measured; 0 = model time unknown
	let thinkingStartedAt: number | undefined; // set by thinking_start, consumed by thinking_end or the message's end
	let thinkingMs = 0;
	let outputTokens = 0;
	let assistantMessages = 0;
	let tokensUnknown = false; // an assistant message without a usable usage.output
	let failed = false;
	let commands = 0;
	let commandsFailed = 0;
	let tools = 0;
	let toolsFailed = 0;
	let untracked = 0; // distinct-path overflow past MAX_TRACKED_FILES
	const pending = new Map<string, PendingCall>();
	const files = new Map<string, TrackedFile>(); // insertion order = first-touched order

	const reset = (): void => {
		startedAt = undefined;
		turnStartedAt = undefined;
		thinkingStartedAt = undefined;
		modelMs = modelTurns = thinkingMs = outputTokens = assistantMessages = 0;
		tokensUnknown = false;
		failed = false;
		commands = commandsFailed = tools = toolsFailed = untracked = 0;
		pending.clear();
		files.clear();
	};

	const touch = (call: PendingCall, nested: boolean): TrackedFile | undefined => {
		if (!call.key || !call.path) return undefined;
		let file = files.get(call.key);
		if (!file) {
			if (files.size >= MAX_TRACKED_FILES) { untracked++; return undefined; }
			file = { path: call.path, kind: "edit", added: 0, removed: 0, lines: 0, script: true, editAdded: 0, editRemoved: 0 };
			files.set(call.key, file);
		}
		if (!nested) file.script = false;
		return file;
	};

	const outcomeOf = (aborted: boolean): RunOutcome => aborted ? "interrupted" : failed ? "failed" : "done";

	const closeThinking = (now: number): void => {
		if (thinkingStartedAt !== undefined && Number.isFinite(now)) thinkingMs += Math.max(0, now - thinkingStartedAt);
		thinkingStartedAt = undefined;
	};

	return {
		start(now) {
			reset();
			startedAt = now;
		},
		toolStart(callId, toolName, args, cwd) {
			if (!callId || pending.has(callId)) return;
			const call: PendingCall = { toolName };
			if (toolName === "edit" || toolName === "write") {
				const record = recordOf(args);
				const path = pathLabel(record.path, cwd).slice(0, MAX_PATH_CHARS);
				if (path && path !== ".") {
					call.path = path;
					call.key = fileKey(path, cwd);
				}
				// Counted now, so a megabyte of content is never retained until the end event.
				if (toolName === "write") call.lines = countLines(textOf(record.content));
			}
			pending.set(callId, call);
			if (pending.size > MAX_PENDING_CALLS) {
				const oldest = pending.keys().next();
				if (!oldest.done) pending.delete(oldest.value);
			}
		},
		toolEnd(callId, toolName, result, isError, nested) {
			const call = pending.get(callId) ?? { toolName };
			pending.delete(callId);
			tools++;
			if (isError) toolsFailed++;
			if (SHELL_TOOLS.has(toolName)) {
				commands++;
				if (isError) commandsFailed++;
			}
			// A failed edit or write changed nothing worth reporting.
			if (isError || call.toolName !== toolName) return;
			if (toolName === "edit") {
				const file = touch(call, nested);
				if (!file) return;
				const counts = patchLineCounts(recordOf(recordOf(result).details).patch);
				file.editAdded += counts.added;
				file.editRemoved += counts.removed;
			} else if (toolName === "write") {
				const file = touch(call, nested);
				if (!file) return;
				file.kind = "write";
				file.lines = call.lines ?? 0;
			}
		},
		turnStart(now) {
			// Outside a run (a turn before the first agent_start seen) there is nothing to add to.
			if (startedAt !== undefined) turnStartedAt = Number.isFinite(now) ? now : undefined;
			// A block left open by a message that never ended is not carried into the next turn.
			thinkingStartedAt = undefined;
		},
		streamEvent(event, now) {
			if (startedAt === undefined) return;
			const type = recordOf(event).type;
			// A second start before an end keeps the first: overlapping blocks count once.
			if (type === "thinking_start") thinkingStartedAt ??= Number.isFinite(now) ? now : undefined;
			else if (type === "thinking_end") closeThinking(now);
		},
		messageEnd(message, now) {
			const record = recordOf(message);
			if (startedAt === undefined || record.role !== "assistant") return;
			// A stream cut off mid-thought sends no thinking_end: its message's end closes the block.
			closeThinking(now);
			// One assistant message per turn: its end closes the interval turn_start opened.
			if (turnStartedAt !== undefined && Number.isFinite(now)) {
				modelMs += Math.max(0, now - turnStartedAt);
				modelTurns++;
			}
			turnStartedAt = undefined;
			assistantMessages++;
			const output = recordOf(record.usage).output;
			if (typeof output === "number" && Number.isFinite(output) && output >= 0) outputTokens += output;
			else tokensUnknown = true;
		},
		turnEnd(message) {
			const record = recordOf(message);
			// A retry that succeeds after an error turn clears it: only the last word counts.
			if (record.role === "assistant") failed = record.stopReason === "error";
		},
		outcome: outcomeOf,
		finish(now, aborted, cost, waiting) {
			const began = startedAt;
			const outcome = outcomeOf(aborted);
			if (began === undefined || (tools === 0 && outcome === "done")) {
				reset();
				return undefined;
			}
			let edited = 0;
			let added = 0;
			let removed = 0;
			let wrote = 0;
			const listed: RunSummaryFile[] = [];
			for (const file of files.values()) {
				const entry: RunSummaryFile = { path: file.path, kind: file.kind, added: 0, removed: 0, lines: 0, script: file.script };
				if (file.kind === "write") {
					wrote++;
					entry.lines = file.lines;
				} else {
					edited++;
					added += file.editAdded;
					removed += file.editRemoved;
					entry.added = file.editAdded;
					entry.removed = file.editRemoved;
				}
				if (listed.length < MAX_SUMMARY_FILES) listed.push(entry);
			}
			const data: RunSummaryData = {
				v: RUN_SUMMARY_VERSION, outcome,
				durationMs: Math.max(0, now - began),
				edited, added, removed, wrote,
				commands, commandsFailed, tools, toolsFailed,
				cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
				files: listed,
				moreFiles: files.size - listed.length + untracked,
			};
			// Optional fields are added only when known, never as a zero or a guess.
			const stillRunning = backgroundWorkOf(waiting);
			if (stillRunning) data.waiting = stillRunning;
			if (modelTurns > 0) data.modelMs = Math.min(modelMs, data.durationMs);
			// Thinking is part of the model time: more than that is a mismeasure, not a figure.
			if (data.modelMs !== undefined && isThinkingTime(thinkingMs, data.modelMs)) data.thinkingMs = thinkingMs;
			const tokens = Math.round(outputTokens);
			if (assistantMessages > 0 && !tokensUnknown && Number.isSafeInteger(tokens)) data.outputTokens = tokens;
			reset();
			return data;
		},
		reset,
	};
}

// ---- the row ---------------------------------------------------------------

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** A thinking time worth a place on the row: a second or more, and no more than the model time it is part of. */
const isThinkingTime = (value: unknown, modelMs: number): value is number => isAmount(value) && value >= 1000 && value <= modelMs;

function parseFile(value: unknown): RunSummaryFile | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const f = value as Record<string, unknown>;
	if (typeof f.path !== "string" || (f.kind !== "edit" && f.kind !== "write") || typeof f.script !== "boolean") return undefined;
	if (!isCount(f.added) || !isCount(f.removed) || !isCount(f.lines)) return undefined;
	const path = sanitizeInlineText(f.path.slice(0, MAX_PATH_CHARS));
	if (!path) return undefined;
	return { path, kind: f.kind, added: f.added, removed: f.removed, lines: f.lines, script: f.script };
}

/** The entry as written by this version, or undefined for anything malformed or foreign. */
export function parseRunSummary(value: unknown): RunSummaryData | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const d = value as Record<string, unknown>;
	if (d.v !== RUN_SUMMARY_VERSION) return undefined;
	if (d.outcome !== "done" && d.outcome !== "interrupted" && d.outcome !== "failed") return undefined;
	if (!isAmount(d.durationMs) || !isAmount(d.cost)) return undefined;
	for (const key of ["edited", "added", "removed", "wrote", "commands", "commandsFailed", "tools", "toolsFailed", "moreFiles"]) {
		if (!isCount(d[key])) return undefined;
	}
	if (!Array.isArray(d.files) || d.files.length > MAX_SUMMARY_FILES) return undefined;
	const files: RunSummaryFile[] = [];
	for (const item of d.files) {
		const file = parseFile(item);
		if (!file) return undefined;
		files.push(file);
	}
	const data: RunSummaryData = {
		v: RUN_SUMMARY_VERSION, outcome: d.outcome, durationMs: d.durationMs, cost: d.cost,
		edited: d.edited as number, added: d.added as number, removed: d.removed as number, wrote: d.wrote as number,
		commands: d.commands as number, commandsFailed: d.commandsFailed as number,
		tools: d.tools as number, toolsFailed: d.toolsFailed as number,
		files, moreFiles: d.moreFiles as number,
	};
	// Optional fields: absent in older entries, and a malformed one is dropped
	// on its own, so the rest of the row still renders as it always did.
	const waiting = backgroundWorkOf(d.waiting);
	if (waiting) data.waiting = waiting;
	// Model time cannot exceed the run it is part of; one that does is not ours.
	if (isAmount(d.modelMs) && d.modelMs <= d.durationMs) data.modelMs = d.modelMs;
	// Thinking time is read only beside the model time it is a part of.
	if (data.modelMs !== undefined && isThinkingTime(d.thinkingMs, data.modelMs)) data.thinkingMs = d.thinkingMs;
	if (isCount(d.outputTokens)) data.outputTokens = d.outputTokens;
	return data;
}

/** The status row's run delta, spelled as the `~$` estimate it is: cents, nothing below one. */
export function formatRunCost(cost: number): string {
	if (!Number.isFinite(cost)) return "";
	const cents = Math.round(cost * 100);
	return cents >= 1 ? `~$${(cents / 100).toFixed(2)}` : "";
}

type Span = readonly [ThemeColor, string];

const OUTCOME_DOT: Record<RunOutcome, ThemeColor> = { done: "success", interrupted: "warning", failed: "error" };
const OUTCOME_WORD: Record<RunOutcome, string> = { done: "Done", interrupted: "Interrupted", failed: "Failed" };
const OUTCOME_LINK: Record<RunOutcome, string> = { done: "in", interrupted: "after", failed: "after" };

/**
 * A run that settled cleanly while background work was still running has not
 * finished the job: its turn ended. The dot recedes with it, so the row never
 * reads as a success it cannot vouch for. Interrupted and failed keep theirs.
 */
const PENDING_DOT: ThemeColor = "muted";
const PENDING_WORD = "Turn ended";

/** What a collapsed spelling keeps, from widest to narrowest. */
interface Shape {
	calls?: "total" | "failed";
	cost?: boolean;
	/** The background work still running: every kind, or the one compact count. */
	waiting?: "detail" | "compact";
	wrote?: boolean;
	counts?: boolean;
	edited?: boolean;
	duration?: boolean;
	word?: boolean;
}

/**
 * The narrowing ladder, as whole spellings. Each step drops one part: the
 * expand hint when there is one (see summarySpellings), the per-kind breakdown
 * of what is awaited (down to one count), the command (or tool-call) total
 * keeping its failures, the cost, "wrote …", the +/− counts, then the
 * failures, "edited …", the waiting clause, and then everything after the
 * outcome; the last two rungs keep even an 8-column row from ever clipping a
 * part. The waiting clause outlasts the cost and every detail of the work:
 * that something is still running matters more than what the turn itself did.
 * A row with nothing awaited spells the same forms it always has (rungs that
 * differ only in the clause collapse into one).
 */
const LADDER: readonly Shape[] = [
	{ calls: "total", cost: true, waiting: "detail", wrote: true, counts: true, edited: true, duration: true, word: true },
	{ calls: "total", cost: true, waiting: "compact", wrote: true, counts: true, edited: true, duration: true, word: true },
	{ calls: "failed", cost: true, waiting: "compact", wrote: true, counts: true, edited: true, duration: true, word: true },
	{ calls: "failed", waiting: "compact", wrote: true, counts: true, edited: true, duration: true, word: true },
	{ calls: "failed", waiting: "compact", counts: true, edited: true, duration: true, word: true },
	{ calls: "failed", waiting: "compact", edited: true, duration: true, word: true },
	{ waiting: "compact", edited: true, duration: true, word: true },
	{ waiting: "compact", duration: true, word: true },
	{ duration: true, word: true },
	{ word: true },
	{},
];

function headline(data: RunSummaryData, shape: Shape): Span[][] {
	const parts: Span[][] = [];
	const duration = formatDuration(data.durationMs);
	const pending = data.outcome === "done" && data.waiting !== undefined;
	const word = pending ? PENDING_WORD : OUTCOME_WORD[data.outcome];
	const head: Span[] = [[pending ? PENDING_DOT : OUTCOME_DOT[data.outcome], "●"]];
	if (shape.word) {
		const words = shape.duration && duration ? `${word} ${OUTCOME_LINK[data.outcome]} ${duration}` : word;
		head.push(["muted", ` ${words}`]);
	}
	parts.push(head);
	if (shape.edited && data.edited) {
		const edited: Span[] = [["dim", `edited ${plural(data.edited, "file")}`]];
		if (shape.counts && (data.added || data.removed)) edited.push(["toolDiffAdded", ` +${data.added}`], ["toolDiffRemoved", ` −${data.removed}`]);
		parts.push(edited);
	}
	if (shape.wrote && data.wrote) parts.push([["dim", `wrote ${plural(data.wrote, "file")}`]]);
	// "N tool calls" stands in only when nothing more specific was done.
	const commandsOnly = data.commands > 0;
	const generic = !commandsOnly && !data.edited && !data.wrote;
	const total = commandsOnly ? data.commands : generic ? data.tools : 0;
	const failures = commandsOnly ? data.commandsFailed : generic ? data.toolsFailed : 0;
	// A failed read or edit beside the commands (or with no command at all) is a
	// failure of the run too: the row must not read as clean when a call failed.
	const otherFailures = generic ? 0 : Math.max(0, data.toolsFailed - (commandsOnly ? data.commandsFailed : 0));
	if (shape.calls === "total") {
		if (total) {
			const calls: Span[] = [["dim", commandsOnly ? plural(total, "command") : plural(total, "tool call")]];
			if (failures) calls.push(["dim", ", "], ["error", `${failures} failed`]);
			parts.push(calls);
		}
		// Standing alone a failure count names what failed: "· 1 failed" after
		// "edited 1 file" would read as a failed file.
		if (otherFailures) parts.push([["error", commandsOnly ? `${otherFailures} other failed` : `${plural(otherFailures, "call")} failed`]]);
	} else if (shape.calls === "failed" && failures + otherFailures) {
		// The total is gone, so the count carries its own noun: commands when
		// only commands failed, calls otherwise (a failed read beside them).
		const noun = commandsOnly && otherFailures === 0 ? "command" : "call";
		parts.push([["error", `${plural(failures + otherFailures, noun)} failed`]]);
	}
	const cost = shape.cost ? formatRunCost(data.cost) : "";
	if (cost) parts.push([["muted", cost]]);
	// Last, where the eye lands: what the turn left running. Counts only; the
	// status text they were parsed from is never printed.
	if (shape.waiting && data.waiting) {
		const detail = backgroundDetail(data.waiting);
		const compact = backgroundSummary(data.waiting);
		// The one count stands in only where it is actually shorter: "1 agent, 1
		// timer" already is the narrower way to say "2 background tasks".
		parts.push([["muted", `waiting on ${shape.waiting === "detail" || detail.length <= compact.length ? detail : compact}`]]);
	}
	return parts;
}

/**
 * Where the run's time went, for the expanded row: "model 1m 32s (40s
 * thinking) · tools 42s · 48 tok/s", widest first, narrowing by dropping the
 * rate, then the thinking time, then the tools time. Nothing when the model
 * time is unknown. `tools` is everything in the run that was not waiting on
 * the model (wall time − model time, so it also holds retries' back-off,
 * compaction and prompts), shown from one second up; the rate is output tokens
 * ÷ model time, a whole number, shown only when the model time is at least a
 * second and it rounds to at least one. Thinking is a part of the model time,
 * so it stands in parentheses after it, never as a term of its own: the terms
 * of the line add up to the run.
 */
export function timingSpellings(data: RunSummaryData): string[] {
	if (data.modelMs === undefined) return [];
	const model = formatDuration(data.modelMs);
	if (!model) return [];
	const toolsMs = Math.max(0, data.durationMs - data.modelMs);
	const tools = toolsMs >= 1000 ? ` · tools ${formatDuration(toolsMs)}` : "";
	const rate = data.outputTokens !== undefined && data.outputTokens > 0 && data.modelMs >= 1000
		? Math.round(data.outputTokens / (data.modelMs / 1000)) : 0;
	const base = `model ${model}`;
	const thought = isThinkingTime(data.thinkingMs, data.modelMs) ? `${base} (${formatDuration(data.thinkingMs)} thinking)` : base;
	const out = [`${thought}${tools}${rate >= 1 ? ` · ${rate} tok/s` : ""}`, thought + tools, base + tools, base];
	return out.filter((spelling, index) => spelling !== out[index - 1]);
}

function spell(parts: Span[][], theme: Theme): { plain: string; painted: string } {
	let plain = "";
	let painted = "";
	parts.forEach((part, index) => {
		if (index > 0) {
			plain += " · ";
			painted += theme.fg("dim", " · ");
		}
		for (const [color, text] of part) {
			plain += text;
			painted += theme.fg(color, text);
		}
	});
	return { plain, painted };
}

/**
 * The collapsed row's spellings, widest first, without duplicates. A `hint`
 * (already sanitized) tops the ladder as the widest form plus ` (hint)` in dim,
 * the way tool rows end, so it is the first thing a narrower row drops.
 */
export function summarySpellings(data: RunSummaryData, theme: Theme, hint = ""): { plain: string; painted: string }[] {
	const out: { plain: string; painted: string }[] = [];
	for (const shape of LADDER) {
		const spelled = spell(headline(data, shape), theme);
		if (out.at(-1)?.plain !== spelled.plain) out.push(spelled);
	}
	if (hint) out.unshift({ plain: `${out[0]!.plain} (${hint})`, painted: out[0]!.painted + theme.fg("dim", ` (${hint})`) });
	return out;
}

function fileSpellings(file: RunSummaryFile, theme: Theme): string[] {
	const path = theme.fg("muted", `  ${file.path}`);
	const detail = file.kind === "write"
		? theme.fg("dim", ` wrote ${plural(file.lines, "line")}`)
		: theme.fg("toolDiffAdded", ` +${file.added}`) + theme.fg("toolDiffRemoved", ` −${file.removed}`);
	const script = file.script ? theme.fg("dim", " (script)") : "";
	return [...(script ? [path + detail + script] : []), path + detail, path];
}

function summaryRows(data: RunSummaryData, theme: Theme, expanded: boolean, expandHint?: () => string): ViewRow[] {
	// Only a row that expanding would change says so, and only while collapsed.
	const expandable = !expanded && !!expandHint && (data.files.length > 0 || data.moreFiles > 0);
	const hint = expandable ? sanitizeInlineText(textOf(expandHint!())) || "expand" : "";
	const spellings = summarySpellings(data, theme, hint);
	const rows: ViewRow[] = [{ text: spellings.at(-1)!.plain, color: "dim", painted: spellings.map(s => s.painted) }];
	if (!expanded) return rows;
	// One dim line under the headline, above the files: expanded only, so the
	// collapsed row (and whether it carries a hint) is exactly what it was.
	// The last, empty rung keeps it whole or absent: a row too narrow for
	// "model 1m 32s" shows no timing at all, never a number cut mid-digit.
	const timing = timingSpellings(data);
	if (timing.length) rows.push({ text: timing.at(-1)!, color: "dim", painted: [...timing.map(spelling => theme.fg("dim", `  ${spelling}`)), ""] });
	for (const file of data.files) rows.push({ text: file.path, color: "muted", painted: fileSpellings(file, theme) });
	if (data.moreFiles) rows.push({ text: `  … ${data.moreFiles} more`, color: "dim" });
	return rows;
}

/**
 * The transcript row for one entry: one line collapsed; expanded, the timing
 * line (when the entry has one) and a row per file under it. Built on the tool rows' view (indent, width cache, never wraps,
 * never wider than the terminal). Undefined for malformed or foreign data.
 * Pi's entry renderer passes no outputPad, so the transcript's one-cell indent
 * is the default. `expandHint` is the host's key hint, as tool rows receive it
 * (index.ts injects it; this module stays free of runtime Pi imports).
 */
export function createRunSummaryRow(value: unknown, expanded: boolean, theme: Theme, outputPad = 1, expandHint?: () => string): Component | undefined {
	const data = parseRunSummary(value);
	if (!data) return undefined;
	return view(theme, { outputPad }, () => summaryRows(data, theme, expanded, expandHint));
}
