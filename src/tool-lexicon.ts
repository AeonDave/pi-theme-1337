/**
 * The one vocabulary for Pi's built-in tools. Transcript rows, the status row's
 * activity label and folded-run tallies all take their words from here, so a
 * tool is named the same way wherever it shows up: imperative on its row
 * ("Read src/width.ts"), progressive while it runs ("Reading width.ts…"), past
 * tense in a tally ("Read 3 files, searched 2 patterns").
 *
 * Data only: extracting the target (path, pattern, command) stays with the
 * module that renders it. Lookups go through a Map because tool names are
 * model-controlled — a plain-object lookup would resolve "constructor".
 */

import { recordOf, sanitizeInlineText, textOf } from "./format.ts";

/** One clause of a folded-run tally: "read 3 files". */
export interface ToolTally {
	readonly verb: string;
	readonly one: string;
	readonly many: string;
	/** The argument naming what the clause counts: paging one file three times is still one file. */
	readonly subject: "path" | "pattern";
	/** The tool acts on the working directory when the argument is absent (`ls`). */
	readonly cwdWhenAbsent?: true;
}

/** A call as a tally sees it. */
export interface TalliedCall {
	readonly name: string;
	/** From `tallySubject`; calls without one each count on their own. */
	readonly subject?: string;
	/** From `tallyName`: how the detailed tally names the subject. Raw text, sanitized where painted. */
	readonly display?: string;
}

export interface ToolWords {
	/** Row heading verb: "Read src/width.ts". */
	readonly title: string;
	/** Status-row verb while the call runs: "Reading width.ts…". */
	readonly doing: string;
	/** A settled, successful call shows its header only (with what it found); its output waits behind expand. */
	readonly quiet?: true;
	/**
	 * Read-only exploration that may fold into a run tally. Tools that share a
	 * clause share the object, so grep and find count as one "searched N patterns".
	 */
	readonly tally?: ToolTally;
}

const SEARCHED: ToolTally = { verb: "searched", one: "pattern", many: "patterns", subject: "pattern" };

const WORDS: ReadonlyMap<string, ToolWords> = new Map<string, ToolWords>([
	["bash", { title: "$", doing: "Running", quiet: true }],
	["read", { title: "Read", doing: "Reading", quiet: true, tally: { verb: "read", one: "file", many: "files", subject: "path" } }],
	["grep", { title: "Search", doing: "Searching", quiet: true, tally: SEARCHED }],
	["find", { title: "Find", doing: "Finding", quiet: true, tally: SEARCHED }],
	["ls", { title: "List", doing: "Listing", quiet: true, tally: { verb: "listed", one: "folder", many: "folders", subject: "path", cwdWhenAbsent: true } }],
	["edit", { title: "Update", doing: "Updating" }],
	["write", { title: "Write", doing: "Writing" }],
]);

/** Words for a built-in tool; undefined for extension, MCP and unknown tools. */
export function toolWords(name: string): ToolWords | undefined {
	return WORDS.get(name);
}

/** Built-in tools whose transcript rows this package restyles. */
export function isPolishedTool(name: string): boolean {
	return WORDS.has(name);
}

/** Exploration tools whose settled rows may fold into one tally row. */
export function isFoldableTool(name: string): boolean {
	return WORDS.get(name)?.tally !== undefined;
}

/** Longest subject kept per call; the registry holds one for every folded row of a session. */
const SUBJECT_LIMIT = 512;

/**
 * A path as a comparison key: the spellings Pi's file tools treat as one target
 * — `a.ts`, `./a.ts`, `@a.ts`, `src/../a.ts`, the absolute path under `cwd`,
 * either slash — give one key.
 * Drive-letter paths compare case-insensitively, as their filesystem does.
 * (`~` is left alone: expanding it needs the environment.)
 */
function pathKey(path: string, cwd: string): string {
	const key = pathSegments(path, cwd).join("/");
	return /^[a-z]:/i.test(key) ? key.toLowerCase() : key;
}

/** The resolved segments of `path` under `cwd`, spelled as given (no case folding). */
function pathSegments(path: string, cwd: string): string[] {
	const unified = path.replaceAll("\\", "/").replace(/^@/, "");
	const absolute = unified.startsWith("/") || /^[a-z]:\//i.test(unified);
	const segments: string[] = [];
	for (const segment of `${absolute ? "" : `${cwd.replaceAll("\\", "/")}/`}${unified}`.split("/")) {
		if (segment === "..") segments.pop();
		else if (segment && segment !== ".") segments.push(segment);
	}
	return segments;
}

