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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * This extension's state directory — `<agent-dir>/1337-theme/`, namespaced the
 * same way every other Pi extension namespaces its state (`claude-native/`,
 * `persona/`, `skill-optimizer/`). Override with `PI_1337_STATE_DIR`.
 */
export function stateDir(): string {
	return process.env.PI_1337_STATE_DIR?.trim() || join(agentDir(), "1337-theme");
}

/**
 * Pi's own agent directory: `PI_CODING_AGENT_DIR` env, else `~/.pi/agent`.
 *
 * REPLICATED rather than imported (same rationale as `pi-claude`): this module
 * deliberately imports nothing from Pi at runtime, and the helper is not part
 * of the extension API surface we can rely on across Pi versions.
 */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** Settings persisted in `<stateDir>/config.json`. Keys map 1:1 to the env vars. */
export interface ConfigFileSettings {
	disable?: boolean;
	theme?: string;
	thinkingLabel?: string;
	copyKey?: string;
	background?: string;
}

let cachedDir: string | null = null;
let cachedSettings: ConfigFileSettings | null = null;

/**
 * Read `<stateDir>/config.json`. Returns `{}` for a missing, unreadable,
 * malformed, or wrongly-typed file: a broken config must never stop Pi from
 * starting, so every failure degrades to the built-in defaults.
 *
 * Only known keys of the expected primitive type are kept; anything else is
 * dropped rather than surfaced as a wrong-typed value.
 */
export function configFileSettings(): ConfigFileSettings {
	const dir = stateDir();
	// Keyed on the resolved dir so a changed PI_1337_STATE_DIR is never served
	// from a previous dir's memoized file.
	if (cachedSettings && cachedDir === dir) return cachedSettings;
	cachedDir = dir;
	const empty: ConfigFileSettings = {};
	let raw: string;
	try {
		raw = readFileSync(join(dir, "config.json"), "utf8");
	} catch {
		cachedSettings = empty;
		return cachedSettings;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		cachedSettings = empty;
		return cachedSettings;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		cachedSettings = empty;
		return cachedSettings;
	}
	const out: ConfigFileSettings = {};
	const src = parsed as Record<string, unknown>;
	if (typeof src.disable === "boolean") out.disable = src.disable;
	if (typeof src.theme === "string") out.theme = src.theme;
	if (typeof src.thinkingLabel === "string") out.thinkingLabel = src.thinkingLabel;
	if (typeof src.copyKey === "string") out.copyKey = src.copyKey;
	if (typeof src.background === "string") out.background = src.background;
	cachedSettings = out;
	return out;
}

/** Drop the memoized `config.json` read (tests and `/reload`). */
export function resetConfigCache(): void {
	cachedSettings = null;
	cachedDir = null;
}

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
	return !!process.env.PI_1337_DISABLE?.trim() || configFileSettings().disable === true;
}

/**
 * Whether to switch to a bundled phosphor theme on activation. `off` in either
 * the env var or the config file keeps the current theme (redesign only).
 */
export function autoThemeEnabled(): boolean {
	const raw = process.env.PI_1337_THEME ?? configFileSettings().theme;
	return raw?.trim().toLowerCase() !== "off";
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
	const raw = (process.env.PI_1337_THEME ?? configFileSettings().theme)?.trim().toLowerCase();
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
	return (process.env.PI_1337_THINKING_LABEL ?? configFileSettings().thinkingLabel)?.trim() || "∴ thinking";
}

/**
 * Key chord for the "copy input buffer" shortcut (a `KeyId` such as `alt+c` or
 * `ctrl+alt+y`). Set `PI_1337_COPY_KEY` (or `copyKey` in `config.json`) to an
 * empty/whitespace value to disable.
 */
export function copyShortcut(): string {
	// `!== undefined` rather than `??`: an env var set to "" must still win and
	// disable the shortcut, not fall through to the config file's value.
	const raw = process.env.PI_1337_COPY_KEY !== undefined ? process.env.PI_1337_COPY_KEY : configFileSettings().copyKey;
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
	return process.env.PI_1337_BG ?? configFileSettings().background;
}

/** Every setting after merging env over the config file over the built-in defaults. */
export interface ResolvedSettings {
	disable: boolean;
	autoTheme: boolean;
	theme?: string;
	thinkingLabel: string;
	copyKey: string;
	background?: string;
}

/** Merge env → config file → defaults into one resolved view. */
export function resolveSettings(): ResolvedSettings {
	return {
		disable: isDisabled(),
		autoTheme: autoThemeEnabled(),
		theme: envPalette(),
		thinkingLabel: hiddenThinkingLabel(),
		copyKey: copyShortcut(),
		background: backgroundEnv(),
	};
}
