/** Bounded, presentation-only comparison of two sanitized replacement bodies. */
export interface DiffSpan { start: number; end: number }
export interface ChangedSpans { before: DiffSpan[]; after: DiffSpan[] }
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_CHARS = 8192;
const MAX_TOKENS = 256;
const MAX_CELLS = 65_536;
type Token = { text: string; start: number };

function tokens(text: string): Token[] | undefined {
	const result: Token[] = [];
	for (const part of WORDS.segment(text)) {
		if (result.length === MAX_TOKENS) return undefined;
		result.push({ text: part.segment, start: part.index });
	}
	return result;
}

/** Refine the edges of a changed word without splitting emoji or combining marks. */
function refine(before: string, after: string, oldStart: number, newStart: number, result: ChangedSpans): void {
	const old = Array.from(GRAPHEMES.segment(before), part => part.segment);
	const next = Array.from(GRAPHEMES.segment(after), part => part.segment);
	let left = 0;
	let right = 0;
	let prefix = 0;
	let suffix = 0;
	while (left < Math.min(old.length, next.length) && old[left] === next[left]) prefix += old[left++]!.length;
	while (right < Math.min(old.length, next.length) - left && old[old.length - right - 1] === next[next.length - right - 1]) {
		suffix += old[old.length - ++right]!.length;
	}
	if (before.length > prefix + suffix) result.before.push({ start: oldStart + prefix, end: oldStart + before.length - suffix });
	if (after.length > prefix + suffix) result.after.push({ start: newStart + prefix, end: newStart + after.length - suffix });
}

/**
 * Retain common words/punctuation between edits, then refine each changed span.
 * Huge lines/token streams get no intra-line emphasis; their full-line colors remain.
 * Limits bound segmentation input, quadratic work and matrix memory (~128 KiB).
 */
export function changedSpans(before: string, after: string): ChangedSpans {
	const result: ChangedSpans = { before: [], after: [] };
	if (before === after || before.length > MAX_CHARS || after.length > MAX_CHARS) return result;
	const old = tokens(before);
	const next = tokens(after);
	if (!old || !next || (old.length + 1) * (next.length + 1) > MAX_CELLS) return result;
	const columns = next.length + 1;
	const common = new Uint16Array((old.length + 1) * columns);
	for (let i = old.length - 1; i >= 0; i--) {
		for (let j = next.length - 1; j >= 0; j--) {
			common[i * columns + j] = old[i]!.text === next[j]!.text
				? 1 + common[(i + 1) * columns + j + 1]!
				: Math.max(common[(i + 1) * columns + j]!, common[i * columns + j + 1]!);
		}
	}
	let i = 0;
	let j = 0;
	let oldStart = 0;
	let newStart = 0;
	const flush = () => {
		const oldEnd = old[i]?.start ?? before.length;
		const newEnd = next[j]?.start ?? after.length;
		refine(before.slice(oldStart, oldEnd), after.slice(newStart, newEnd), oldStart, newStart, result);
	};
	while (i < old.length || j < next.length) {
		if (i < old.length && j < next.length && old[i]!.text === next[j]!.text) {
			flush();
			oldStart = old[i]!.start + old[i]!.text.length;
			newStart = next[j]!.start + next[j]!.text.length;
			i++;
			j++;
		} else if (j === next.length || (i < old.length && common[(i + 1) * columns + j]! >= common[i * columns + j + 1]!)) i++;
		else j++;
	}
	flush();
	return result;
}
