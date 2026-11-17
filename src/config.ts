/**
 * Environment-driven config for pi-1337.
 *
 * | Env var | Default | Purpose |
 * |---------|---------|---------|
 * | `PI_1337_POLISH`         | `on`         | Compact tool rows and diff previews; `off` restores host renderers. |
 * | `PI_1337_DISABLE`        | _(off)_      | Any non-empty value disables the extension entirely. |
 * | `PI_1337_THEME`          | `on`         | `off` keeps your current theme; `on` preserves a bundled Pi choice or uses green; `green` explicitly pins green. Palette aliases include `poison`, `magma`, `cyberpunk-2077`, `cyberpunk-2077-edgerunner`, and `skynet-dark`. |
 * | `PI_1337_THINKING_LABEL` | `∴ thinking` | Label for the collapsed thinking row. |
 * | `PI_1337_COPY_KEY`       | `alt+c`      | Shortcut that copies the input buffer as clean text. Empty disables it. |
 * | `PI_1337_BG`             | _(theme)_    | `on`/`auto` tints the terminal window background to the active palette's `void`; a `#rrggbb`/`#rgb` value forces that color; `off` leaves the terminal untouched. Unset defers to the theme's own `pi1337.background`; a set value overrides it. |
 * | `PI_1337_ACTIVITY`       | `on`         | Names a long-running tool in the status row (`Running npm test…`); `off` hides it. |
 * | `PI_1337_GROUPS`         | `on`         | Folds runs of three or more settled read/search/list rows into one tally row; `off` keeps one row per call. Needs `PI_1337_POLISH`. |
 * | `PI_1337_SUMMARY`        | `on`         | Appends one summary row when a run that used tools, was interrupted or failed settles; `off` writes none and hides existing ones. |
 * | `PI_1337_TITLE`          | `on`         | Shows the run state in the terminal title (`● Running npm test… — repo`); `off` never touches the title. |
 * | `PI_1337_QUOTA`          | `on`         | Shows the subscription quota a provider reports in the status row (`5h 43% · wk 12%`); `off` reads nothing and registers no handler. |
 * | `PI_1337_MAX_WIDTH`      | `100`      | Widest framed editor box, in columns; `0`/`full` removes the cap. Values below 40 are raised to 40. |
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
	polish?: boolean;
	activity?: boolean;
	groups?: boolean;
	summary?: boolean;
	title?: boolean;
	quota?: boolean;
	theme?: string;
	thinkingLabel?: string;
	copyKey?: string;
	background?: string;
	/** Columns, or `"full"`; validated by `maxBoxWidth`, not here. */
	maxWidth?: number | string;
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
	if (typeof src.polish === "boolean") out.polish = src.polish;
	if (typeof src.activity === "boolean") out.activity = src.activity;
	if (typeof src.groups === "boolean") out.groups = src.groups;
	if (typeof src.summary === "boolean") out.summary = src.summary;
	if (typeof src.title === "boolean") out.title = src.title;
	if (typeof src.quota === "boolean") out.quota = src.quota;
	if (typeof src.theme === "string") out.theme = src.theme;
	if (typeof src.thinkingLabel === "string") out.thinkingLabel = src.thinkingLabel;
	if (typeof src.copyKey === "string") out.copyKey = src.copyKey;
	if (typeof src.background === "string") out.background = src.background;
	if (typeof src.maxWidth === "number" || typeof src.maxWidth === "string") out.maxWidth = src.maxWidth;
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
	"1337-poison",
	"1337-magma",
	"1337-cyber",
	"1337-cyberpunk-2077",
	"1337-cyberpunk-2077-edgerunner",
	"1337-neon",
	"1337-cosmos",
	"1337-fallout",
	"1337-skynet",
	"1337-skynet-dark",
] as const;

/** Short aliases → registered theme ids. All are also selectable via `/settings`. */
const THEME_ALIASES: Record<string, string> = {
	green: "1337",
	amber: "1337-amber",
	ice: "1337-ice",
	poison: "1337-poison",
	magma: "1337-magma",
	cyber: "1337-cyber",
	blue: "1337-cyber",
	"cyberpunk-2077": "1337-cyberpunk-2077",
	"cyberpunk-2077-edgerunner": "1337-cyberpunk-2077-edgerunner",
	neon: "1337-neon",
	cosmos: "1337-cosmos",
	fallout: "1337-fallout",
	skynet: "1337-skynet",
	"skynet-dark": "1337-skynet-dark",
};

function paletteFrom(value: string | undefined): string | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw || raw === "on" || raw === "off") return undefined;
	if (raw in THEME_ALIASES) return THEME_ALIASES[raw];
	if (isBundledTheme(raw)) return raw;
	return undefined;
}

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
export function isBundledTheme(name: string | undefined): name is (typeof BUNDLED_THEMES)[number] {
	return !!name && (BUNDLED_THEMES as readonly string[]).includes(name);
}

/**
 * The palette explicitly pinned via `PI_1337_THEME`, or `undefined` when the
 * variable is unset, a plain `on`/`off`, or unrecognized. Config-file theme
 * values are startup fallbacks, not explicit pins.
 */
export function envPalette(): string | undefined {
	return paletteFrom(process.env.PI_1337_THEME);
}

function configPalette(): string | undefined {
	return paletteFrom(configFileSettings().theme);
}

