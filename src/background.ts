/**
 * Pure helpers for the optional terminal-background tint.
 *
 * A Pi *theme* can only color the cells Pi draws (per-widget backgrounds); the
 * window's own background — including the empty margins around the framed editor
 * — belongs to the terminal emulator. As an *extension* we can still tint it with
 * OSC 11 (`ESC ] 11 ; <color> BEL`), the same out-of-band channel pi-tui uses to
 * *query* the background. This is opt-in and must always be undone (OSC 111
 * resets to the terminal default), so the sequences live here, dependency-free
 * and unit-tested, while index.ts owns the write + the reversal.
 *
 * Only a solid color is portable. A background *image* has no app-level escape
 * that sits behind the text across terminals (kitty/iTerm image protocols draw
 * inline content, not a backdrop) — it stays the emulator's own config.
 */

// OSC 11: set the default background color. BEL-terminated to match pi-tui's own
// OSC emitter (its `\x1b]11;?\x07` query), which every target terminal accepts.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape-sequence literal
const OSC = "\x1b]";
const BEL = "\x07";

/** OSC 111: reset the background color to the terminal's configured default. */
export const OSC11_RESET = `${OSC}111${BEL}`;

/**
 * Normalize a hex color to lowercase `#rrggbb`, expanding the `#rgb` shorthand.
 * Returns `undefined` for anything that isn't a 3- or 6-digit hex color, so a
 * malformed value can never be written to the terminal.
 */
export function normalizeHex(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const s = input.trim().toLowerCase();
	const m3 = /^#([0-9a-f]{3})$/.exec(s);
	if (m3) {
		const [r, g, b] = m3[1];
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return /^#[0-9a-f]{6}$/.test(s) ? s : undefined;
}

/** Build the OSC 11 sequence that tints the terminal background to `hex`. */
export function osc11Set(hex: string): string {
	return `${OSC}11;${hex}${BEL}`;
}

/** Settings that read as "do not tint" from either the env var or the theme. */
const BG_FALSY = new Set(["", "0", "off", "false", "no"]);

export interface BackgroundResolution {
	/** Whether to tint the terminal at all. */
	enabled: boolean;
	/** An explicit color the setting pinned (`#…`); undefined → derive from the theme's `void`. */
	hex?: string;
}

/**
 * Decide whether/what to tint from the two sources, env winning over the theme.
 * `env` is the raw `PI_1337_BG` (undefined when unset); `theme` is the palette's
 * own `pi1337.background` (these are themes *for* pi-1337, so they may opt in).
 * A defined `env` — even `off`/empty — overrides the theme entirely; otherwise the
 * theme's setting stands. `on`/`auto`/`theme`/`1` enable the derived `void`; a
 * `#rrggbb`/`#rgb` value enables that exact color; falsy values disable.
 */
export function resolveBackground(env: string | undefined, theme: string | undefined): BackgroundResolution {
	const raw = env !== undefined ? env : theme;
	if (raw === undefined) return { enabled: false };
	const s = raw.trim().toLowerCase();
	if (BG_FALSY.has(s)) return { enabled: false };
	const hex = normalizeHex(s);
	return hex ? { enabled: true, hex } : { enabled: true };
}

/**
 * Resolve the background color to paint: an explicit `override` (e.g. from
 * `PI_1337_BG=#101010`) wins when it's a valid hex; otherwise the active theme's
 * page background (`export.pageBg` — each palette's `void`). Returns `undefined`
 * when neither is a usable color, in which case the terminal is left untouched.
 */
export function resolveBackgroundHex(override: string | undefined, pageBg: string | undefined): string | undefined {
	return normalizeHex(override) ?? normalizeHex(pageBg);
}
