/**
 * Pure activity tracking for the status row's transient "what is pi doing" label.
 *
 * Fed by Pi's `tool_execution_start`/`end` events (the wiring skips nested
 * `parentToolCallId` calls, which the host never renders as rows). Time is
 * injected, so this module starts no timer: the label is revealed by the frame's
 * existing spinner repaint once a call has outlived ACTIVITY_GRACE_MS, which
 * keeps fast calls (a 5 ms read) from flashing for a single frame. Labels are
 * model-controlled text: every fragment passes the bounded sanitizer here, and
 * editor.ts sanitizes again before the frame sees it.
 *
 * There is deliberately no `delegate` special case: pi-persona launches
 * interactive delegate/council/flow work in the background and the call returns
 * within milliseconds, so the grace period keeps it out of the label and a
 * "Waiting for agent" verb would be false. pi-persona's own widget and
 * messages carry that signal.
 *
 * The same slot has a second, quieter tenant: the run clock ("Working… 45s"),
 * for the stretches of a run no call is named in. It follows the same rules —
 * injected time, no timer, revealed by the spinner's repaint.
 */

import { recordOf, sanitizeInlineText, textOf } from "./format.ts";
import { toolWords } from "./tool-lexicon.ts";

/** A running call worth naming, ready for the status row. */
export interface Activity {
	/** Sanitized, one line, ends with "…": "Running npm test…". */
	readonly label: string;
	/** Other top-level calls still running beside it. */
	readonly more: number;
	/** How long the named call has run: `now` − its own start, from the injected clock. */
	readonly elapsedMs: number;
	/**
	 * Set only on the run clock's entry (see createRunClock): the label names no
	 * call, `elapsedMs` is the run's own age, and the row shows it whole or not
	 * at all. Absent on a named tool call.
	 */
	readonly run?: true;
}

/** A call must run this long before it is named; shorter calls never flash. */
export const ACTIVITY_GRACE_MS = 500;

/** Upper bound on concurrently tracked calls; a runaway fan-out (or lost end events) cannot grow the map forever. */
const MAX_TRACKED = 64;

/**
 * Characters of a foreign argument inspected at all. The label is one short row,
 * so a multi-megabyte command is never split, matched or sanitized whole.
 */
const SCAN_LIMIT = 4096;

/** Bound a foreign string before any scan, without leaving a split surrogate pair. */
function bounded(value: unknown): string {
	const text = textOf(value);
	if (text.length <= SCAN_LIMIT) return text;
	const cut = text.slice(0, SCAN_LIMIT);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** `cd <path> &&` / `cd <path>;` — navigation noise in front of the real command. */
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;

/** First meaningful command line: blank and `#` comment lines skipped, a leading `cd` dropped. */
function commandTarget(command: unknown): string {
	for (const raw of bounded(command).split("\n")) {
		// Judge the line as it would display: a row of bare controls is as blank as whitespace.
		const line = sanitizeInlineText(raw);
		if (!line || line.startsWith("#")) continue;
		const rest = line.replace(CD_PREFIX, "");
		return rest.trim() ? rest : line;
	}
	return "";
}

/** Last path segment, in either slash direction. */
function basename(path: unknown): string {
	return bounded(path).replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "";
}

/** Pattern in the transcript rows' curly quotes; nothing when it sanitizes away. */
function quoted(pattern: unknown): string {
	const safe = sanitizeInlineText(bounded(pattern));
	return safe ? `“${safe}”` : "";
}

function targetOf(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return commandTarget(args.command);
		case "read":
		case "edit":
		case "write":
			return basename(args.path);
		case "ls": {
			const name = basename(args.path);
			return name === "." ? "" : name;
		}
		case "grep":
		case "find":
			return quoted(args.pattern);
		default:
			return "";
	}
}

/**
 * One-line, present-progressive description of a running call, ending in a
 * single "…": "Running npm test…", "Reading width.ts…", "Searching “TODO”…".
 * Targets derive only from the call's own arguments.
 */
