/**
 * FramedEditor — Pi's editor, re-housed in a centered rounded panel.
 *
 * It renders the real editor at a reduced inner width, then hands the raw lines
 * to `frameEditor` (pure) which drops Pi's open-sided rules and rebuilds a
 * continuous rounded box with a left margin. The box is capped at `maxWidth`
 * and centered, so on a wide terminal there is breathing room on both sides.
 *
 * The border carries one label, the model identity (provider/model · thinking
 * level) at its top-right; the rest of the chrome lives inside. The first row's
 * gutters carry the `›` prompt sigil (left) and the working spinner (right); a
 * dedicated status row above the bottom edge carries where you are (workspace ·
 * branch · session, left) and the session's state (usage, cost estimate, run
 * delta, subscription quota, persona, right). All editing/keybinding behavior is the base `CustomEditor`'s — the
 * subclass only changes presentation and invalidates its transparent raw-layout
 * cache around state changes.
 */

import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Color, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	bashInputMode,
	cleanModel,
	formatContextWindow,
	formatElapsed,
	formatTokens,
	type ContextUsageLike,
	sanitizeInlineText,
	shortCwd,
	stableEmojiWidth,
	usageLevel,
} from "./format.ts";
import { editorWidthFor, frameEditor, GUTTER, ROUNDED, statusSlotWidth, type RowCandidate } from "./frame.ts";
import type { QuotaView, QuotaViewWindow } from "./quota.ts";
import type { Activity } from "./tool-activity.ts";
import { chooseBox, visibleWidth } from "./width.ts";

/**
 * Levels the border label names, each painted with the palette's own thinking
 * token. A whitelist rather than a sanitizer: `off`, a missing level and any
 * text the host did not define show nothing.
 */
const THINKING_COLORS = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

function thinkingColor(level: string | undefined): (typeof THINKING_COLORS)[keyof typeof THINKING_COLORS] | undefined {
	return level !== undefined && Object.hasOwn(THINKING_COLORS, level) ? THINKING_COLORS[level as keyof typeof THINKING_COLORS] : undefined;
}

/** A named call shows its elapsed time once it has run this long; shorter calls need no counter. */
export const ACTIVITY_ELAPSED_MS = 3000;

/**
 * The narrowest a session name may shorten to on the status row: nine
 * characters and the ellipsis. A shorter name is shown whole or not at all.
 */
export const SESSION_MIN_COLUMNS = 10;

/**
 * The narrowest the activity label may shorten to: seven characters and the
 * ellipsis, where most verbs still read whole (`Running…`). With fewer cells
 * the workspace keeps its place rather than a stub of a label taking it.
 */
export const ACTIVITY_MIN_COLUMNS = 8;

export interface FramedEditorDeps {
	ctx: ExtensionContext;
	getPersona: () => string | undefined;
	/** Current git branch from Pi's footer data (null = not a repo). */
	getGitBranch?: () => string | null | undefined;
	/** Cached outside render; session walks in the 90ms spinner path are forbidden. */
	getSessionName: () => string | undefined;
	getContextUsage: () => ContextUsageLike | undefined;
	/** Formatted session estimate ("~$1.24"), cached outside render; "" hides it. */
	getCost: () => string;
	/** Formatted spend of the current or last run ("+$0.42"), cached outside render; "" hides it. */
	getRunDelta?: () => string;
	/**
	 * The current provider's subscription quota, computed on events and cached
	 * outside render; `undefined` (or an absent callback) leaves the row as it is
	 * without one.
	 */
	getQuota?: () => QuotaView | undefined;
	/** Host thinking level, cached outside render; shown only for a reasoning model. */
	getThinkingLevel?: () => string | undefined;
	isWorking: () => boolean;
	/** Static prompt state; takes precedence over the animated working spinner. */
	isWaitingForUser?: () => boolean;
	/**
	 * The running call worth naming, or the run clock when none is (revealed by
	 * the spinner repaint, never its own timer). Consulted only while working and
	 * not waiting for the user; it borrows the left group's cells and never moves
	 * the right group.
	 */
	getActivity?: () => Activity | undefined;
	spinnerFrame: () => string;
	spinnerRows?: () => readonly string[];
	spinnerColor?: () => Color | undefined;
	/** Active theme's text-motion height; absent legacy callers keep one row. */
	spinnerHeight?: () => number;
	/** Active theme's fixed indicator width; absent legacy callers keep one cell. */
	spinnerColumns?: () => number;
	/** Hand the live TUI back so the spinner timer can request renders. */
	bindTui: (tui: TUI) => void;
	/** Hand the live editor back so a shortcut can copy its logical buffer. */
	bindEditor: (editor: CustomEditor) => void;
	maxWidth: number;
	minMargin: number;
}

