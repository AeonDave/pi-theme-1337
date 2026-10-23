import type { Color } from "@earendil-works/pi-tui";
import { visibleWidth } from "./width.ts";

export interface SpinnerProfile {
	/** First row of each frame; retained for the single-row API. */
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly columns: number;
	readonly height: number;
	readonly color?: Color;
	readonly frameRows: (index: number) => readonly string[];
}

const DEFAULT_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

export const DEFAULT_SPINNER: SpinnerProfile = Object.freeze({
	frames: DEFAULT_FRAMES,
	intervalMs: 90,
	columns: 1,
	height: 1,
	frameRows: (index: number) => {
		const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
		return [DEFAULT_FRAMES[((safeIndex % DEFAULT_FRAMES.length) + DEFAULT_FRAMES.length) % DEFAULT_FRAMES.length]];
	},
});

const MAX_FRAMES = 32;
const MAX_FRAME_LENGTH = 256;
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 500;
const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\t\r\n]/u;

/** Validate untrusted sidecar data using the same width ruler used to paint it. */
export function parseSpinner(value: unknown): SpinnerProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as { frames?: unknown; intervalMs?: unknown; color?: unknown };
	if (!Array.isArray(candidate.frames) || candidate.frames.length < 1 || candidate.frames.length > MAX_FRAMES) return undefined;
	if (candidate.intervalMs !== undefined && (typeof candidate.intervalMs !== "number" || !Number.isFinite(candidate.intervalMs) || candidate.intervalMs < MIN_INTERVAL || candidate.intervalMs > MAX_INTERVAL)) return undefined;
	const rows: string[][] = [];
	let columns: number | undefined;
	let height: number | undefined;
	for (const item of candidate.frames) {
		const frame = typeof item === "string" ? [item] : Array.isArray(item) ? item : undefined;
		if (!frame || frame.length < 1 || frame.length > 2 || (height !== undefined && frame.length !== height)) return undefined;
		const checked: string[] = [];
		for (const line of frame) {
			if (typeof line !== "string" || line.length === 0 || line.length > MAX_FRAME_LENGTH || unsafeText.test(line) || !/\P{White_Space}/u.test(line)) return undefined;
			const width = visibleWidth(line);
			if (width < 1 || width > 3 || (columns !== undefined && width !== columns)) return undefined;
			columns = width;
			checked.push(line);
		}
		height = frame.length;
		rows.push(checked);
	}
	let color: Color | undefined;
	if (candidate.color !== undefined) {
		if (typeof candidate.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(candidate.color)) return undefined;
		color = Object.freeze({ kind: "rgb", r: parseInt(candidate.color.slice(1, 3), 16), g: parseInt(candidate.color.slice(3, 5), 16), b: parseInt(candidate.color.slice(5, 7), 16) });
	}
	const frozenRows = Object.freeze(rows.map((row) => Object.freeze(row)));
	const frameRows = (index: number): readonly string[] => {
		const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
		return frozenRows[((safeIndex % frozenRows.length) + frozenRows.length) % frozenRows.length];
	};
	return Object.freeze({ frames: Object.freeze(frozenRows.map((row) => row[0])), intervalMs: candidate.intervalMs === undefined ? 90 : candidate.intervalMs, columns: columns!, height: height!, color, frameRows });
}

export function spinnerFrame(profile: SpinnerProfile, index: number): string {
	const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
	return profile.frames[((safeIndex % profile.frames.length) + profile.frames.length) % profile.frames.length];
}
