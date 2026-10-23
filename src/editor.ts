/**
 * FramedEditor — Pi's editor, re-housed in a centered rounded panel.
 *
 * It renders the real editor at a reduced inner width, then hands the raw lines
 * to `frameEditor` (pure) which drops Pi's open-sided rules and rebuilds a
 * continuous rounded box with a left margin. The box is capped at `maxWidth`
 * and centered, so on a wide terminal there is breathing room on both sides.
 *
 * The border is a clean unbroken outline; the chrome lives inside it. The first
 * row's gutters carry the `›` prompt sigil (left) and the working spinner
 * (right); a dedicated status row above the bottom edge carries the workspace
 * (left), token usage (center), and the live subagent count + model + persona
 * (right). All editing/keybinding behavior is the base `CustomEditor`'s — the
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
	agentCount,
	cleanModel,
	formatContext,
	type ContextUsageLike,
	isBashInput,
	sanitizeInlineText,
	shortCwd,
	stableEmojiWidth,
	usageLevel,
} from "./format.ts";
import { editorWidthFor, frameEditor, GUTTER, ROUNDED, statusSlotWidth, type RowCandidate } from "./frame.ts";
import { chooseBox, visibleWidth } from "./width.ts";

export interface FramedEditorDeps {
	ctx: ExtensionContext;
	getPersona: () => string | undefined;
	getSubagentCount: () => number;
	/** Live numeric agent count published by pi-persona, if any. */
	getAgents?: () => string | undefined;
	/** Current git branch from Pi's footer data (null = not a repo). */
	getGitBranch?: () => string | null | undefined;
	/** Cached outside render; session walks in the 90ms spinner path are forbidden. */
	getSessionName: () => string | undefined;
	getContextUsage: () => ContextUsageLike | undefined;
	getCost: () => string;
	isWorking: () => boolean;
	/** Static prompt state; takes precedence over the animated working spinner. */
	isWaitingForUser?: () => boolean;
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

		const model = cleanModel(ctx.model?.id);
		// pi-persona's label may carry a VS16 emoji (🗺️, ⚖️) whose terminal width is
		// ambiguous; normalize it so the box's right rail can't drift off the corner.
		const personaRaw = this.deps.getPersona();
		const persona = personaRaw ? stableEmojiWidth(personaRaw) : undefined;
		const cwd = shortCwd(ctx.cwd);
		const sessionName = this.deps.getSessionName();
		const contextUsage = this.deps.getContextUsage();
		const usage = formatContext(contextUsage); // tokens used · %
		// Capacity gets the signal color, not the adjacent cost estimate. Unknown
		// context stays quiet; known usage follows Pi's >70 / >90 thresholds.
		const level = usageLevel(contextUsage?.percent);
		const usageKnown = contextUsage?.tokens != null;
		const usageColor = !usageKnown ? "dim" : level === "critical" ? "error" : level === "warn" ? "warning" : "accent";
		const cost = this.deps.getCost();
		const provider = ctx.model?.provider ? sanitizeInlineText(ctx.model.provider) : undefined;
		// Prefer pi-persona's live agent count (covers strategy/council cores too, which the
		// delegate-only counter misses); fall back to the delegate count. Pure logic in format.ts.
		const { label } = agentCount(this.deps.getAgents?.(), this.deps.getSubagentCount());
		const agentLabel = label.trim() ? `${accent(label.trim())}  ` : "";
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
		const leftSuffix = `${branch ? separator + accent(branch) : ""}${session ? separator + muted(session) : ""}`;
		// If the status row gets tight, keep the repository basename rather than
		// clipping the tail of its path into an unidentifiable ancestor prefix.
		const cwdSegments = cwd.split("/").filter(Boolean);
		const cwdBasename = cwdSegments[cwdSegments.length - 1];
		const compactCwd = cwdSegments.length > 1 && cwdBasename ? `…/${cwdBasename}` : cwd;
		const statusLeft: RowCandidate[] = leftSuffix
			? [{ pre: text(` ${cwd}`), flex: leftSuffix }, { pre: text(` ${cwd}`) }]
			: [{ pre: text(` ${cwd}`) }];
		if (compactCwd !== cwd) statusLeft.push({ pre: text(` ${compactCwd}`) });
		// Bash mode (leading `!`): the sigil flips to a gold `$` so the mode is
		// visible at the prompt itself, not just in the output styling.
		const bash = isBashInput(this.getText());
		const sigil = bash ? theme.fg("bashMode", "$") : accent("›");

		const personaTail = persona ? separator + text(persona) : "";
		// Keep the existing provider → trimmed model → persona degradation ladder.
		const statusRight: RowCandidate[] = [
			{ pre: `${agentLabel}${provider ? dim(`${provider}/`) : ""}${accent(model)}${personaTail} ` },
			{ pre: agentLabel, flex: accent(model), post: `${personaTail} ` },
			...(persona ? [{ pre: agentLabel, post: `${text(persona)} ` }] : []),
		];
		let statusCenter = theme.fg(usageColor, usage) + (cost ? separator + muted(cost) : "");
		// A static five-cell capacity gauge is an ornament, never a reason to
		// drop data. Spend its eight columns only when all full labels still fit,
		// with normal segment gaps, in an interior at least 90 columns wide.
		const interior = boxWidth - 2 - statusSlotWidth(spinnerColumns, this.deps.spinnerHeight?.() ?? 1);
		const fullLeft = `${statusLeft[0].pre ?? ""}${statusLeft[0].flex ?? ""}`;
		const fullRight = statusRight[0].pre ?? "";
		const percent = contextUsage?.percent;
		if (
			usageKnown && percent != null && Number.isFinite(percent) && interior >= 90 &&
			visibleWidth(fullLeft) + visibleWidth(statusCenter) + visibleWidth(fullRight) + 8 + 2 <= interior
		) {
			const filled = Math.round(Math.max(0, Math.min(100, percent)) / 20);
			const gauge = dim("[") + theme.fg(usageColor, "▰".repeat(filled)) + dim("▱".repeat(5 - filled)) + dim("]");
			statusCenter = `${gauge} ${statusCenter}`;
		}
		return frameEditor(raw, {
			boxWidth,
			leftMargin,
			style: ROUNDED,
			border,
			prompt: sigil, // first-row left gutter
			spinner, // first-row right gutter (empty when idle)
			spinnerRows: waiting ? undefined : activeSpinnerRows?.map(colorSpinner),
			spinnerHeight: this.deps.spinnerHeight?.() ?? 1,
			spinnerColumns,
			statusLeft,
			statusCenter,
			// The provider/model slug ("anthropic/opus-4-6") keeps the same model id
			// unambiguous across providers (native vs openrouter etc.). As the terminal
			// narrows the segment degrades rung by rung (after the centered usage has
			// already been dropped): provider hidden → model trimmed with … → persona
			// alone when there is one, otherwise the model just keeps trimming.
			statusRight,
		});
	}
}

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => FramedEditor;

/** Build the `setEditorComponent` factory bound to live session state. */
export function makeFramedEditorFactory(deps: FramedEditorDeps): EditorFactory {
	return (tui, theme, keybindings) => new FramedEditor(tui, theme, keybindings, deps);
}
