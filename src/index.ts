/**
 * pi-theme-1337 — a redesign for Pi's terminal UI.
 *
 * Two parts, the way the Pi docs split it:
 *   - bundled THEMES (`themes/*.json`): palettes on one 51-token contract, the
 *     default being a yellow-green phosphor with amber accents;
 *   - an EXTENSION (this file): it re-houses Pi's editor in a centered rounded
 *     panel (see `editor.ts`) that carries the only chrome worth keeping — the
 *     model identity in its top border, a prompt sigil, the working spinner,
 *     the workspace, usage, cost estimate and the subscription quota a provider
 *     reports (plus the active persona) inside
 *     — restyles the built-in tool rows, folds settled exploration, and marks
 *     where each run ended. The default footer and spinner row are hidden. A
 *     keyboard shortcut copies the input buffer as clean text (the logical
 *     buffer, free of frame glyphs and wraps).
 *
 * All on documented primitives: `setTheme`, `setEditorComponent` (with
 * `getEditorComponent`, so another extension's editor is never erased), `setFooter`,
 * `setWorkingVisible`, `setHiddenThinkingLabel`, `registerShortcut`, `setTitle`,
 * and `appendEntry` + `registerEntryRenderer` for the end-of-run summary row.
 * Everything is restored on `/theme-1337` off or shutdown. TUI-only; a no-op elsewhere.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { copyToClipboard, getLanguageFromPath, highlightCode, keyHint, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Text,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	Image,
	type ImageDimensions,
	type ImageProtocol,
	truncateToWidth as piTruncateToWidth,
	type TUI,
	visibleWidth as piVisibleWidth,
} from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { avatarImageColumns, layoutAvatarRows, type AvatarFrames, type AvatarState, parseAvatar, selectAvatar } from "./avatar.ts";
import { OSC11_RESET, osc11Set, resolveBackground, resolveBackgroundHex } from "./background.ts";
import { activityEnabled, autoThemeEnabled, backgroundEnv, chooseStartupTheme, copyShortcut, groupsEnabled, hiddenThinkingLabel, isDisabled, maxBoxWidth, polishEnabled, quotaEnabled, resetConfigCache, summaryEnabled, titleEnabled } from "./config.ts";
import { makeFramedEditorFactory, type EditorFactory } from "./editor.ts";
import { costTotal, formatCost, formatRunDelta, parseBackgroundStatus, parsePersonaCost, type ContextUsageLike } from "./format.ts";
import { CODEX_RATE_LIMITS_EVENT, CODEX_STREAM_API, EMPTY_QUOTA, nextQuota, nextQuotaEvent, nextQuotaMessage, quotaView, type QuotaState, type QuotaView } from "./quota.ts";
import { forceFullRedraw, installOutOfBandRedrawGuard, type RedrawWritable } from "./redraw-guard.ts";
import { createRunCollector, createRunSummaryRow, RUN_SUMMARY_TYPE } from "./run-summary.ts";
import { DEFAULT_SPINNER, parseSpinner, spinnerFrame, type SpinnerProfile } from "./spinner.ts";
import { defaultTitle, terminalTitle, type TitlePhase } from "./terminal-title.ts";
import { useTerminalMetrics } from "./width.ts";
import { createActivityTracker, createRunClock, currentActivity } from "./tool-activity.ts";
import { createFlatToolView, createSwitchableToolView } from "./tool-adapter.ts";
import { createToolRunRegistry, type ToolRunRegistry } from "./tool-groups.ts";
import { isPolishedTool } from "./tool-lexicon.ts";
import { createToolView } from "./tool-view.ts";

// Measure with the renderer's own ruler, never a copy of it. A row measured one
// column short pads past the terminal edge, wraps, and desynchronizes pi's
// differential renderer — which is how stale border rows survive a repaint (pi
// throws outright on an over-wide line). The mirror in width.ts stays only as
// the dependency-free fallback the pure unit tests run on.
// `stripAnsi` is deliberately absent: pi-tui no longer exports a sequence stripper, and the
// built-in one is a pure string transform with no terminal state to get wrong.
useTerminalMetrics({
	visibleWidth: piVisibleWidth,
	truncateToWidth: (text, max, ellipsis = "…") => piTruncateToWidth(text, max, ellipsis),
});

const AVATAR_WIDGET_KEY = "pi1337-avatar";
const AVATAR_COLS = 18; // max width of the avatar image, in terminal columns
const AVATAR_ROWS = 10; // max height of the avatar image, in terminal rows
const MAX_AVATAR_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The bits of pi-1337 config a theme file may carry (read via its `sourcePath`). */
interface ThemeConfig {
	pageBg?: string; // export.pageBg — the palette's `void`
	background?: string; // pi1337.background — "on"/"auto"/a hex
	avatar?: AvatarFrames; // pi1337.avatar — parsed frames (PNG or ASCII)
	avatarAlign?: "left" | "center"; // pi1337.avatar.align — horizontal placement of the avatar widget
	avatarPlacement?: "aboveEditor" | "belowEditor"; // pi1337.avatar.placement — which side of the editor
	spinner?: SpinnerProfile;
}

interface LoadedAvatarImage {
	component: Image;
	dimensions: ImageDimensions;
}

interface RenderedAvatarAscii {
	lines: string[];
}

const PERSONA_STATUS_KEY = "persona"; // published by pi-persona
const COST_STATUS_KEY = "persona-cost"; // pending background-leg cost estimate published by pi-persona
const BACKGROUND_STATUS_KEY = "persona-background"; // "agents=3 timers=1": work pi-persona still runs in the background
const MIN_MARGIN = 2;

