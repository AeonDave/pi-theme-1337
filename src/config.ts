/**
 * Environment-driven config for pi-1337.
 *
 * | Env var | Default | Purpose |
 * |---------|---------|---------|
 * | `PI_1337_DISABLE`        | _(off)_      | Any non-empty value disables the extension entirely. |
 * | `PI_1337_THEME`          | `on`         | `off` keeps your current theme; `amber`/`ice`/`split` pick a palette; `on`/`green` = the default green. |
 * | `PI_1337_THINKING_LABEL` | `∴ thinking` | Label for the collapsed thinking row. |
 * | `PI_1337_COPY_KEY`       | `alt+c`      | Shortcut that copies the input buffer as clean text. Empty disables it. |
 * | `PI_1337_BG`             | _(theme)_    | `on`/`auto` tints the terminal window background to the active palette's `void`; a `#rrggbb`/`#rgb` value forces that color; `off` leaves the terminal untouched. Unset defers to the theme's own `pi1337.background`; a set value overrides it. |
 */

/** The default bundled theme's name (registered via `pi.themes`). */
export const THEME_NAME = "1337";

/** All bundled palettes — the set `/settings` can persist that we must respect. */
export const BUNDLED_THEMES = [
	"1337",
	"1337-amber",
	"1337-ice",
	"1337-split",
	"1337-cyber",
	"1337-neon",
	"1337-fallout",
	"1337-skynet",
] as const;

/** Short aliases → registered theme ids. All are also selectable via `/settings`. */
const THEME_ALIASES: Record<string, string> = {
	green: "1337",
	amber: "1337-amber",
	ice: "1337-ice",
	split: "1337-split",
	cyber: "1337-cyber",
	blue: "1337-cyber",
	neon: "1337-neon",
	fallout: "1337-fallout",
	skynet: "1337-skynet",
};

export function isDisabled(): boolean {
	return !!process.env.PI_1337_DISABLE?.trim();
}

/** Whether to switch to a bundled phosphor theme on activation. */
export function autoThemeEnabled(): boolean {
	return process.env.PI_1337_THEME?.trim().toLowerCase() !== "off";
}

/** True when `name` is one of the palettes this package ships. */
export function isBundledTheme(name: string | undefined): boolean {
	return !!name && (BUNDLED_THEMES as readonly string[]).includes(name);
}

/**
 * The palette explicitly pinned via `PI_1337_THEME` (alias `green`/`amber`/
 * `ice`/`split` or a full id), or `undefined` when the var is unset, a plain
 * `on`/`off`, or unrecognized — i.e. when there is no explicit pin.
 */
export function envPalette(): string | undefined {
	const raw = process.env.PI_1337_THEME?.trim().toLowerCase();
	if (!raw || raw === "on" || raw === "off") return undefined;
	if (raw in THEME_ALIASES) return THEME_ALIASES[raw];
	if (isBundledTheme(raw)) return raw;
	return undefined;
}

/**
 * The palette to apply at session start, given the theme Pi restored from the
 * user's settings: an explicit env pin wins; otherwise a persisted bundled
 * palette (the user picked e.g. `1337-ice` via `/settings`) is respected;
 * otherwise the default green replaces the foreign theme.
 */
export function chooseStartupTheme(current: string | undefined): string {
	return envPalette() ?? (isBundledTheme(current) ? (current as string) : THEME_NAME);
}

export function hiddenThinkingLabel(): string {
	return process.env.PI_1337_THINKING_LABEL?.trim() || "∴ thinking";
}

/**
 * Key chord for the "copy input buffer" shortcut (a `KeyId` such as `alt+c` or
 * `ctrl+alt+y`). Set `PI_1337_COPY_KEY` to an empty/whitespace value to disable.
 */
export function copyShortcut(): string {
	const raw = process.env.PI_1337_COPY_KEY;
	if (raw === undefined) return "alt+c";
	return raw.trim();
}

/**
 * The raw `PI_1337_BG` value (undefined when unset), forwarded to the pure
 * `resolveBackground` resolver so an env setting overrides the theme's own
 * `pi1337.background`. Off by default: tinting the terminal is invasive, so it
 * only happens when the env var OR the active palette explicitly opts in.
 */
export function backgroundEnv(): string | undefined {
	return process.env.PI_1337_BG;
}