/** Longest name kept per call: a basename longer than any row is shown only as a count anyway. */
const NAME_LIMIT = 128;

/**
 * How a detailed tally names a path call: the basename as the model spelled it
 * (`src/../A.ts` → `A.ts`; an absent `ls` path → the cwd's own name). "" for
 * pattern clauses, other tools, and a path that resolves to no name (`/`).
 */
export function tallyName(name: string, args: unknown, cwd = ""): string {
	const tally = WORDS.get(name)?.tally;
	if (tally?.subject !== "path") return "";
	const value = textOf(recordOf(args).path).slice(0, SUBJECT_LIMIT);
	if (!value && !tally.cwdWhenAbsent) return "";
	// Sanitized here too, so a name of nothing but controls is no name rather than a gap in the list.
	const base = pathSegments(value || ".", cwd).at(-1) ?? "";
	// A name that would be cut, or that contains the list's own separators, cannot
	// be listed truthfully: no name, and the clause falls back to its count.
	if (base.length > NAME_LIMIT) return "";
	const shown = sanitizeInlineText(base);
	return shown.includes(", ") || shown.includes(" · ") ? "" : shown;
}

/**
 * What a foldable call is about — the path it reads or lists, the pattern it
 * searches — as a bounded comparison key. "" for other tools and for a call
 * that names nothing (each such call then counts on its own).
 */
export function tallySubject(name: string, args: unknown, cwd = ""): string {
	const tally = WORDS.get(name)?.tally;
	if (!tally) return "";
	const value = textOf(recordOf(args)[tally.subject]).slice(0, SUBJECT_LIMIT);
	if (tally.subject !== "path") return value;
	if (!value && !tally.cwdWhenAbsent) return "";
	return pathKey(value || ".", cwd) || ".";
}

/**
 * Sentence for a run of exploration calls, clauses in first-appearance order,
 * each counting distinct subjects: two reads of `a.ts`, one of `b.ts`, a grep
 * and a find → "Read 2 files, searched 2 patterns". Calls without a tally
 * clause are ignored; no clauses yields "".
 */
export function tallySentence(calls: Iterable<TalliedCall>): string {
	return capitalize(Array.from(tallyClauses(calls), counted).join(", "));
}

/**
 * The same run naming its files: each path clause lists its distinct subjects
 * by first-appearance display name, search clauses stay counted, clauses join
 * with " · " — "Read width.ts, frame.ts · searched 2 patterns · listed src".
 * A path clause with a call that has no subject or no name stays counted: a
 * list that silently left one out would read as the whole run. So does one
 * where two files share a basename (`a/index.ts`, `b/index.ts`): "index.ts,
 * index.ts" reads as one file listed twice.
 */
export function tallyDetails(calls: Iterable<TalliedCall>): string {
	const clauses = Array.from(tallyClauses(calls));
	const sentence = capitalize(clauses.map(counted).join(", "));
	let listed = false;
	const detailed = capitalize(clauses.map(clause => {
		const names = Array.from(clause.subjects.values());
		if (clause.tally.subject !== "path" || clause.unnamed || !names.every(Boolean) || new Set(names).size !== names.length) return counted(clause);
		listed = true;
		return `${clause.tally.verb} ${names.join(", ")}`;
	}).join(" · "));
	// Nothing to name is the counted sentence itself. Past the limit no row is that
	// wide: the list could only be cut, and a cut list reads as the whole run.
	return listed && detailed.length <= DETAILS_LIMIT ? detailed : sentence;
}

const DETAILS_LIMIT = 256;

interface Clause {
	readonly tally: ToolTally;
	/** Distinct subject key → display name of its first call ("" when it had none). */
	readonly subjects: Map<string, string>;
	unnamed: number;
}

function tallyClauses(calls: Iterable<TalliedCall>): Iterable<Clause> {
	const clauses = new Map<ToolTally, Clause>();
	for (const call of calls) {
		const tally = WORDS.get(call.name)?.tally;
		if (!tally) continue;
		let clause = clauses.get(tally);
		if (!clause) clauses.set(tally, clause = { tally, subjects: new Map(), unnamed: 0 });
		if (!call.subject) clause.unnamed++;
		else if (!clause.subjects.has(call.subject)) clause.subjects.set(call.subject, call.display ?? "");
	}
	return clauses.values();
}

function counted({ tally, subjects, unnamed }: Clause): string {
	const count = subjects.size + unnamed;
	return `${tally.verb} ${count} ${count === 1 ? tally.one : tally.many}`;
}

const capitalize = (sentence: string): string => sentence.charAt(0).toUpperCase() + sentence.slice(1);