/**
 * The palette to apply at session start: an explicit environment pin wins;
 * otherwise Pi's current bundled palette is respected; otherwise a configured
 * config-file palette seeds startup; otherwise a light theme is kept as is;
 * otherwise default green. `appearance` is the current theme's (Pi's
 * `Theme.appearance`).
 */
export function chooseStartupTheme(current: string | undefined, appearance?: "light" | "dark"): string {
	const pinned = envPalette();
	if (pinned) return pinned;
	// Pi's current bundled theme is its persisted /settings choice. The config
	// file is a first-start fallback, so it must not override a later UI choice.
	if (isBundledTheme(current)) return current;
	// Any environment setting takes precedence over the config file. An explicit
	// `on` asks for the default palette, on a light theme too. With no env
	// setting, the config-file palette may seed startup when Pi has no bundled choice.
	const env = process.env.PI_1337_THEME;
	if (env?.trim().toLowerCase() === "on") return THEME_NAME;
	const configured = env === undefined ? configPalette() : undefined;
	if (configured) return configured;
	// Every bundled palette is dark and the tint is opt-in, so on a light theme
	// (Pi picks `light` for a light terminal) switching would leave text
	// unreadable. The chrome uses semantic tokens, so keep the user's theme.
	if (appearance === "light" && current) return current;
	return THEME_NAME;
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

/**
 * Shared env-over-file resolution for the `on`/`off` presentation toggles: an
 * env value of exactly `on`/`off` wins, otherwise the config-file boolean,
 * otherwise the built-in default.
 */
function onOffSetting(env: string | undefined, file: boolean | undefined, fallback: boolean): boolean {
	const raw = env?.trim().toLowerCase();
	if (raw === "off") return false;
	if (raw === "on") return true;
	return file ?? fallback;
}

/** Compact transcript rendering follows the redesign unless explicitly disabled. */
export function polishEnabled(): boolean {
	return onOffSetting(process.env.PI_1337_POLISH, configFileSettings().polish, true);
}

/** Transient status-row activity label follows the redesign unless explicitly disabled. */
export function activityEnabled(): boolean {
	return onOffSetting(process.env.PI_1337_ACTIVITY, configFileSettings().activity, true);
}

/**
 * Folding settled exploration rows rides the polished tool rows, so it is off
 * whenever polish is, whatever its own setting says.
 */
export function groupsEnabled(): boolean {
	return polishEnabled() && onOffSetting(process.env.PI_1337_GROUPS, configFileSettings().groups, true);
}

/** The end-of-run summary row follows the redesign unless explicitly disabled. */
export function summaryEnabled(): boolean {
	return onOffSetting(process.env.PI_1337_SUMMARY, configFileSettings().summary, true);
}

/** Run state in the terminal title follows the redesign unless explicitly disabled. */
export function titleEnabled(): boolean {
	return onOffSetting(process.env.PI_1337_TITLE, configFileSettings().title, true);
}

/** The subscription quota item of the status row follows the redesign unless explicitly disabled. */
export function quotaEnabled(): boolean {
	return onOffSetting(process.env.PI_1337_QUOTA, configFileSettings().quota, true);
}

/** Box cap when nothing valid is configured: the redesign's original width. */
export const DEFAULT_MAX_WIDTH = 100;
/** A cap below this leaves too few columns for the input and its status row to read. */
export const MIN_MAX_WIDTH = 40;

/** `full`/`0` → no cap; a whole number of columns → itself (raised to the floor); anything else → undefined. */
function parseMaxWidth(raw: number | string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const text = String(raw).trim().toLowerCase();
	if (text === "full") return Number.POSITIVE_INFINITY;
	if (!/^\d+$/.test(text)) return undefined;
	const columns = Number(text);
	if (!Number.isSafeInteger(columns)) return undefined;
	return columns === 0 ? Number.POSITIVE_INFINITY : Math.max(MIN_MAX_WIDTH, columns);
}

/**
 * Widest framed box in columns (`Infinity` = no cap). A valid env value wins,
 * then a valid config-file value, then the default; invalid values are ignored
 * so a typo can never collapse the editor.
 */
export function maxBoxWidth(): number {
	return parseMaxWidth(process.env.PI_1337_MAX_WIDTH) ?? parseMaxWidth(configFileSettings().maxWidth) ?? DEFAULT_MAX_WIDTH;
}

/** Every setting after merging env over the config file over the built-in defaults. */
export interface ResolvedSettings {
	disable: boolean;
	polish: boolean;
	activity: boolean;
	groups: boolean;
	summary: boolean;
	title: boolean;
	quota: boolean;
	autoTheme: boolean;
	theme?: string;
	thinkingLabel: string;
	copyKey: string;
	background?: string;
	/** Columns; `Infinity` when uncapped. */
	maxWidth: number;
}

/** Merge env → config file → defaults into one resolved view. */
export function resolveSettings(): ResolvedSettings {
	return {
		disable: isDisabled(),
		polish: polishEnabled(),
		activity: activityEnabled(),
		groups: groupsEnabled(),
		summary: summaryEnabled(),
		title: titleEnabled(),
		quota: quotaEnabled(),
		autoTheme: autoThemeEnabled(),
		theme: process.env.PI_1337_THEME === undefined ? configPalette() : envPalette(),
		thinkingLabel: hiddenThinkingLabel(),
		copyKey: copyShortcut(),
		background: backgroundEnv(),
		maxWidth: maxBoxWidth(),
	};
}
