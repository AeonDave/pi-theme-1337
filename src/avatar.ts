/**
 * Pure parsing/selection for the theme-driven avatar.
 *
 * These palettes are themes *for* pi-1337, so a theme file may carry a
 * `pi1337.avatar` — a small mascot shown in a widget above the editor that
 * reacts to the agent (e.g. a Fallout Vault-Boy: thumbs-up while the model is
 * answering, thumbs-down when idle). A frame is either a PNG (`{ image }`,
 * rendered via the terminal image protocol) or ASCII (`{ lines }`, for terminals
 * with no image support). This module only turns the raw JSON value into frames
 * and picks one for the current state; index.ts owns loading/encoding + the
 * widget + coloring.
 */

import { sanitizeArtLine } from "./format.ts";

/** One avatar frame: a PNG path OR literal ASCII lines (image preferred when both). */
export interface AvatarSource {
	/** Path to a PNG (absolute, or relative to the theme file). */
	image?: string;
	/** ASCII fallback lines, used when the terminal has no image protocol. */
	lines?: string[];
}

/** The task-lifecycle states the avatar can reflect. */
export type AvatarState = "idle" | "working" | "confused" | "error";

/** Per-state frames. A missing state falls back down the chain (see `selectAvatar`). */
export interface AvatarFrames {
	/** Shown at rest / on startup (e.g. a friendly wink). */
	idle?: AvatarSource;
	/** Shown while the model is producing a response. Falls back to `idle`. */
	working?: AvatarSource;
	/** Shown during context compaction ("thinking hard"). Falls back to `working` → `idle`. */
	confused?: AvatarSource;
	/** Shown when the turn hit a tool error. Falls back to `idle`. */
	error?: AvatarSource;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Coerce a JSON art value (a string with newlines, or an array of lines) to lines. */
function toLines(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const lines = value.filter((v): v is string => typeof v === "string").map(sanitizeArtLine);
		return lines.length > 0 ? lines : undefined;
	}
	if (typeof value === "string" && value.length > 0) return value.split("\n").map(sanitizeArtLine);
	return undefined;
}

/** Parse one frame: a path string → image; a newline string / array → ASCII; an object → explicit. */
function parseSource(value: unknown): AvatarSource | undefined {
	if (typeof value === "string") {
		const s = value.trim();
		if (!s) return undefined;
		if (IMAGE_EXT.test(s)) return { image: s };
		return { lines: value.split("\n").map(sanitizeArtLine) };
	}
	if (Array.isArray(value)) {
		const lines = toLines(value);
		return lines ? { lines } : undefined;
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const image = typeof obj.image === "string" && obj.image.trim() ? obj.image.trim() : undefined;
		const lines = toLines(obj.lines);
		if (image || lines) return { image, lines };
	}
	return undefined;
}

/**
 * Parse a theme's `pi1337.avatar` into frames, or `undefined` when the theme
 * ships none (the common case — the widget then never appears). A bare frame
 * (path string / ASCII / `{ image|lines }`) is treated as an always-on avatar
 * (same idle and working); an object `{ idle?, working? }` gives per-state
 * control — e.g. `{ working }` alone makes it appear only while the model answers.
 */
export function parseAvatar(raw: unknown): AvatarFrames | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		if ("idle" in obj || "working" in obj || "confused" in obj || "error" in obj) {
			const frames: AvatarFrames = {
				idle: parseSource(obj.idle),
				working: parseSource(obj.working),
				confused: parseSource(obj.confused),
				error: parseSource(obj.error),
			};
			return frames.idle || frames.working || frames.confused || frames.error ? frames : undefined;
		}
	}
	const bare = parseSource(raw); // path / ASCII / {image|lines} → pinned in both states
	return bare ? { idle: bare, working: bare } : undefined;
}

/**
 * The frame to show for `state`, or `undefined` to hide the widget. Each state
 * falls back toward the always-present `idle` frame, so a theme can ship as few
 * as one frame: `working`→`idle`, `confused`→`working`→`idle`, `error`→`idle`.
 * `idle` never borrows another state's frame — a `{ working }`-only avatar stays
 * hidden at rest (the "appears when the AI responds" behavior).
 */
export function selectAvatar(frames: AvatarFrames | undefined, state: AvatarState): AvatarSource | undefined {
	if (!frames) return undefined;
	switch (state) {
		case "working":
			return frames.working ?? frames.idle;
		case "confused":
			return frames.confused ?? frames.working ?? frames.idle;
		case "error":
			return frames.error ?? frames.idle;
		default:
			return frames.idle;
	}
}