class FramedEditor extends CustomEditor {
	/**
	 * Pi asks every component to render again for the 90 ms spinner tick. The
	 * base editor has no render cache, so relaying that call would re-wrap and
	 * re-measure the complete input on every tick even when no editor state
	 * changed. Keep only the base editor's raw lines: the outer frame is still
	 * rebuilt each time because its spinner/status chrome is live.
	 */
	private rawRenderCache:
		| {
			width: number;
			terminalRows: number;
			focused: boolean;
			paddingX: number;
			raw: string[];
		}
		| undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private readonly deps: FramedEditorDeps) {
		super(tui, theme, keybindings, { paddingX: 1 });
		deps.bindTui(tui);
		deps.bindEditor(this);
	}

	private invalidateRawRenderCache(): void {
		this.rawRenderCache = undefined;
	}

	/** State-changing editor APIs must invalidate the raw layout cache. */
	override invalidate(): void {
		this.invalidateRawRenderCache();
		super.invalidate();
	}

	override handleInput(data: string): void {
		this.invalidateRawRenderCache();
		super.handleInput(data);
	}

	override setPaddingX(padding: number): void {
		this.invalidateRawRenderCache();
		super.setPaddingX(padding);
	}

	override setText(text: string): void {
		this.invalidateRawRenderCache();
		super.setText(text);
	}

	override insertTextAtCursor(text: string): void {
		this.invalidateRawRenderCache();
		super.insertTextAtCursor(text);
	}

	/**
	 * Forward mouse routing to the host implementation so a click that moves the
	 * cursor cannot leave a spinner redraw on the old raw layout. Pi's screen-level text
	 * selection owns press/drag/release on editor rows, so unhandled motion events
	 * must not evict the unchanged layout cache.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const base = (CustomEditor.prototype as unknown as {
			handleMouse?: (this: FramedEditor, value: TuiMouseEvent) => TuiMouseEventResult | undefined;
		}).handleMouse;
		if (!base || !event || typeof event !== "object") return undefined;
		const mouse = event as { x?: unknown; width?: unknown };
		if (typeof mouse.x !== "number" || typeof mouse.width !== "number") {
			const result = base.call(this, event);
			if (event.type === "click" || result !== undefined) this.invalidateRawRenderCache();
			return result;
		}
		const { fallback, boxWidth, leftMargin } = chooseBox(mouse.width, this.deps.maxWidth, this.deps.minMargin);
		// render() uses the bare editor below this same inner-width threshold.
		// Mouse must see the identical viewport or a narrow click shifts columns.
		const editorWidth = editorWidthFor(boxWidth, this.deps.spinnerColumns?.() ?? 1);
		if (fallback || editorWidth < 4) {
			const result = base.call(this, event);
			if (event.type === "click" || result !== undefined) this.invalidateRawRenderCache();
			return result;
		}
		// The framed component is laid out at terminal width, while Editor.handleMouse
		// expects coordinates in the reduced raw-editor viewport.
		const frameLeft = leftMargin + 1 + GUTTER; // margin + left rail + left gutter
		// The frame keeps both content and autocomplete at the base editor's row
		// indices; only the horizontal viewport differs.
		const result = base.call(this, { ...event, x: mouse.x - frameLeft, width: editorWidth });
		if (event.type === "click" || result !== undefined) this.invalidateRawRenderCache();
		return result;
	}

	render(width: number): string[] {
		const { ctx, maxWidth, minMargin } = this.deps;

		const { fallback, boxWidth, leftMargin } = chooseBox(width, maxWidth, minMargin);
		// The panel spends two columns per side on the rails plus the chrome gutters,
		// so the editor renders at the reduced width. Too tiny to frame → fall back.
		const spinnerColumns = this.deps.spinnerColumns?.() ?? 1;
		const editorWidth = editorWidthFor(boxWidth, spinnerColumns);
		if (fallback || editorWidth < 4) return super.render(width);

		// Autocomplete suggestions can change asynchronously without changing the
		// editor text, so let the base editor render freely while its menu is open.
		// The normal steady state (including spinner-only redraws) reuses its raw
		// layout and therefore avoids a full grapheme/wrap pass every 90 ms.
		const canReuseRaw = !this.isShowingAutocomplete();
		const cached = this.rawRenderCache;
		const raw =
			canReuseRaw &&
			cached?.width === editorWidth &&
			cached.terminalRows === this.tui.terminal.rows &&
			cached.focused === this.focused &&
			cached.paddingX === this.getPaddingX()
				? cached.raw
				: super.render(editorWidth);
		if (canReuseRaw && raw !== cached?.raw) {
			this.rawRenderCache = {
				width: editorWidth,
				terminalRows: this.tui.terminal.rows,
				focused: this.focused,
				paddingX: this.getPaddingX(),
				raw,
			};
		}
		if (raw.length < 2) return raw;

		const theme = ctx.ui.theme;
		const border = (s: string) => theme.fg("muted", s);
		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const text = (s: string) => theme.fg("text", s);
		const muted = (s: string) => theme.fg("muted", s);
		const separator = dim(" · ");

		// pi-persona's label may carry a VS16 emoji (🗺️, ⚖️) whose terminal width is
		// ambiguous; normalize it so the box's right rail can't drift off the corner.
		const personaRaw = this.deps.getPersona();
		const persona = personaRaw ? stableEmojiWidth(personaRaw) : "";
		const cwd = shortCwd(ctx.cwd);
		const sessionName = this.deps.getSessionName();
		const contextUsage = this.deps.getContextUsage();
		// Capacity gets the signal color, not the adjacent cost estimate. Unknown
		// context stays quiet; known usage follows Pi's >70 / >90 thresholds.
		const level = usageLevel(contextUsage?.percent);
		const usageKnown = contextUsage?.tokens != null;
		const usageColor = !usageKnown ? "dim" : level === "critical" ? "error" : level === "warn" ? "warning" : "accent";
		const cost = this.deps.getCost();
		const runDelta = cost ? this.deps.getRunDelta?.() ?? "" : "";
		const waiting = this.deps.isWaitingForUser?.() ?? false;
		const working = this.deps.isWorking();
		const activeSpinnerRows = working ? this.deps.spinnerRows?.() : undefined;
		const spinnerColor = this.deps.spinnerColor?.();
		const colorSpinner = (value: string) => spinnerColor ? theme.style(value, { fg: spinnerColor }) : accent(value);
		const spinner = waiting ? theme.fg("warning", "?") : working ? colorSpinner(activeSpinnerRows?.[0] ?? this.deps.spinnerFrame()) : "";
		const branch = sanitizeInlineText(this.deps.getGitBranch?.() ?? "");
		const session = sanitizeInlineText(sessionName ?? "");
		// Identity is readable text; branch is the navigational accent, while
		// session metadata and separators recede without losing their labels.
		const withBranch = text(` ${cwd}`) + (branch ? separator + accent(branch) : "");
		// If the status row gets tight, keep the repository basename rather than
		// clipping the tail of its path into an unidentifiable ancestor prefix.
		const cwdSegments = cwd.split("/").filter(Boolean);
		const cwdBasename = cwdSegments[cwdSegments.length - 1];
		const compactCwd = cwdSegments.length > 1 && cwdBasename ? `…/${cwdBasename}` : cwd;
		// The left group gives up whole details, never characters of one: the
		// session name goes, then the branch, then the path down to its basename.
		// A branch is an identifier, so it is whole or absent. Only the session
		// name, free text, may shorten, and only down to SESSION_MIN_COLUMNS.
		const statusLeft: RowCandidate[] = [
			...(session ? [{ pre: withBranch + separator, flex: muted(session), minFlex: SESSION_MIN_COLUMNS }] : []),
			...(branch ? [{ pre: withBranch }] : []),
			{ pre: text(` ${cwd}`) },
		];
		if (compactCwd !== cwd) statusLeft.push({ pre: text(` ${compactCwd}`) });
		// Bash mode (leading `!`): the sigil flips to a `$` so the mode is visible
		// at the prompt itself. `!!` keeps the output out of the model's context,
		// and the host paints that block dim instead of bashMode: so does the sigil.
		const bash = bashInputMode(this.getText());
		const sigil = bash === "none" ? accent("›") : theme.fg(bash === "excluded" ? "dim" : "bashMode", "$");

		// The running call's label is painted over the workspace cells only, so its
		// arrival and departure never reflow usage, cost or persona. Sanitized again
		// here (with the persona label's VS16 discipline): the frame must stay exact
		// even if a caller hands it raw tool text.
		const activity = working && !waiting ? this.deps.getActivity?.() : undefined;
		const activityLabel = activity ? stableEmojiWidth(sanitizeInlineText(activity.label)) : "";
		// A long call says how long it has run, as stock Pi's "Elapsed" does, so a
		// quiet `npm test` does not read as hung. The spinner's repaint advances it.
		const elapsed = activity && activity.elapsedMs >= ACTIVITY_ELAPSED_MS ? formatElapsed(activity.elapsedMs) : "";
		const count = activity && activity.more > 0 ? ` +${activity.more}` : "";
		// Overlay rungs are tried whole and only the last trims, so the count yields
		// first, then the elapsed time, and only then does the label shorten: to
		// no fewer than ACTIVITY_MIN_COLUMNS, below which the workspace stays.
		const named: RowCandidate = { pre: " ", flex: text(activityLabel), minFlex: ACTIVITY_MIN_COLUMNS };
		const timed = elapsed ? [{ ...named, post: dim(` ${elapsed}${count}`) }, ...(count ? [{ ...named, post: dim(` ${elapsed}`) }] : [])]
			: count ? [{ ...named, post: dim(count) }] : [];
		// The run clock ("Working… 45s") names no call, so there is nothing to trim:
		// with its time, without it, or the workspace label as it was. A rung with
		// no flex part is shown whole or not at all.
		const clock: RowCandidate[] = [
			...(elapsed ? [{ pre: ` ${text(activityLabel)}${dim(` ${elapsed}`)}` }] : []),
			{ pre: ` ${text(activityLabel)}` },
		];
		const statusOverlay: RowCandidate[] | undefined = !activity || !activityLabel ? undefined : activity.run ? clock : [...timed, named];

		// The right group is the session's state: usage, cost, persona. Its core
		// narrows as one ladder; ornaments are decided first, against the full
		// left group, because layoutRow lets any right rung outrank left detail.
		const percent = contextUsage?.percent;
		const percentText = usageKnown && percent != null && Number.isFinite(percent) ? `${Math.round(percent)}%` : "";
		const tokensText = usageKnown ? formatTokens(contextUsage?.tokens ?? 0) : "";
		const windowText = tokensText ? formatContextWindow(contextUsage?.contextWindow) : "";
		// The piece that stands last: the percentage, else the bare token count,
		// else the quiet unknown marker. No usage at all (no model) shows none.
		const unknownUsage = contextUsage && !usageKnown ? dim("ctx —") : "";
		const join = (...parts: string[]) => parts.filter(Boolean).join(separator);
		// The subscription quota the provider reports, read from a view cached on
		// events. Labels and digits are generated in quota.ts, never copied from a
		// response. A calm figure nobody has confirmed for a while recedes to dim
		// (same width); a warning or critical one keeps its color however old.
		const quota = this.deps.getQuota?.();
		const quotaWindow = (window: QuotaViewWindow): string => dim(`${window.label} `) + theme.fg(
			window.level === "critical" ? "error" : window.level === "warn" ? "warning" : window.aged ? "dim" : "muted", `${window.percent}%`);
		// One window — the binding one — or `limit` in its place; and both windows.
		const quotaOne = quota?.limit ? theme.fg("error", quota.limit) : quota?.one && quota.binding ? quotaWindow(quota.binding) : "";
		const quotaTwo = quota?.two ? quota.windows.map(quotaWindow).join(separator) : "";
		// A hot window (or `limit`) is content and narrows with the core; a calm one is an ornament.
		const quotaCore: 0 | 1 = quotaOne && quota?.hot ? 1 : 0;
		const right = (shape: { tokens?: boolean; cost?: boolean; window?: boolean; delta?: boolean; gauge?: boolean; quota?: 0 | 1 | 2 }): string => {
			const tokens = tokensText ? theme.fg(usageColor, tokensText) + (shape.window && windowText ? dim(`/${windowText}`) : "") : "";
			const usage = percentText ? join(shape.tokens ? tokens : "", theme.fg(usageColor, percentText)) : tokens || unknownUsage;
			const money = shape.cost && cost ? muted(cost) + (shape.delta && runDelta ? dim(` ${runDelta}`) : "") : "";
			const limits = shape.quota === 2 && quotaTwo ? quotaTwo : shape.quota ? quotaOne : "";
			const body = join(usage, money, limits, persona ? text(persona) : "");
			if (!body) return "";
			const filled = Math.round(Math.max(0, Math.min(100, percent ?? 0)) / 20);
			const gauge = dim("[") + theme.fg(usageColor, "▰".repeat(filled)) + dim("▱".repeat(5 - filled)) + dim("]");
			return `${shape.gauge ? `${gauge} ` : ""}${body} `;
		};
		const statusWidth = boxWidth - 2 - statusSlotWidth(spinnerColumns, this.deps.spinnerHeight?.() ?? 1);
		const fullLeft = `${statusLeft[0].pre ?? ""}${statusLeft[0].flex ?? ""}`;
		// The full left group, this right rung and the one-column gap: exactly
		// when layoutRow keeps both at their widest.
		const fits = (rung: string) => visibleWidth(fullLeft) + visibleWidth(rung) + 1 <= statusWidth;
		// Ornaments never cost content. They surrender in a fixed order — run
		// delta, then window denominator, then the second quota window, then the
		// gauge, then a calm binding quota window — each shown only while the full
		// left and everything that outranks it still fit.
		const shape: { tokens: boolean; cost: boolean; window: boolean; delta: boolean; gauge: boolean; quota: 0 | 1 | 2 } =
			{ tokens: true, cost: true, window: false, delta: false, gauge: false, quota: quotaCore };
		const admit = (change: Partial<typeof shape>, present: boolean): boolean => {
			if (!present) return true;
			if (!fits(right({ ...shape, ...change }))) return false;
			Object.assign(shape, change);
			return true;
		};
		if (admit({ quota: 1 }, !!quotaOne && !quotaCore) && admit({ gauge: true }, !!percentText)
			&& admit({ quota: 2 }, !!quotaTwo) && admit({ window: true }, !!windowText)) admit({ delta: true }, !!runDelta);
		// Then the core: cost goes, then the token count, then the persona trims
		// and goes, then a hot quota window (or `limit`), and the percentage (in
		// its warning color past 70%) is the last standing: finally without its
		// pad, and below that nothing: the frame hard-truncates a last rung that
		// does not fit, and "71…" or "7…" reads as another number. A quota text
		// is never clipped either: whole or absent.
		const last = percentText ? theme.fg(usageColor, percentText) : tokensText ? theme.fg(usageColor, tokensText) : unknownUsage;
		const hotQuota = quotaCore ? quotaOne : "";
		const stand = join(last, hotQuota);
		const ladder: RowCandidate[] = [
			{ pre: right(shape) },
			{ pre: right({ tokens: true, cost: true, quota: quotaCore }) },
			{ pre: right({ tokens: true, quota: quotaCore }) },
			...(persona ? [{ pre: stand ? stand + separator : "", flex: text(persona), post: " " }] : []),
			...(hotQuota ? [{ pre: `${stand} ` }] : []),
			...(last ? [{ pre: `${last} ` }, { pre: last }] : hotQuota ? [{ pre: hotQuota }] : []),
		];
		const statusRight = ladder.filter((rung, i) => {
			const whole = `${rung.pre ?? ""}${rung.flex ?? ""}${rung.post ?? ""}`;
			const previous = ladder[i - 1];
			return whole.trim() !== "" && (!previous || whole !== `${previous.pre ?? ""}${previous.flex ?? ""}${previous.post ?? ""}`);
		});
		if (last || quotaOne) statusRight.push({}); // the empty rung always fits: whole or not at all

		// The border's one label is the model identity, top-right. Thinking level is
		// named only for a reasoning model, by Pi's own lowercase names, each in the
		// palette's thinking token: `off`, a missing level, and any text the host
		// did not define show nothing.
		// An id that sanitizes to nothing visible ("claude-", blanks, escapes,
		// zero-width) offers no rung at all: not an empty label, not "provider/ ".
		const modelText = stableEmojiWidth(cleanModel(ctx.model?.id));
		const model = modelText.trim() && visibleWidth(modelText.trim()) > 0 ? accent(modelText) : "";
		const provider = ctx.model?.provider ? stableEmojiWidth(sanitizeInlineText(ctx.model.provider)) : "";
		const thinkingLevel = ctx.model?.reasoning === true ? this.deps.getThinkingLevel?.() : undefined;
		const thinkingToken = thinkingColor(thinkingLevel);
		const levelTail = thinkingToken && thinkingLevel ? separator + theme.fg(thinkingToken, thinkingLevel) : "";
		// provider/model · level → model · level → model alone; only the model trims.
		const borderLabel: RowCandidate[] = !model ? [] : [
			...(provider ? [{ pre: `${dim(`${provider}/`)}${model}${levelTail}` }] : []),
			...(levelTail ? [{ flex: model, post: levelTail }] : []),
			{ flex: model },
		];
		return frameEditor(raw, {
			boxWidth,
			leftMargin,
			style: ROUNDED,
			border,
			borderLabel,
			prompt: sigil, // first-row left gutter
			spinner, // first-row right gutter (empty when idle)
			spinnerRows: waiting ? undefined : activeSpinnerRows?.map(colorSpinner),
			spinnerHeight: this.deps.spinnerHeight?.() ?? 1,
			spinnerColumns,
			statusLeft,
			statusOverlay,
			statusRight,
		});
	}
}

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => FramedEditor;

/** Build the `setEditorComponent` factory bound to live session state. */
export function makeFramedEditorFactory(deps: FramedEditorDeps): EditorFactory {
	return (tui, theme, keybindings) => new FramedEditor(tui, theme, keybindings, deps);
}
