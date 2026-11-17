/**
 * Pure registry that folds runs of consecutive exploration calls.
 *
 * The host fixes one `ToolExecutionComponent` per call into a transcript container
 * no extension can see, but a `renderShell: "self"` renderer can render zero lines
 * (the row disappears) or one summary line instead of its view. This module owns
 * the ONLY state that decides which, derived from the same documented
 * `tool_execution_*` events the host builds rows from and closed by any message
 * that paints a transcript row. No host prototypes are patched; the adapter asks
 * `decisionFor` at render time and the host's per-frame re-render applies
 * transitions for free.
 *
 * Folding is presentation of the transcript itself — it suppresses neither
 * `notify()`, status indicators, widgets, nor any other Pi channel. A run folds
 * as soon as it holds MIN_FOLD settled calls, and keeps folding while it is
 * open: hidden rows take no lines, so the tally stays where it is and counts up
 * as each later call settles into it. A row is never hidden unless another row
 * of its run renders the tally. Calls still running, failed calls and
 * image-bearing calls keep their own rows (the host paints images outside our
 * shell), and Ctrl+O still expands every row.
 */
import { isFoldableTool, tallyDetails, tallyName, tallySentence, tallySubject } from "./tool-lexicon.ts";

export type GroupDecision =
	| { readonly kind: "normal" }
	| { readonly kind: "hidden" }
	/** `sentence` counts ("Read 3 files"); `detailed` names the files when the row has room for it. */
	| { readonly kind: "summary"; readonly sentence: string; readonly detailed: string };

/** What a row adapter consumes. Row-local state (expanded, partial) is the adapter's business, not the registry's. */
export interface GroupControl {
	decisionFor(callId: string): GroupDecision;
	/** A click on the summary or on any member row: the run's rows return for good (one-way; Ctrl+O still expands everything). */
	expand(callId: string): void;
	/** The host paints a result's images outside our shell, so a call carrying one never folds. */
	markImages(callId: string): void;
	/**
	 * The call's row has its final result. Rows settle their own calls: Pi tells
	 * extensions a tool ended before it updates the row, so an event-fed registry
	 * would hide a run's rows while the row meant to carry the tally still
	 * rendered as running.
	 */
	settle(callId: string, failed: boolean): void;
}

export interface ToolStartDetails {
	/** With `cwd`, name what the call is about, so the tally counts distinct files and patterns. */
	readonly args?: unknown;
	readonly cwd?: string;
	/** This package's adapter renders that tool's rows (default true). */
	readonly rendersHere?: boolean;
}

export interface ToolRunRegistry extends GroupControl {
	onToolStart(callId: string, toolName: string, details?: ToolStartDetails): void;
	/** Closes the open run when the message paints transcript rows. */
	onMessage(message: unknown): void;
	closeAll(): void;
	reset(): void;
}

/** Fewer calls than this read fine as rows; a tally only pays for itself on longer runs. */
export const MIN_FOLD = 3;

// Singletons: decisionFor runs for every row on every frame and must not allocate.
const NORMAL: GroupDecision = Object.freeze({ kind: "normal" });
const HIDDEN: GroupDecision = Object.freeze({ kind: "hidden" });

/**
 * Whether the host paints a transcript row for this message — and so whether it
 * sits between two tool rows and must break their run. Tool results belong to
 * the rows themselves. An assistant message paints text, a "∴ thinking" row (this
 * extension always sets a hidden-thinking label) and, when the turn ended badly,
 * an error line; a toolCall-only message paints nothing. Other roles paint unless
 * they opt out with `display: false`.
 */
export function messagePaintsRows(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const m = message as { role?: unknown; content?: unknown; stopReason?: unknown; display?: unknown };
	if (m.role === "toolResult") return false;
	if (m.role !== "assistant") return m.display !== false;
	if (m.stopReason === "length" || m.stopReason === "error" || m.stopReason === "aborted") return true;
	if (typeof m.content === "string") return m.content.trim().length > 0;
	if (!Array.isArray(m.content)) return false;
	return m.content.some(block => {
		if (typeof block !== "object" || block === null) return false;
		const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
		const text = b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : undefined;
		return typeof text === "string" && text.trim().length > 0;
	});
}

interface RunCall {
	readonly id: string;
	readonly name: string;
	readonly subject: string;
	readonly display: string;
	ended: boolean;
	failed: boolean;
	images: boolean;
}

interface Run {
	readonly calls: RunCall[];
	expanded: boolean;
	/** The fold, computed once per mutation; undefined = stale. */
	fold?: Map<RunCall, GroupDecision>;
}

const foldable = (call: RunCall): boolean => call.ended && !call.failed && !call.images;

function computeFold(run: Run): Map<RunCall, GroupDecision> {
	const fold = new Map<RunCall, GroupDecision>();
	if (run.expanded) return fold;
	const members = run.calls.filter(foldable);
	if (members.length < MIN_FOLD) return fold;
	const sentence = tallySentence(members);
	const detailed = tallyDetails(members);
	// The carrier is the last foldable call: the rows before it take no lines, so
	// as an open run grows the tally stays put and the newest settled call takes
	// it over in place — and it sits where the run ended even when a failed call
	// trails it.
	for (const call of members) fold.set(call, HIDDEN);
	fold.set(members[members.length - 1]!, { kind: "summary", sentence, detailed });
	return fold;
}

export function createToolRunRegistry(): ToolRunRegistry {
	let openRun: Run | undefined;
	const byCall = new Map<string, { run: Run; call: RunCall }>();

	const close = (): void => {
		const run = openRun;
		if (!run) return;
		openRun = undefined;
		// A run that can never fold needs no memory: keep only runs that matter.
		if (run.calls.length < MIN_FOLD) for (const call of run.calls) byCall.delete(call.id);
	};

	return {
		onToolStart(callId, toolName, { args, cwd, rendersHere = true } = {}) {
			if (!callId || byCall.has(callId)) return;
			// bash (side effects), edit, write, delegate, custom tools and rows another
			// renderer owns all break the run and stay untracked themselves.
			if (!rendersHere || !isFoldableTool(toolName)) {
				close();
				return;
			}
			openRun ??= { calls: [], expanded: false };
			const call: RunCall = { id: callId, name: toolName, subject: tallySubject(toolName, args, cwd),
				display: tallyName(toolName, args, cwd), ended: false, failed: false, images: false };
			openRun.calls.push(call);
			openRun.fold = undefined;
			byCall.set(callId, { run: openRun, call });
		},
		settle(callId, failed) {
			const entry = byCall.get(callId);
			if (!entry || entry.call.ended) return;
			entry.call.ended = true;
			entry.call.failed = failed;
			entry.run.fold = undefined;
		},
		onMessage(message) {
			// Called on every streaming delta: bail before inspecting the message.
			if (openRun && messagePaintsRows(message)) close();
		},
		closeAll: close,
		reset() {
			openRun = undefined;
			byCall.clear();
		},
		expand(callId) {
			const entry = byCall.get(callId);
			if (!entry || entry.run.expanded) return;
			entry.run.expanded = true;
			entry.run.fold = undefined;
		},
		markImages(callId) {
			const entry = byCall.get(callId);
			if (!entry || entry.call.images) return;
			entry.call.images = true;
			entry.run.fold = undefined;
		},
		decisionFor(callId) {
			const entry = byCall.get(callId);
			if (!entry) return NORMAL;
			const run = entry.run;
			run.fold ??= computeFold(run);
			return run.fold.get(entry.call) ?? NORMAL;
		},
	};
}
