/**
 * Pure terminal-title text. The state leads, because tabs truncate the end;
 * the place follows: the session name when there is one, else the cwd
 * basename, the same pieces Pi puts in its own title.
 *
 * A title is foreign text going to the terminal (session names come from
 * session files, labels from model arguments): every piece is sanitized and
 * bounded here. Pi's own `setTitle` also strips controls; this keeps the text
 * one short, printable line before it gets there.
 */
import { backgroundSummary, sanitizeInlineText, type BackgroundWork } from "./format.ts";

/** Pi's APP_TITLE for a stock install. Not exported by the host; a renamed (`piConfig.name`) build differs. */
export const PI_TITLE = "π";
/** Characters kept from any one piece: long enough for any real name, short enough for a tab. */
const PIECE_LIMIT = 128;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type TitlePhase = "idle" | "running" | "waiting" | "done" | "failed";

export interface TitleState {
	phase: TitlePhase;
	/** The status row's activity label ("Running npm test…"), running only. */
	label?: string;
	/**
	 * pi-persona's background work still running (parsed counts, never its text),
	 * done only: a run that ended with work outstanding is not "Done" yet.
	 */
	background?: BackgroundWork;
	session?: string;
	/** Basename of the session's cwd. */
	cwdBase: string;
}

function piece(value: string | undefined): string {
	const safe = sanitizeInlineText(value ?? "");
	if (safe.length <= PIECE_LIMIT) return safe;
	let out = "";
	for (const { segment } of GRAPHEMES.segment(safe)) {
		if (out.length + segment.length > PIECE_LIMIT - 1) break;
		out += segment;
	}
	return `${out}…`;
}

/** Pi's own title, rebuilt: "π - <session> - <cwd basename>" or "π - <cwd basename>". */
export function defaultTitle(session: string | undefined, cwdBase: string): string {
	const name = piece(session);
	const base = piece(cwdBase);
	return name ? `${PI_TITLE} - ${name} - ${base}` : `${PI_TITLE} - ${base}`;
}

export function terminalTitle(state: TitleState): string {
	const where = piece(state.session) || piece(state.cwdBase);
	const place = where ? ` — ${where}` : "";
	switch (state.phase) {
		case "running": {
			const label = piece(state.label);
			return `● ${label || "Working"}${place}`;
		}
		case "waiting": return `? Waiting for you${place}`;
		// One kind is named, several are counted: a tab has no room for the breakdown.
		case "done": return state.background ? `◌ Waiting on ${backgroundSummary(state.background)}${place}` : `✓ Done${place}`;
		case "failed": return `✗ Failed${place}`;
		default: return defaultTitle(state.session, state.cwdBase);
	}
}
