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
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	agentCount,
	branchLabel,
	cleanModel,
	formatContext,
	type ContextUsageLike,
	isBashInput,
	sanitizeInlineText,
	shortCwd,
	stableEmojiWidth,
	usageLevel,
} from "./format.ts";
import { editorWidthFor, frameEditor, GUTTER, ROUNDED } from "./frame.ts";
import { chooseBox } from "./width.ts";

export interface FramedEditorDeps {
	ctx: ExtensionContext;
	getPersona: () => string | undefined;
	getSubagentCount: () => number;
	/** Live one-line agent summary from pi-persona (names + glyphs), if any. */
	getAgents?: () => string | undefined;
	/** Current git branch from Pi's footer data (null = not a repo). */
	getGitBranch?: () => string | null | undefined;
	/** Cached outside render; session walks in the 90ms spinner path are forbidden. */
	getSessionName: () => string | undefined;
	getContextUsage: () => ContextUsageLike | undefined;
	getCost: () => string;
	isWorking: () => boolean;
	spinnerFrame: () => string;
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
	 * Pi 0.85 adds mouse routing to Editor. Keep this optional at compile time
	 * because the package's compatibility range still includes 0.84, but forward
	 * to the host implementation when present so a click that moves the cursor
	 * cannot leave a spinner redraw on the old raw layout.
	 */
	handleMouse(event: unknown): unknown {
		this.invalidateRawRenderCache();
		const base = (CustomEditor.prototype as unknown as {
			handleMouse?: (this: FramedEditor, value: unknown) => unknown;
		}).handleMouse;
		if (!base || !event || typeof event !== "object") return undefined;
		const mouse = event as { x?: unknown; width?: unknown };
		if (typeof mouse.x !== "number" || typeof mouse.width !== "number") return base.call(this, event);
		const { fallback, boxWidth, leftMargin } = chooseBox(mouse.width, this.deps.maxWidth, this.deps.minMargin);
		if (fallback) return base.call(this, event);
		// The framed component is laid out at terminal width, while Editor.handleMouse
		// expects coordinates in the reduced raw-editor viewport.
		const editorWidth = editorWidthFor(boxWidth);
		const frameLeft = leftMargin + 1 + GUTTER; // margin + left rail + left gutter
		return base.call(this, { ...(event as Record<string, unknown>), x: mouse.x - frameLeft, width: editorWidth });
	}

	render(width: number): string[] {
		const { ctx, maxWidth, minMargin } = this.deps;

		const { fallback, boxWidth, leftMargin } = chooseBox(width, maxWidth, minMargin);
		// The panel spends two columns per side on the rails plus the chrome gutters,
		// so the editor renders at the reduced width. Too tiny to frame → fall back.
		const editorWidth = editorWidthFor(boxWidth);
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

		const model = cleanModel(ctx.model?.id);
		// pi-persona's label may carry a VS16 emoji (🗺️, ⚖️) whose terminal width is
		// ambiguous; normalize it so the box's right rail can't drift off the corner.
		const personaRaw = this.deps.getPersona();
		const persona = personaRaw ? stableEmojiWidth(personaRaw) : undefined;
		const cwd = shortCwd(ctx.cwd);
		const sessionName = this.deps.getSessionName();
		const contextUsage = this.deps.getContextUsage();
		const usage = formatContext(contextUsage); // tokens used · %
		// Escalate the usage color with the footer's thresholds so approaching
		// auto-compact is visible: muted → warning (>70%) → error (>90%).
		const level = usageLevel(contextUsage?.percent);
		const usageColor = level === "critical" ? "error" : level === "warn" ? "warning" : "muted";
		const cost = this.deps.getCost();
		const provider = ctx.model?.provider ? sanitizeInlineText(ctx.model.provider) : undefined;
		// Prefer pi-persona's live agent count (covers strategy/council cores too, which the
		// delegate-only counter misses); fall back to the delegate count. Pure logic in format.ts.
		const { label } = agentCount(this.deps.getAgents?.(), this.deps.getSubagentCount());
		const agentLabel = label.trim() ? `${accent(label.trim())}  ` : "";
		const spinner = this.deps.isWorking() ? accent(this.deps.spinnerFrame()) : "";
		const branch = branchLabel(this.deps.getGitBranch?.());
		// Bash mode (leading `!`): the sigil flips to a gold `$` so the mode is
		// visible at the prompt itself, not just in the output styling.
		const bash = isBashInput(this.getText());
		const sigil = bash ? theme.fg("bashMode", "$") : accent("›");

		const personaTail = persona ? dim(` · ${persona}`) : "";
		return frameEditor(raw, {
			boxWidth,
			leftMargin,
			style: ROUNDED,
			border,
			prompt: sigil, // first-row left gutter
			spinner, // first-row right gutter (empty when idle)
			statusLeft: dim(` ${cwd}${branch}${branchLabel(sessionName)}`),
			statusCenter: theme.fg(usageColor, `${usage}${cost ? ` · ${cost}` : ""}`), // usage (+ cost), centered
			// The provider/model slug ("anthropic/opus-4-6") keeps the same model id
			// unambiguous across providers (native vs openrouter etc.). As the terminal
			// narrows the segment degrades rung by rung (after the centered usage has
			// already been dropped): provider hidden → model trimmed with … → persona
			// alone when there is one, otherwise the model just keeps trimming.
			statusRight: [
				{ pre: `${agentLabel}${provider ? dim(`${provider}/`) : ""}${accent(model)}${personaTail} ` },
				{ pre: agentLabel, flex: accent(model), post: `${personaTail} ` },
				...(persona ? [{ pre: agentLabel, post: `${dim(persona)} ` }] : []),
			],
		});
	}
}

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => FramedEditor;

/** Build the `setEditorComponent` factory bound to live session state. */
export function makeFramedEditorFactory(deps: FramedEditorDeps): EditorFactory {
	return (tui, theme, keybindings) => new FramedEditor(tui, theme, keybindings, deps);
}
