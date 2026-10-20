/**
 * pi-1337 — a phosphor-green redesign for Pi.
 *
 * Two parts, the way the Pi docs split it:
 *   - a bundled THEME (`themes/1337.json`): a true-monochrome green-screen
 *     palette — every token a shade on one phosphor ramp, amber reserved for
 *     errors (a nod to amber CRTs);
 *   - an EXTENSION (this file): it re-houses Pi's editor in a centered
 *     ASCII-art panel (see `editor.ts`) whose borders carry the only chrome
 *     worth keeping — a prompt sigil, the working spinner, live subagents, the workspace, and
 *     the chosen model (plus the active persona). Everything else — the default
 *     footer and spinner row — is hidden. A keyboard shortcut copies the input
 *     buffer as clean text (the logical buffer, free of frame glyphs and wraps).
 *
 * All on documented primitives: `setTheme`, `setEditorComponent`, `setFooter`,
 * `setWorkingVisible`, `setHiddenThinkingLabel`, `registerShortcut`. Everything is
 * restored on `/pi-1337` off or shutdown. TUI-only; a no-op elsewhere.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
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
import { autoThemeEnabled, backgroundEnv, chooseStartupTheme, copyShortcut, hiddenThinkingLabel, isDisabled, resetConfigCache } from "./config.ts";
import { makeFramedEditorFactory } from "./editor.ts";
import { formatCost, parsePersonaCost, type ContextUsageLike } from "./format.ts";
import { forceFullRedraw, installOutOfBandRedrawGuard, type RedrawWritable } from "./redraw-guard.ts";
import { countSubagentsFromInput, countSubagentsFromResult } from "./subagents.ts";
import { useTerminalMetrics } from "./width.ts";

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
}

interface LoadedAvatarImage {
	component: Image;
	dimensions: ImageDimensions;
}

interface RenderedAvatarAscii {
	lines: string[];
}

const PERSONA_STATUS_KEY = "persona"; // published by pi-persona
const AGENTS_STATUS_KEY = "persona-agents"; // live numeric agent count published by pi-persona
const COST_STATUS_KEY = "persona-cost"; // pending background-leg cost estimate published by pi-persona
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_WIDTH = 100;
const MIN_MARGIN = 2;

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
	const activeSubagentCalls = new Map<string, number>();
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
	let cachedCost = "";

	// Read the theme's page background and optional adjacent .pi1337 sidecar.
	// Keep reading a legacy root pi1337 block when no sidecar exists, so custom
	// themes created before the strict Pi 1.0 schema migration still work.
	const readThemeConfig = (ctx: ExtensionContext): ThemeConfig => {
		const path = ctx.ui.theme.sourcePath;
		if (!path) return {};
		try {
			const json = JSON.parse(readFileSync(path, "utf8")) as {
				export?: { pageBg?: unknown };
				pi1337?: { background?: unknown; avatar?: unknown };
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
		themeConfig = readThemeConfig(ctx);
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

	const activeSubagentCount = () => {
		let count = 0;
		for (const value of activeSubagentCalls.values()) count += value;
		return count;
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

	const refreshSessionStats = (ctx: ExtensionContext): void => {
		cachedSessionName = ctx.sessionManager.getSessionName();
		cachedContextUsage = ctx.getContextUsage();
		const extraCost = parsePersonaCost(footerData?.getExtensionStatuses().get(COST_STATUS_KEY));
		cachedCost = formatCost(ctx.sessionManager.getEntries(), extraCost);
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
		timer = setInterval(() => {
			spin = (spin + 1) % SPINNER.length;
			requestRender();
		}, 90);
	};

	// Pi may retry, compact, or continue after agent_end. Only agent_settled ends
	// the run. Prompts pause animation without losing the underlying activity;
	// manual compaction can also be active while there is no agent run at all.
	const syncActivity = (ctx: ExtensionContext): void => {
		if (!enabled || !chromeActive) return;
		working = (runActive || compacting) && !waitingForUser;
		if (working) {
			if (!timer) startSpinner();
		} else stopSpinner();
		avatarState = compacting ? "confused" : waitingForUser ? "idle" : working ? "working" : turnErrored ? "error" : "idle";
		updateAvatar(ctx);
		requestRender();
	};

	function applyTheme(ctx: ExtensionContext): void {
		if (!autoThemeEnabled() || themeApplied) return;
		const current = ctx.ui.theme.name;
		// Env pin > persisted bundled palette > default green. A palette the user
		// picked via /settings (e.g. 1337-ice) is one of ours: keep it — never
		// stomp it back to the default on restart (setTheme would also overwrite
		// the persisted choice in Pi's settings, losing it for good).
		const target = chooseStartupTheme(current);
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
				ctx.ui.notify(`pi-1337: could not load theme "${target}" (${result.error ?? "unknown"})`, "warning");
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

	function apply(ctx: ExtensionContext): void {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		applyTheme(ctx);

		// Read the palette's pi-1337 config now that the (possibly switched) theme is live.
		refreshThemeConfig(ctx, true);
		refreshSessionStats(ctx);
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
				return [] as string[];
			};
			// Branch switches happen outside any agent activity; without this the
			// status row would show the old branch until the next unrelated render.
			branchUnsub ??= data.onBranchChange(() => requestRender());
			return { invalidate() {}, render: renderFooter };
		});

		ctx.ui.setEditorComponent(
			makeFramedEditorFactory({
				ctx,
				getPersona: () => footerData?.getExtensionStatuses().get(PERSONA_STATUS_KEY) || undefined,
				getSubagentCount: activeSubagentCount,
				// pi-persona's numeric count covers strategy/council cores as well as
				// delegates — prefer it over the delegate-only fallback when present.
				getAgents: () => footerData?.getExtensionStatuses().get(AGENTS_STATUS_KEY) || undefined,
				getGitBranch: () => footerData?.getGitBranch(),
				getSessionName: () => cachedSessionName,
				getContextUsage: () => cachedContextUsage,
				getCost: () => cachedCost,
				isWorking: () => working,
				isWaitingForUser: () => waitingForUser,
				spinnerFrame: () => SPINNER[spin],
				bindTui: (tui) => {
					activeTui = tui;
					paintBackground(); // editor may bind the tui before the footer factory runs
				},
				bindEditor: (editor) => {
					activeEditor = editor;
				},
				maxWidth: MAX_WIDTH,
				minMargin: MIN_MARGIN,
			}),
		);

		chromeActive = true;
		startOutOfBandRedrawGuard();
		paintBackground(); // covers a re-enable where the footer factory already ran (activeTui bound)
		syncActivity(ctx); // restore the current run/prompt/compaction state on toggle-on
		// Also repairs any raw startup diagnostic emitted before the guard was bound.
		requestFullRender();
	}

	function clear(ctx: ExtensionContext): void {
		stopOutOfBandRedrawGuard();
		cancelThemeConfigRefresh();
		working = false; // reset spinner state so a re-enable never shows a frozen frame
		chromeActive = false;
		avatarState = "idle";
		turnErrored = false;
		stopSpinner();
		if (ctx.hasUI && ctx.mode === "tui") {
			unpaintBackground(); // reset the OSC 11 tint before we drop the tui handle
			updateAvatar(ctx); // chromeActive=false → removes the avatar widget
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setHiddenThinkingLabel();
		}
		themeConfig = {};
		themeDir = undefined;
		themeConfigSource = undefined;
		avatarImageCache.clear();
		cachedSessionName = undefined;
		cachedContextUsage = undefined;
		cachedCost = "";
		branchUnsub?.();
		branchUnsub = undefined;
		footerData = undefined;
		activeTui = undefined;
		activeEditor = undefined;
		activeSubagentCalls.clear();
		if (ctx.hasUI) restoreTheme(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		runActive = !ctx.isIdle();
		waitingForUser = false;
		compacting = false;
		if (enabled) apply(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		runActive = true;
		turnErrored = false; // fresh turn: clear any lingering error frame
		if (enabled && chromeActive) refreshSessionStats(ctx);
		syncActivity(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		syncActivity(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		runActive = false;
		compacting = false;
		activeSubagentCalls.clear();
		if (enabled && chromeActive) refreshSessionStats(ctx);
		syncActivity(ctx);
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		waitingForUser = true;
		syncActivity(ctx);
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		waitingForUser = false;
		syncActivity(ctx);
	});

	// Context compaction reads as the model "thinking hard" — show the confused frame
	// for its duration, then return to the working frame the turn resumes in.
	pi.on("session_before_compact", (_event, ctx) => {
		compacting = true;
		syncActivity(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		compacting = false;
		if (enabled && chromeActive) refreshSessionStats(ctx);
		syncActivity(ctx);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		compacting = false;
		if (!event.aborted) turnErrored = true;
		syncActivity(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		requestRender();
	});

	pi.on("session_info_changed", (event) => {
		if (!enabled || !chromeActive) return;
		cachedSessionName = event.name;
		requestRender();
	});

	pi.on("model_select", (_event, ctx) => {
		if (!enabled || !chromeActive) return;
		refreshSessionStats(ctx);
		requestRender();
	});

	pi.on("tool_execution_start", (event) => {
		if (!enabled || event.toolName !== "delegate") return;
		const count = countSubagentsFromInput(event.args);
		if (count > 0) activeSubagentCalls.set(event.toolCallId, count);
		requestRender();
	});

	pi.on("tool_execution_update", (event) => {
		if (!enabled || event.toolName !== "delegate") return;
		const count = countSubagentsFromResult(event.partialResult);
		if (count !== undefined) {
			if (count > 0) activeSubagentCalls.set(event.toolCallId, count);
			else activeSubagentCalls.delete(event.toolCallId);
			requestRender();
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (!enabled) return;
		if (event.isError) turnErrored = true; // remembered until agent_settled shows the error frame
		if (event.toolName !== "delegate") return;
		activeSubagentCalls.delete(event.toolCallId);
		requestRender();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		runActive = false;
		waitingForUser = false;
		compacting = false;
		clear(ctx);
	});

	// Command name is `pi-1337` (not `1337`) so it never shadows another tool's
	// `/1337`. The bundled THEME is still named `1337` (picked via /settings); only
	// this slash command is namespaced.
	pi.registerCommand("pi-1337", {
		description: "Toggle the pi-1337 phosphor redesign (theme + framed editor)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) apply(ctx);
			else clear(ctx);
			try {
				ctx.ui.notify(`pi-1337: phosphor ${enabled ? "on" : "off"}`, "info");
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
			description: "pi-1337: copy the input buffer as clean text (no frame glyphs)",
			handler: async (ctx) => {
				if (!enabled) return;
				const text = activeEditor?.getText() ?? "";
				if (!text) return;
				try {
					await copyToClipboard(text);
					ctx.ui.notify("pi-1337: input copied", "info");
				} catch {
					/* cosmetic */
				}
			},
		});
	}
}