export function describeToolActivity(toolName: string, args: unknown): string {
	const words = toolWords(toolName);
	let composed: string;
	if (words) {
		const target = sanitizeInlineText(targetOf(toolName, recordOf(args)));
		composed = target ? `${words.doing} ${target}` : words.doing;
	} else {
		const name = sanitizeInlineText(bounded(toolName));
		composed = name ? `Running ${name}` : "Working";
	}
	// "echo waiting..." must not end in "...…": the visual ellipsis is ours alone.
	return `${composed.replace(/[\s.…]+$/u, "")}…`;
}

/** Event-fed view of the currently running top-level tool calls. */
export interface ActivityTracker {
	onStart(callId: string, toolName: string, args: unknown, now: number): void;
	onEnd(callId: string): void;
	clear(): void;
	/** The longest-running call once it has run for ACTIVITY_GRACE_MS; undefined before that. */
	current(now: number): Activity | undefined;
}

export function createActivityTracker(): ActivityTracker {
	// Insertion order = start order. The oldest call leads and changes only when it
	// ends, so a parallel batch starting and finishing beside it never moves the label.
	const running = new Map<string, { label: string; startedAt: number }>();
	return {
		onStart(callId, toolName, args, now) {
			if (!callId || running.has(callId)) return;
			running.set(callId, { label: describeToolActivity(toolName, args), startedAt: now });
			// Evict the oldest: an entry whose end event was lost must not pin the
			// label (or block every later call) for the rest of the run.
			if (running.size > MAX_TRACKED) {
				const oldest = running.keys().next();
				if (!oldest.done) running.delete(oldest.value);
			}
		},
		onEnd(callId) {
			running.delete(callId);
		},
		clear() {
			running.clear();
		},
		current(now) {
			const first = running.values().next();
			const elapsedMs = first.done ? 0 : now - first.value.startedAt;
			if (first.done || elapsedMs < ACTIVITY_GRACE_MS) return undefined;
			return { label: first.value.label, more: running.size - 1, elapsedMs };
		},
	};
}

/** A run must last this long before its clock shows; a quick reply never grows a counter. */
export const RUN_CLOCK_GRACE_MS = 3000;
/** What the slot says while Pi thinks or streams and no call is named. Ours, not foreign text. */
export const RUN_CLOCK_LABEL = "Working…";

/**
 * How long the current run has lasted, for the stretches no tool is named in:
 * thinking, streaming, the gap between two calls. Like the tracker it holds one
 * number and starts no timer; the spinner's repaint reads it against the
 * injected clock.
 */
export interface RunClock {
	/**
	 * The run's first agent_start. Pi's in-run continuations (a retry, a mid-run
	 * compaction, a drained follow-up) must not call it: the clock is the run's.
	 */
	start(now: number): void;
	/** agent_settled, a new session, or a run that has no start to measure from. */
	stop(): void;
	/** `Working…` with the run's age once it has lasted RUN_CLOCK_GRACE_MS; undefined before, and when stopped. */
	current(now: number): Activity | undefined;
}

export function createRunClock(): RunClock {
	let startedAt: number | undefined;
	return {
		start(now) {
			startedAt = Number.isFinite(now) ? now : undefined;
		},
		stop() {
			startedAt = undefined;
		},
		current(now) {
			if (startedAt === undefined) return undefined;
			const elapsedMs = now - startedAt;
			// A clock that stepped backwards (or NaN) shows nothing rather than a wrong time.
			if (!(elapsedMs >= RUN_CLOCK_GRACE_MS)) return undefined;
			return { label: RUN_CLOCK_LABEL, more: 0, elapsedMs, run: true };
		},
	};
}

/**
 * What the status row's slot shows now: a named call once it has outlived its
 * own grace period, else the run clock. A call still inside its grace period
 * does not blank the slot, so a burst of fast calls never makes the clock flicker.
 */
export function currentActivity(tracker: ActivityTracker, clock: RunClock | undefined, now: number): Activity | undefined {
	return tracker.current(now) ?? clock?.current(now);
}