/** Any extension's editor factory, as the host hands it back (its root export omits the named type). */
type HostEditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export default function pi1337(pi: ExtensionAPI) {
	// A fresh factory (startup or `/reload`) re-reads config.json, so an edit to
	// the file takes effect without restarting Pi. The loader bumps its cache
	// generation on reload, so this module is re-evaluated anyway; resetting
	// explicitly keeps that guarantee from depending on loader internals.
	resetConfigCache();
	if (isDisabled()) return;

	let enabled = true;
	let working = false;
	let runActive = false;
	let waitingForUser = false;
	let compacting = false;
	let spin = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let disposeOutOfBandRedrawGuard: (() => void) | undefined;
	let activeEditor: { getText(): string } | undefined;
	let footerData: ReadonlyFooterDataProvider | undefined;
	let branchUnsub: (() => void) | undefined; // git-branch change subscription (re-render the status row)
	let themeApplied = false;
	let previousTheme: string | undefined;
	let appliedTheme: string | undefined; // the palette we actually switched to (undefined = no switch to undo)
	let chromeActive = false; // true only while the framed editor + footer are installed (tui mode)
	let bgPainted = false; // true only while we hold an OSC 11 tint that clear() must reset
	let themeConfig: ThemeConfig = {}; // pi-1337 config read from the active theme file at apply()
	let themeDir: string | undefined; // dir of the active theme file, to resolve relative avatar images
	let themeConfigSource: string | undefined; // sourcePath the config was read from (detects a live /settings switch)
	let themeRefreshQueued = false;
	let themeRefreshGeneration = 0;
	let themeRefreshContext: ExtensionContext | undefined;
	let avatarShown = false; // whether the avatar widget is currently installed
	let avatarState: AvatarState = "idle"; // task-lifecycle state the avatar reflects
	let turnErrored = false; // a tool/compaction errored → show the error frame when the run settles
	const avatarImageCache = new Map<string, LoadedAvatarImage | null>(); // resolved path → decoded component (null = unrenderable)
	let cachedSessionName: string | undefined;
	let cachedContextUsage: ContextUsageLike | undefined;
	// The session-entry sum is walked only on agent/turn/session events; the
	// persona-cost status is compared on each footer pass and added on top.
	let cachedEntriesCost = 0;
	let cachedPersonaCost: string | undefined; // raw persona-cost status the totals were built from
	let cachedTotal = 0;
	let cachedCost = "";
	let runBaseline: number | undefined; // the total when the run began; undefined = no run to measure
	let cachedRunDelta = "";
	let costRenderQueued = false;
	let cachedThinkingLevel: string | undefined; // host's level, cached off the 90 ms render path
	// An assistant message has ended since the last refresh: Pi persists it right
	// after its message_end listeners return, so the next tool call can show it.
	let statsStale = false;
	// The editor slot is shared: only a factory of ours is ours to remove, and
	// what stood there before us comes back on toggle-off.
	let ourEditorFactory: EditorFactory | undefined; // the factory apply() installed
	let previousEditorFactory: HostEditorFactory | undefined; // never one of ours
	const ownEditorFactories = new WeakSet<object>(); // every factory this instance made
	// Read once, like the other settings: /reload applies a change.
	const maxWidth = maxBoxWidth();
	// Both presentation toggles are read once, like polish: /reload applies a change.
	const activityTracker = activityEnabled() ? createActivityTracker() : undefined; // names a long-running tool in the status row
	// The same slot's run clock ("Working… 45s"), under the same toggle. Like the
	// cost baseline it is the run's, not the chrome's: it survives a toggle, and a
	// run that began while the redesign was off never gets one.
	const runClock = activityTracker ? createRunClock() : undefined;
	let toolRuns: ToolRunRegistry | undefined; // folds settled exploration rows (polished lane only)
	const adapterTools = new Set<string>(); // tool names whose rows our adapter renders
	// Read once, like the other toggles: /reload applies a change.
	const summaryOn = summaryEnabled();
	const titleOn = titleEnabled(); // off: setTitle is never called at all
	// Fed from live events whatever the toggle, so a run toggled on halfway is
	// still summarized whole; the title only needs its outcome.
	const runCollector = summaryOn || titleOn ? createRunCollector() : undefined;
	let finished: "done" | "failed" | undefined; // the title's after-run state, until the next run or user input
	let titleSession: string | undefined; // survives clear(): the default title is written after it
	let titleCwdBase = "";
	let lastTitle: string | undefined; // the title the terminal holds as far as we know (dedupe)
	let titleLabel: string | undefined; // the activity label the title was last decided with
	let titleBackground: string | undefined; // the raw persona-background status the title was last decided with
	let titleRefreshQueued = false;
	let titleRefreshGeneration = 0;
	// Read once, like the other toggles: /reload applies a change. Off registers
	// no response or stream handler at all.
	const quotaOn = quotaEnabled();
	// What providers have said about the subscription, per provider. It is session
	// state like the run baseline: recorded while the redesign is toggled off, so
	// apply() finds it current, and kept across a model switch away and back.
	let quotaState: QuotaState = EMPTY_QUOTA;
	/** The model the turn in flight was started with: whose response the next headers are. */
	let quotaRequestModel: { provider?: string; api?: string } | undefined;
	let cachedQuota: QuotaView | undefined; // the current model's view; the render path reads only this
	let cachedQuotaKey = "";
	// Another extension installed its editor over ours: the footer and Pi's working
	// row went back to the host until the next apply() (see the footer's render).
	let displaced = false;
	let displacementQueued = false;
	let displacementGeneration = 0;

	// Registered at load, not in apply(): on a session switch Pi paints the
	// history before session_start, and a row whose renderer returns nothing
	// then is never added. Gated on the toggle for the same reason; apply() and
	// clear() invalidate the transcript, which rebuilds every entry row.
	const expandHint = () => keyHint("app.tools.expand", "to expand"); // the host's own wording
	if (summaryOn) {
		pi.registerEntryRenderer(RUN_SUMMARY_TYPE, (entry, options, theme) => {
			if (!enabled) return undefined;
			// Pi 1.5.2 passes no outputPad to entry renderers; use one if a host ever does.
			const pad = (options as { outputPad?: unknown }).outputPad;
			return createRunSummaryRow(entry.data, options.expanded, theme, typeof pad === "number" ? pad : 1, expandHint);
		});
	}

	// Pi keeps a row's renderer descriptor for its entire lifetime. Install a
	// stable adapter once, including for history drawn before session_start;
	// changing only the resolver on toggle would leave existing rows unchanged.
	if (polishEnabled()) {
		const toolStateKeys = new Map<string, symbol>();
		// Folding rides the polished lane: one registry decides which rows fold,
		// fed by the same tool and message events the host builds its rows from.
		if (groupsEnabled()) toolRuns = createToolRunRegistry();
		const groups = toolRuns;
		pi.registerToolRenderer((name, next) => {
			const baseline = next();
			const foreign = !isPolishedTool(name) && (baseline?.renderCall || baseline?.renderResult) ? baseline : undefined;
			// Purpose-built extension renderers (persona, MCP, etc.) keep their content.
			// One that frames itself, or leaves a slot to the host's private fallback
			// formatter (which no adapter lane can recompose byte for byte), is not ours.
			if (foreign && (foreign.renderShell === "self" || !foreign.renderCall || !foreign.renderResult)) return foreign;
			let stateKey = toolStateKeys.get(name);
			if (!stateKey) {
				stateKey = Symbol(`pi1337-tool-row:${name}`);
				toolStateKeys.set(name, stateKey);
			}
			// The rest are drawn in our flat shell while the redesign is active and in the
			// host's box otherwise. They stay out of adapterTools: such a row never folds,
			// and its tool_execution_start closes the exploration run above it.
			if (foreign) {
				return createFlatToolView(foreign, () => chromeActive, { Box, Container, Text, toolName: name, expandHint,
					imagesSupported: () => getCapabilities().images !== null }, stateKey);
			}
			adapterTools.add(name);
			return createSwitchableToolView(createToolView(name, expandHint, {
				highlightCode: (code, path) => {
					const language = getLanguageFromPath(path);
					return language ? highlightCode(code, language) : code.split("\n");
				},
			}), baseline,
				() => chromeActive, { Box, Container, Text, toolName: name, expandHint,
					imagesSupported: () => getCapabilities().images !== null, groups }, stateKey);
		});
	}

	// Read the theme's page background and optional adjacent .pi1337 sidecar.
	// Keep reading a legacy root pi1337 block when no sidecar exists, so custom
	// themes created before the strict Pi 1.0 schema migration still work.
	const readThemeConfig = (ctx: ExtensionContext): ThemeConfig => {
		const path = ctx.ui.theme.sourcePath;
		if (!path) return {};
		try {
			const json = JSON.parse(readFileSync(path, "utf8")) as {
				export?: { pageBg?: unknown };
				pi1337?: { background?: unknown; avatar?: unknown; spinner?: unknown };
			};
			let extras = json.pi1337;
			try {
				const sidecarPath = /\.json$/i.test(path) ? path.replace(/\.json$/i, ".pi1337") : `${path}.pi1337`;
				extras = JSON.parse(readFileSync(sidecarPath, "utf8")) as typeof extras;
			} catch (error) {
				// A missing sidecar permits older custom themes; a malformed one does
				// not silently activate stale metadata from the theme JSON.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") extras = undefined;
			}
			const avatar = extras?.avatar;
			const avatarObj = avatar && typeof avatar === "object" && !Array.isArray(avatar) ? (avatar as { align?: unknown; placement?: unknown }) : undefined;
			return {
				spinner: parseSpinner(extras?.spinner),
				pageBg: typeof json.export?.pageBg === "string" ? json.export.pageBg : undefined,
				background: typeof extras?.background === "string" ? extras.background : undefined,
				avatar: parseAvatar(avatar),
				avatarAlign: avatarObj?.align === "center" ? "center" : "left",
				// Default below the editor: a kitty-image widget placed *above* the editor
				// disturbs the box's redraw beneath it (reserved image rows + cursor math),
				// leaving the input frame corrupted until a resize forces a full repaint.
				avatarPlacement: avatarObj?.placement === "aboveEditor" ? "aboveEditor" : "belowEditor",
			};
		} catch {
			return {}; // unreadable/foreign theme file → no tint, no avatar
		}
	};

	// Opt-in tint of the terminal window background so the empty margins around the
	// frame match the palette instead of the terminal's own color. Enabled by env
	// `PI_1337_BG` OR the theme's `pi1337.background` (env wins). Written once per
	// install; always reversed in clear() (unpaintBackground/OSC 111).
	const paintBackground = (): void => {
		if (bgPainted || !enabled || !chromeActive || !activeTui) return;
		const bg = resolveBackground(backgroundEnv(), themeConfig.background);
		if (!bg.enabled) return;
		const hex = resolveBackgroundHex(bg.hex, themeConfig.pageBg);
		if (!hex) return;
		try {
			activeTui.terminal.write(osc11Set(hex));
			bgPainted = true;
		} catch {
			/* cosmetic — a terminal that rejects OSC 11 just keeps its background */
		}
	};

	const unpaintBackground = (): void => {
		if (!bgPainted) return;
		bgPainted = false;
		try {
			activeTui?.terminal.write(OSC11_RESET); // reset to the terminal's configured default
		} catch {
			/* cosmetic */
		}
	};

	// Re-tint after a theme change: drop the old color, then paint the new palette's.
	const repaintBackground = (): void => {
		unpaintBackground();
		paintBackground();
	};

	// Theme-driven ASCII avatar (e.g. a Fallout vault-boy). Shown in a widget next to
	// the editor (below by default) and swapped on the agent's working state; only present when the
	// active theme ships `pi1337.avatar`. Colored with the palette accent here (the
	// pure avatar module stays color-free). Removed in clear() — fully reversible.
	// A PNG frame is delegated to pi-tui's Image component, which owns the protocol-
	// specific cursor/row accounting and re-renders when main/fullscreen capability
	// changes. Bytes are loaded once per path; terminals without image support use
	// the configured ASCII fallback. Custom images are capped before reading.
	const loadAvatarImage = (imagePath: string): LoadedAvatarImage | undefined => {
		const abs = isAbsolute(imagePath) ? imagePath : themeDir ? resolvePath(themeDir, imagePath) : imagePath;
		const cached = avatarImageCache.get(abs);
		if (cached !== undefined) return cached ?? undefined;
		let result: LoadedAvatarImage | null = null;
		try {
			const stat = statSync(abs);
			if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AVATAR_IMAGE_BYTES) throw new Error("avatar image outside size limit");
			const b64 = readFileSync(abs).toString("base64");
			const ext = abs.split(".").pop()?.toLowerCase() ?? "";
			const mime = MIME_BY_EXT[ext] ?? "image/png";
			const dims = getImageDimensions(b64, mime);
			if (dims) {
				result = {
					component: new Image(b64, mime, { fallbackColor: (text) => text }, { maxWidthCells: AVATAR_COLS, maxHeightCells: AVATAR_ROWS, filename: abs }, dims),
					dimensions: dims,
				};
			}
		} catch {
			result = null; // unreadable/invalid/oversized file → ASCII fallback
		}
		avatarImageCache.set(abs, result);
		return result ?? undefined;
	};

	// Pi's Image can return either a protocol payload or a textual fallback.
	// Center actual images by their reserved cell width, but measure/clip fallback
	// text just like ASCII; never truncate an image escape sequence in half.
	const avatarWidget = (image: LoadedAvatarImage | undefined, ascii: RenderedAvatarAscii | undefined) => () => {
		let imageProtocol: ImageProtocol | undefined;
		return {
			invalidate() {
				imageProtocol = undefined;
				image?.component.invalidate();
			},
			render(width: number): string[] {
				const liveProtocol = getCapabilities().images;
				if (liveProtocol !== imageProtocol) {
					imageProtocol = liveProtocol;
					image?.component.invalidate();
				}
				const imageUsable = image !== undefined && imageProtocol !== null && getCapabilities().images === imageProtocol;
				const lines = imageUsable ? image.component.render(width) : ascii?.lines;
				if (!lines) return [];
				const maxImageCols = Math.min(AVATAR_COLS, Math.max(1, width - 2));
				const imageColumns = imageUsable
					? avatarImageColumns(image.dimensions, getCellDimensions(), maxImageCols, AVATAR_ROWS, imageProtocol)
					: undefined;
				return layoutAvatarRows(lines, width, { align: themeConfig.avatarAlign, imageColumns });
			},
		};
	};

	const updateAvatar = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const source = enabled && chromeActive ? selectAvatar(themeConfig.avatar, avatarState) : undefined;
		let image: LoadedAvatarImage | undefined;
		let ascii: RenderedAvatarAscii | undefined;
		if (source) {
			image = source.image ? loadAvatarImage(source.image) : undefined; // Pi Image handles Kitty/iTerm cursor accounting
			if (source.lines) {
				ascii = {
					lines: source.lines.map((l) => ctx.ui.theme.fg("accent", l)),
				};
			}
		}
		if (!image && !ascii) {
			if (avatarShown) {
				ctx.ui.setWidget(AVATAR_WIDGET_KEY, undefined);
				avatarShown = false;
			}
			return;
		}
		ctx.ui.setWidget(AVATAR_WIDGET_KEY, avatarWidget(image, ascii), {
			placement: themeConfig.avatarPlacement ?? "belowEditor",
		});
		avatarShown = true;
	};

	// Pi exposes no theme-change event, so a live `/settings` switch would otherwise
	// keep the old palette's tint + avatar. Detect it by the theme's sourcePath and
	// re-read: cheap string compare per call, real work only when it actually changed.
	const refreshThemeConfig = (ctx: ExtensionContext, force = false): void => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const src = ctx.ui.theme.sourcePath;
		if (!force && src === themeConfigSource) return;
		themeConfigSource = src;
		avatarImageCache.clear(); // a live palette switch must not retain every custom image ever seen
		const previousSpinner = themeConfig.spinner ?? DEFAULT_SPINNER;
		themeConfig = readThemeConfig(ctx);
		const nextSpinner = themeConfig.spinner ?? DEFAULT_SPINNER;
		if (previousSpinner !== nextSpinner) {
			spin = 0;
			if (working && chromeActive && !waitingForUser && !displaced) startSpinner();
			else stopSpinner();
		}
		themeDir = src ? dirname(src) : undefined;
		if (!force) {
			repaintBackground(); // the palette's void (tint) may have changed
			updateAvatar(ctx); // swap to the new theme's avatar (or remove it)
		}
	};

	const stopSpinner = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const requestRender = () => {
		activeTui?.requestRender();
	};

	const requestFullRender = (): void => {
		forceFullRedraw(activeTui);
	};

	const cancelThemeConfigRefresh = (): void => {
		themeRefreshQueued = false;
		themeRefreshContext = undefined;
		themeRefreshGeneration++;
	};

	// A theme switch has no Pi event. The empty footer may detect `sourcePath`
	// during render, but filesystem reads, OSC writes and widget mutation must run
	// only after that render has unwound. A generation token makes clear()/reload
	// invalidate an already queued microtask without retaining a stale context.
	const scheduleThemeConfigRefresh = (ctx: ExtensionContext): void => {
		themeRefreshContext = ctx;
		if (themeRefreshQueued) return;
		themeRefreshQueued = true;
		const generation = ++themeRefreshGeneration;
		queueMicrotask(() => {
			if (!themeRefreshQueued || generation !== themeRefreshGeneration) return;
			themeRefreshQueued = false;
			const next = themeRefreshContext;
			themeRefreshContext = undefined;
			if (!next || !enabled || !chromeActive) return;
			refreshThemeConfig(next);
			requestFullRender();
		});
	};

	// The terminal title follows the run: decided on the events that change it,
	// written only when the text changes, and Pi's own title whenever idle or off.
	// The events that define a phase (run start/end, prompt start/end) write it
	// even unchanged: Pi's own refresh (on win32, after its update check) may
	// have overwritten it unseen, and the dedupe would otherwise keep it lost.
	const titlePhase = (): TitlePhase => {
		if (!enabled || !chromeActive) return "idle";
		if (waitingForUser) return "waiting";
		if (runActive || compacting) return "running";
		return finished ?? "idle";
	};

	// Cheap enough for the render path: a phase check and one map lookup.
	const desiredTitleLabel = (): string | undefined =>
		titlePhase() === "running" ? activityTracker?.current(Date.now())?.label : undefined;

	// After a clean run the title depends on what pi-persona still has running:
	// its raw status, read only in that phase. One map lookup, so the footer can
	// compare it on every pass; only the parsed counts ever reach the title.
	const desiredTitleBackground = (): string | undefined =>
		titlePhase() === "done" ? footerData?.getExtensionStatuses().get(BACKGROUND_STATUS_KEY) || undefined : undefined;

	const updateTitle = (ctx: ExtensionContext, phaseChange = false): void => {
		if (!titleOn || !ctx.hasUI || ctx.mode !== "tui") return;
		titleLabel = desiredTitleLabel();
		titleBackground = desiredTitleBackground();
		const next = terminalTitle({
			phase: titlePhase(), label: titleLabel, background: parseBackgroundStatus(titleBackground),
			session: titleSession, cwdBase: titleCwdBase,
		});
		// A burst of calls must not rewrite the tab; toggled off, nothing re-asserts.
		if (next === lastTitle && !(phaseChange && enabled && chromeActive)) return;
		lastTitle = next;
		try {
			ctx.ui.setTitle(next);
		} catch {
			/* cosmetic */
		}
	};

	const cancelTitleRefresh = (): void => {
		titleRefreshQueued = false;
		titleRefreshGeneration++;
	};

	// The activity label appears only after its grace period, with no event to
	// announce it, and pi-persona's background status changes with none either.
	// The footer notices the change during render; the terminal write waits
	// until that render has unwound, like a theme switch.
	const scheduleTitleRefresh = (ctx: ExtensionContext): void => {
		if (titleRefreshQueued) return;
		titleRefreshQueued = true;
		const generation = ++titleRefreshGeneration;
		queueMicrotask(() => {
			if (!titleRefreshQueued || generation !== titleRefreshGeneration) return;
			titleRefreshQueued = false;
			if (enabled && chromeActive) updateTitle(ctx);
		});
	};

	// Labels from the cached sums only: never a session walk, so it is safe on any path.
	const recomputeCost = (): void => {
		cachedTotal = costTotal([], cachedEntriesCost) + parsePersonaCost(cachedPersonaCost);
		cachedCost = formatCost(cachedTotal);
		cachedRunDelta = runBaseline === undefined ? "" : formatRunDelta(cachedTotal - runBaseline);
	};

	// pi-persona republishes persona-cost when a background leg settles, possibly
	// while the parent is idle and no agent/turn event will follow. The footer
	// renders after the editor in a pass, so a change repaints once more after it.
	const syncPersonaCost = (data: ReadonlyFooterDataProvider): void => {
		const status = data.getExtensionStatuses().get(COST_STATUS_KEY);
		if (status === cachedPersonaCost) return;
		cachedPersonaCost = status;
		recomputeCost();
		if (costRenderQueued) return;
		costRenderQueued = true;
		queueMicrotask(() => {
			costRenderQueued = false;
			if (enabled && chromeActive) requestRender();
		});
	};

	const refreshSessionStats = (ctx: ExtensionContext): void => {
		cachedSessionName = ctx.sessionManager.getSessionName();
		cachedContextUsage = ctx.getContextUsage();
		cachedEntriesCost = costTotal(ctx.sessionManager.getEntries());
		cachedPersonaCost = footerData?.getExtensionStatuses().get(COST_STATUS_KEY);
		recomputeCost();
		// A model switch clamps the level before model_select fires, so every
		// refresh point re-reads it; thinking_level_select covers changes in between.
		cachedThinkingLevel = ctx.thinkingLevel;
	};

	// The quota view belongs to the current model's provider and is rebuilt only
	// on events: a response, a message's end, a model or session change, a run or
	// turn boundary. A window's expiry is therefore noticed at the next of those,
	// never by a timer, and the 90 ms render path reads the cached view alone.
	// Like every quota handler it does nothing outside the TUI and cannot throw.
	const refreshQuota = (ctx: ExtensionContext): void => {
		if (!quotaOn) return;
		try {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			const model = ctx.model as { provider?: string; api?: string } | undefined;
			const next = quotaView(quotaState, { provider: model?.provider, api: model?.api }, Date.now());
			// Everything the row paints from: the three forms, and which figures have aged.
			const key = next ? `${next.limit}|${next.two}|${next.one}|${next.windows.map((window) => (window.aged ? "a" : "f")).join("")}` : "";
			if (key === cachedQuotaKey) return;
			cachedQuotaKey = key;
			cachedQuota = next;
			if (enabled && chromeActive) requestRender();
		} catch {
			/* cosmetic: the row keeps the last view */
		}
	};

	// Third-party diagnostics occasionally bypass Pi's UI and write directly to
	// stderr. Those bytes must remain untouched, but they move the real terminal
	// cursor behind pi-tui's differential renderer. While our frame is active,
	// observe that one out-of-band channel and force a clean repaint after the
	// current write burst. Never wrap stdout: pi-tui itself renders there.
	const startOutOfBandRedrawGuard = (): void => {
		disposeOutOfBandRedrawGuard ??= installOutOfBandRedrawGuard(
			process.stderr as unknown as RedrawWritable,
			requestFullRender,
		);
	};

	const stopOutOfBandRedrawGuard = (): void => {
		disposeOutOfBandRedrawGuard?.();
		disposeOutOfBandRedrawGuard = undefined;
	};

	// Single source of motion: always restart from a clean timer so we never stack intervals.
	const startSpinner = () => {
		stopSpinner();
		const profile = themeConfig.spinner ?? DEFAULT_SPINNER;
		timer = setInterval(() => {
			spin = (spin + 1) % profile.frames.length;
			requestRender();
		}, profile.intervalMs);
	};

	// Pi may retry, compact, or continue after agent_end. Only agent_settled ends
	// the run. Prompts pause animation without losing the underlying activity;
	// manual compaction can also be active while there is no agent run at all.
	const syncActivity = (ctx: ExtensionContext, phaseChange = false): void => {
		updateTitle(ctx, phaseChange); // off or toggled off, this settles on Pi's own title
		if (!enabled || !chromeActive) return;
		working = (runActive || compacting) && !waitingForUser;
		// Displaced, nothing of ours shows the spinner: Pi's working row does.
		if (working && !displaced) {
			if (!timer) startSpinner();
		} else stopSpinner();
		avatarState = compacting ? "confused" : waitingForUser ? "idle" : working ? "working" : turnErrored ? "error" : "idle";
		updateAvatar(ctx);
		requestRender();
	};

	function applyTheme(ctx: ExtensionContext): void {
		if (!autoThemeEnabled() || themeApplied) return;
		const current = ctx.ui.theme.name;
		// Env pin > Pi's current bundled choice > config-file fallback > light theme
		// kept > green. A palette selected via /settings must survive reload even when
		// config.json contains an older startup preference; setTheme persists any target to Pi.
		const target = chooseStartupTheme(current, ctx.ui.theme.appearance);
		if (current === target) {
			themeApplied = true;
			appliedTheme = undefined; // nothing switched, nothing to undo
			return;
		}
		const result = ctx.ui.setTheme(target);
		themeApplied = result.success;
		if (result.success) {
			previousTheme = current; // only remember the prior theme once the switch actually took
			appliedTheme = target;
		} else {
			try {
				ctx.ui.notify(`pi-theme-1337: could not load theme "${target}" (${result.error ?? "unknown"})`, "warning");
			} catch {
				/* cosmetic */
			}
		}
	}

	function restoreTheme(ctx: ExtensionContext): void {
		if (!themeApplied) return;
		themeApplied = false;
		// Only revert if the live theme is still the one we switched to. If the user
		// (or another extension) changed themes while pi-1337 was active — including
		// picking another bundled palette — leave their newer choice untouched.
		if (previousTheme && appliedTheme && previousTheme !== appliedTheme && ctx.ui.theme.name === appliedTheme) {
			ctx.ui.setTheme(previousTheme);
		}
		previousTheme = undefined;
		appliedTheme = undefined;
	}

	// A host (or a test double) without getEditorComponent cannot say who holds
	// the editor slot: `known: false` keeps the behaviour from before it existed.
	const currentEditorFactory = (ctx: ExtensionContext): { known: boolean; factory?: HostEditorFactory } => {
		const ui = ctx.ui as { getEditorComponent?: () => HostEditorFactory | undefined };
		if (typeof ui.getEditorComponent !== "function") return { known: false };
		try {
			return { known: true, factory: ui.getEditorComponent() };
		} catch {
			return { known: false };
		}
	};

	// The framed editor is the only place the redesign shows the workspace, usage,
	// cost and spinner. When another extension installs its editor after ours,
	// that frame is no longer mounted, yet apply() has emptied the footer and
	// hidden Pi's working row: the user would be left with none of it. The
	// footer's render notices (one identity compare per UI pass) and this runs
	// once that render has unwound: the footer and the working row go back to the
	// host and our spinner stops. Tool rows, the theme, the title and the summary
	// stay ours, and the frame is taken again only by the next apply() — a toggle
	// or a session_start — never by itself.
	const editorDisplaced = (ctx: ExtensionContext): boolean => {
		if (displaced || !ourEditorFactory) return false;
		const installed = currentEditorFactory(ctx);
		return installed.known && installed.factory !== ourEditorFactory;
	};

	const cancelDisplacementCheck = (): void => {
		displacementQueued = false;
		displacementGeneration++;
	};

	const scheduleDisplacementCheck = (ctx: ExtensionContext): void => {
		if (displacementQueued) return;
		displacementQueued = true;
		const generation = ++displacementGeneration;
		queueMicrotask(() => {
			if (!displacementQueued || generation !== displacementGeneration) return;
			displacementQueued = false;
			// Checked again: the slot may have come back to us since the render that saw it.
			if (!enabled || !chromeActive || !editorDisplaced(ctx)) return;
			displaced = true;
			stopSpinner();
			try {
				ctx.ui.setFooter(undefined);
				ctx.ui.setWorkingVisible(true);
			} catch {
				/* cosmetic */
			}
			requestRender();
		});
	};

	function apply(ctx: ExtensionContext): void {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		spin = 0;
		displaced = false; // apply() takes the frame, the footer and the working row again
		cancelDisplacementCheck();
		applyTheme(ctx);

		// Read the palette's pi-1337 config now that the (possibly switched) theme is live.
		refreshThemeConfig(ctx, true);
		refreshSessionStats(ctx);
		refreshQuota(ctx); // recorded while toggled off too: the row opens on current figures
		ctx.ui.setWorkingVisible(false); // working moves into the frame's spinner
		ctx.ui.setHiddenThinkingLabel(hiddenThinkingLabel());

		// Empty footer — the editor frame carries the status. The factory also
		// captures `footerData` so the editor can read the persona status from it.
		ctx.ui.setFooter((tui, _theme, data) => {
			footerData = data;
			activeTui = tui;
			paintBackground(); // tui is now bound; tint the window if enabled by env or theme
			// The footer re-renders on every UI pass — including a live /settings theme
			// switch, which fires no event — detect it here, then apply it after render.
			const renderFooter = () => {
				if (ctx.ui.theme.sourcePath !== themeConfigSource) scheduleThemeConfigRefresh(ctx);
				if (titleOn && (desiredTitleLabel() !== titleLabel || desiredTitleBackground() !== titleBackground)) scheduleTitleRefresh(ctx);
				// Another extension's editor over ours has no event either; acted on after this render.
				if (editorDisplaced(ctx)) scheduleDisplacementCheck(ctx);
				syncPersonaCost(data);
				return [] as string[];
			};
			// Branch switches happen outside any agent activity; without this the
			// status row would show the old branch until the next unrelated render.
			branchUnsub ??= data.onBranchChange(() => requestRender());
			return { invalidate() {}, render: renderFooter };
		});

		// Whatever holds the slot now comes back on toggle-off, unless it is ours
		// (a second apply() without a clear() between: session_start in one session).
		const installedEditor = currentEditorFactory(ctx);
		if (!installedEditor.known || !installedEditor.factory) previousEditorFactory = undefined;
		else if (!ownEditorFactories.has(installedEditor.factory)) previousEditorFactory = installedEditor.factory;
		ourEditorFactory =
			makeFramedEditorFactory({
				ctx,
				getPersona: () => footerData?.getExtensionStatuses().get(PERSONA_STATUS_KEY) || undefined,
				getGitBranch: () => footerData?.getGitBranch(),
				getSessionName: () => cachedSessionName,
				getContextUsage: () => cachedContextUsage,
				getCost: () => cachedCost,
				getRunDelta: () => cachedRunDelta,
				getQuota: () => cachedQuota,
				getThinkingLevel: () => cachedThinkingLevel,
				isWorking: () => working,
				isWaitingForUser: () => waitingForUser,
				// Revealed by the spinner's own repaint once a call outlasts its grace
				// period, or the run its own; the editor only consults it while working
				// (so never during a blocking prompt). Compaction is Pi's indicator's to
				// announce: the run clock stays out of it.
				getActivity: activityTracker && (() => currentActivity(activityTracker, compacting ? undefined : runClock, Date.now())),
				spinnerFrame: () => spinnerFrame(themeConfig.spinner ?? DEFAULT_SPINNER, spin),
				spinnerRows: () => (themeConfig.spinner ?? DEFAULT_SPINNER).frameRows(spin),
				spinnerColor: () => (themeConfig.spinner ?? DEFAULT_SPINNER).color,
				spinnerHeight: () => (themeConfig.spinner ?? DEFAULT_SPINNER).height,
				spinnerColumns: () => (themeConfig.spinner ?? DEFAULT_SPINNER).columns,
				bindTui: (tui) => {
					activeTui = tui;
					paintBackground(); // editor may bind the tui before the footer factory runs
				},
				bindEditor: (editor) => {
					activeEditor = editor;
				},
				maxWidth,
				minMargin: MIN_MARGIN,
			});
		ownEditorFactories.add(ourEditorFactory);
		ctx.ui.setEditorComponent(ourEditorFactory);

		chromeActive = true;
		startOutOfBandRedrawGuard();
		paintBackground(); // covers a re-enable where the footer factory already ran (activeTui bound)
		syncActivity(ctx); // restore the current run/prompt/compaction state on toggle-on
		// Invalidate existing transcript rows: a full redraw alone does not rebuild
		// component caches, including history created before session_start.
		activeTui?.invalidate();
		// Also repairs any raw startup diagnostic emitted before the guard was bound.
		requestFullRender();
	}

	function clear(ctx: ExtensionContext, shutdown = false): void {
		stopOutOfBandRedrawGuard();
		cancelThemeConfigRefresh();
		cancelDisplacementCheck();
		displaced = false;
		working = false; // reset spinner state so a re-enable never shows a frozen frame
		spin = 0;
		chromeActive = false;
		avatarState = "idle";
		turnErrored = false;
		finished = undefined;
		cancelTitleRefresh();
		stopSpinner();
		if (ctx.hasUI && ctx.mode === "tui") {
			unpaintBackground(); // reset the OSC 11 tint before we drop the tui handle
			// Pi never resets the title itself: leave its own behind, once, if ours is showing.
			updateTitle(ctx);
			updateAvatar(ctx); // chromeActive=false → removes the avatar widget
			// The editor is ours to give back only while our factory still holds the
			// slot: one another extension installed after us stays where it is.
			const installedEditor = currentEditorFactory(ctx);
			if (installedEditor.known ? ourEditorFactory !== undefined && installedEditor.factory === ourEditorFactory : true) {
				// Toggle-off hands the slot back to the editor that held it before us.
				// Shutdown never builds another extension's editor: the slot is emptied.
				let restored = false;
				if (!shutdown && previousEditorFactory) {
					try {
						ctx.ui.setEditorComponent(previousEditorFactory);
						restored = true;
					} catch {
						/* its factory failed: Pi's own editor instead */
					}
				}
				if (!restored) ctx.ui.setEditorComponent(undefined);
			}
			ctx.ui.setFooter(undefined);
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setHiddenThinkingLabel();
			// Restore original tool callbacks/shells before dropping the TUI handle.
			activeTui?.invalidate();
			requestFullRender();
		}
		themeConfig = {};
		themeDir = undefined;
		themeConfigSource = undefined;
		avatarImageCache.clear();
		cachedSessionName = undefined;
		cachedContextUsage = undefined;
		cachedEntriesCost = 0;
		cachedPersonaCost = undefined;
		cachedTotal = 0;
		cachedCost = "";
		cachedRunDelta = ""; // the baseline is session state and survives a toggle
		cachedThinkingLevel = undefined;
		activityTracker?.clear();
		toolRuns?.reset();
		branchUnsub?.();
		branchUnsub = undefined;
		footerData = undefined;
		activeTui = undefined;
		activeEditor = undefined;
		ourEditorFactory = undefined;
		previousEditorFactory = undefined;
		if (ctx.hasUI) restoreTheme(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		runActive = !ctx.isIdle();
		waitingForUser = false;
		compacting = false;
		activityTracker?.clear();
		toolRuns?.reset(); // rows rebuilt from history stay unfolded: no events replay for them
		runBaseline = undefined; // a new, resumed or forked session has no run to measure yet
		runClock?.stop(); // nor a start to count from, even when Pi is mid-run
		runCollector?.reset();
		finished = undefined;
		titleSession = ctx.sessionManager.getSessionName();
		titleCwdBase = basename(ctx.cwd);
		// Pi writes exactly this right after binding extensions: nothing to write now.
		lastTitle = defaultTitle(titleSession, titleCwdBase);
		refreshQuota(ctx); // the session's model may be another provider's; apply() re-reads it when on
		if (enabled) apply(ctx);
	});

	// Subscription quota, from what the provider already sends with each response.
	// Both handlers are synchronous and constant-time, never throw (pi-ai awaits
	// the first before it reads the stream) and do nothing outside the TUI. They
	// keep recording while the redesign is toggled off, like prompt and compaction
	// state, so apply() finds current figures. No request is ever made for this.
	if (quotaOn) {
		pi.on("after_provider_response", (event, ctx) => {
			try {
				if (!ctx.hasUI || ctx.mode !== "tui") return;
				// The event names no provider. Inside a turn the response answers the
				// model that turn started with — the user may have switched since;
				// outside one (cache warming) it is the current model's.
				const model = quotaRequestModel ?? (ctx.model as { provider?: string; api?: string } | undefined);
				quotaState = nextQuota(quotaState, { status: event.status, headers: event.headers, api: model?.api, provider: model?.provider }, Date.now());
				refreshQuota(ctx);
			} catch {
				/* cosmetic: a response must never fail over the status row */
			}
		});
		// Fires for every raw stream chunk of every provider: two comparisons, then out.
		pi.on("provider_stream_event", (event, ctx) => {
			if (event.api !== CODEX_STREAM_API) return;
			try {
				if ((event.data as { type?: unknown } | null | undefined)?.type !== CODEX_RATE_LIMITS_EVENT) return;
				if (!ctx.hasUI || ctx.mode !== "tui") return;
				quotaState = nextQuotaEvent(quotaState, event, Date.now());
				refreshQuota(ctx);
			} catch {
				/* cosmetic */
			}
		});
	}

	pi.on("agent_start", (_event, ctx) => {
		// Pi re-enters its loop inside one run (an auto-retry, a mid-run compaction,
		// drained steering or follow-ups), emitting agent_start each time; only the
		// first after a settle begins the run, and the rest keep accumulating.
		const opening = !runActive;
		runActive = true;
		turnErrored = false; // fresh turn: clear any lingering error frame
		activityTracker?.clear(); // a call that never reported its end must not name the next run
		refreshQuota(ctx); // a window whose reset has passed leaves here, not on a timer
		if (opening) {
			finished = undefined;
			runCollector?.start(Date.now());
		}
		if (enabled && chromeActive) refreshSessionStats(ctx);
		if (opening) {
			// The delta measures this run: it starts at zero and replaces the last one.
			// Started while off, the run has no baseline, never the previous run's.
			runBaseline = enabled && chromeActive ? cachedTotal : undefined;
			if (enabled && chromeActive) recomputeCost();
			// The clock follows the same rule: started while off, the run has none.
			if (enabled && chromeActive) runClock?.start(Date.now());
			else runClock?.stop();
		}
		syncActivity(ctx, opening);
	});

	pi.on("agent_end", (_event, ctx) => {
		refreshQuota(ctx);
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		syncActivity(ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		runActive = false;
		compacting = false;
		activityTracker?.clear();
		runClock?.stop();
		toolRuns?.closeAll(); // nothing more can join the last run
		refreshQuota(ctx);
		if (enabled && chromeActive) refreshSessionStats(ctx);
		// An interrupted run goes straight back to Pi's own title.
		const outcome = runCollector?.outcome(event.aborted);
		finished = outcome === "done" || outcome === "failed" ? outcome : undefined;
		// What pi-persona still runs in the background, as of now: the row must not
		// say "Done" over it. Read-only, and absent without pi-persona.
		const stillRunning = parseBackgroundStatus(footerData?.getExtensionStatuses().get(BACKGROUND_STATUS_KEY));
		// The status row's own run delta, taken after the refresh above.
		const summary = runCollector?.finish(Date.now(), event.aborted, runBaseline === undefined ? 0 : cachedTotal - runBaseline, stillRunning);
		// The one deliberate session-file write: a custom entry, which never
		// becomes model input. Synchronous in this handler, never from a timer, and
		// it touches no message queue, so pi-persona's follow-ups are undisturbed.
		if (summary && summaryOn && enabled && chromeActive && ctx.hasUI && ctx.mode === "tui") {
			try {
				pi.appendEntry(RUN_SUMMARY_TYPE, summary);
			} catch {
				/* cosmetic: a failed write must not stall settlement */
			}
		}
		syncActivity(ctx, true);
	});

	// Submitting input ends the after-run title, as a new run would.
	if (titleOn) {
		pi.on("input", (_event, ctx) => {
			if (!finished) return;
			finished = undefined;
			updateTitle(ctx);
		});
	}

	pi.on("ui_prompt_start", (_event, ctx) => {
		waitingForUser = true;
		syncActivity(ctx, true);
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		waitingForUser = false;
		syncActivity(ctx, true);
	});

	// Context compaction reads as the model "thinking hard" — show the confused frame
	// for its duration, then return to the working frame the turn resumes in.
	pi.on("session_before_compact", (_event, ctx) => {
		toolRuns?.closeAll(); // Pi paints a compaction row (or its failure) below the rows so far
		compacting = true;
		syncActivity(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		toolRuns?.reset(); // the chat is rebuilt from the retained entries, unfolded
		compacting = false;
		if (enabled && chromeActive) refreshSessionStats(ctx);
		syncActivity(ctx);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		compacting = false;
		if (!event.aborted) turnErrored = true;
		syncActivity(ctx);
	});

	// The summary's model time: each turn runs from here to its assistant message's end.
	pi.on("turn_start", (_event, ctx) => {
		runCollector?.turnStart(Date.now());
		const model = ctx.model as { provider?: string; api?: string } | undefined;
		quotaRequestModel = model ? { provider: model.provider, api: model.api } : undefined;
		refreshQuota(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		runCollector?.turnEnd(event.message);
		quotaRequestModel = undefined;
		refreshQuota(ctx);
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		// The host is about to rebuild the chat from the new branch: a fold's tally
		// row may not be on it, so rebuilt rows start unfolded.
		toolRuns?.reset();
		refreshQuota(ctx); // the branch may have been written by another provider's model
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		requestRender();
	});

	pi.on("session_info_changed", (event, ctx) => {
		titleSession = event.name;
		// Pi rewrote its own title just before this handler: re-apply ours over it.
		lastTitle = defaultTitle(titleSession, titleCwdBase);
		updateTitle(ctx);
		if (!enabled || !chromeActive) return;
		cachedSessionName = event.name;
		requestRender();
	});

	pi.on("model_select", (_event, ctx) => {
		// The state is per provider: switching away hides its figures, switching back finds them.
		refreshQuota(ctx);
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		requestRender();
	});

	pi.on("thinking_level_select", (event) => {
		if (!enabled || !chromeActive) return;
		cachedThinkingLevel = event.level;
		requestRender();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		// The end event carries no arguments: the summary keeps what it needs from here.
		runCollector?.toolStart(event.toolCallId, event.toolName, event.args, ctx.cwd);
		if (!enabled) return;
		// Nested codemode calls are shown inside their parent's row, never as rows
		// of their own: they feed neither the label nor the runs.
		if (!event.parentToolCallId) {
			// The response that launched this call is in the session by now: show its
			// tokens and spend while the call runs, not the figures from before it.
			// Once per assistant message; the spinner's repaint carries it.
			if (statsStale && chromeActive) {
				statsStale = false;
				refreshSessionStats(ctx);
			}
			activityTracker?.onStart(event.toolCallId, event.toolName, event.args, Date.now());
			toolRuns?.onToolStart(event.toolCallId, event.toolName,
				{ args: event.args, cwd: ctx.cwd, rendersHere: adapterTools.has(event.toolName) });
		}
	});

	pi.on("tool_execution_end", (event) => {
		// Nested calls count too, and only live: their results are not persisted.
		runCollector?.toolEnd(event.toolCallId, event.toolName, event.result, event.isError, !!event.parentToolCallId);
		if (!enabled) return;
		if (event.isError) turnErrored = true; // remembered until agent_settled shows the error frame
		// The fold registry is settled by the row itself, once it shows the result.
		if (!event.parentToolCallId) activityTracker?.onEnd(event.toolCallId);
	});

	// Whatever paints a transcript row ends the run above it. A streaming assistant
	// message is empty at its start, so the update is what catches the first thinking
	// or text the moment it appears; start covers user and custom messages, end the
	// providers that do not stream. The registry returns at once while no run is open.
	const closeRunOnPaintedMessage = (event: { message: unknown }): void => {
		if (enabled) toolRuns?.onMessage(event.message);
	};
	pi.on("message_start", closeRunOnPaintedMessage);
	pi.on("message_update", (event) => {
		// The summary's thinking time: only the stream's thinking_start/end are read.
		runCollector?.streamEvent(event.assistantMessageEvent, Date.now());
		closeRunOnPaintedMessage(event);
	});
	pi.on("message_end", (event, ctx) => {
		// An assistant message's end closes its turn's model interval and carries its usage.
		runCollector?.messageEnd(event.message, Date.now());
		// Not refreshed here: Pi appends the message to the session after this returns.
		if ((event.message as { role?: unknown } | undefined)?.role === "assistant") {
			statsStale = true;
			// A usage-limit error is the only quota signal some routes give; any other
			// ending of that provider's assistant message clears it.
			if (quotaOn) {
				try {
					if (ctx.hasUI && ctx.mode === "tui") {
						quotaState = nextQuotaMessage(quotaState, event.message, (ctx.model as { provider?: string } | undefined)?.provider, Date.now());
						refreshQuota(ctx);
					}
				} catch {
					/* cosmetic */
				}
			}
		}
		closeRunOnPaintedMessage(event);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		runActive = false;
		waitingForUser = false;
		compacting = false;
		runClock?.stop();
		clear(ctx, true);
	});

	// The toggle is namespaced separately from the bundled `1337` palette, which
	// remains available in /settings.
	pi.registerCommand("theme-1337", {
		description: "Toggle the pi-theme-1337 redesign (theme + framed editor)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) apply(ctx);
			else clear(ctx);
			try {
				ctx.ui.notify(`pi-theme-1337 ${enabled ? "on" : "off"}`, "info");
			} catch {
				/* cosmetic */
			}
		},
	});

	// Clean-copy escape hatch: native terminal selection grabs the rendered cells
	// (frame `│`, left padding, a newline per visual row), so it cannot yield the
	// raw input. This shortcut copies the editor's logical buffer verbatim instead.
	const copyKey = copyShortcut();
	if (copyKey) {
		pi.registerShortcut(copyKey as KeyId, {
			description: "pi-theme-1337: copy the input buffer as clean text (no frame glyphs)",
			handler: async (ctx) => {
				if (!enabled) return;
				const text = activeEditor?.getText() ?? "";
				if (!text) return;
				try {
					await copyToClipboard(text);
					ctx.ui.notify("pi-theme-1337: input copied", "info");
				} catch {
					/* cosmetic */
				}
			},
		});
	}
}
