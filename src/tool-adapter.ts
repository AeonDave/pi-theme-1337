import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Box, Component, Container, Text } from "@earendil-works/pi-tui";
import { sanitizeArtLine, sanitizeInlineText } from "./format.ts";
import type { GroupControl, GroupDecision } from "./tool-groups.ts";
import { createRunSummaryView, flatInnerWidth, flatRow, resultRole, statusRole, type FlatRow } from "./tool-view.ts";
import { clipTextRows, isImageProtocolLine, visibleWidth } from "./width.ts";

export interface ToolAdapterDependencies {
	Box: typeof Box;
	Container: typeof Container;
	Text: typeof Text;
	toolName: string;
	expandHint?: () => string;
	imagesSupported?: () => boolean;
	/**
	 * Folded exploration runs (presentation of the transcript itself). Only the
	 * polished lane's call slot consults it: the baseline lane always renders the host rows.
	 */
	groups?: GroupControl;
}

type Call = NonNullable<ToolRenderers["renderCall"]>;
type Context = Parameters<Call>[2];
type Theme = Parameters<Call>[1];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type MouseEvent = Parameters<NonNullable<Component["handleMouse"]>>[0];
type Lane = {
	renderers: ToolRenderers;
	state: Record<string, unknown>;
	call?: Component;
	result?: Component;
	lastCall?: Component;
	lastResult?: Component;
	callArgs?: unknown;
	callFallback?: Component;
	callFallbackTheme?: Theme;
	resultValue?: Result;
	resultFallback?: Component;
	resultFallbackKey?: { result: Result; expanded: boolean; showImages: boolean; imagesSupported: boolean; theme: Theme };
};
/**
 * One slot's shell, kept across frames so pi-tui's Box cache can hit, and the last
 * clip. The shell still renders every frame (children may change their own lines
 * silently); only an identical row of identical lines at the same width reuses the clip.
 */
type Slot = {
	shell?: Box | Container;
	lane?: Lane;
	children?: Component[];
	pad?: number;
	clip?: { width: number; input: string[]; output: string[] };
	flat?: FlatMemo;
};
/**
 * The flat shell's last frame: what it was composed from and the composed row.
 * The renderer's lines are copied, not kept by reference — a component may
 * rewrite its own array in place, and a memo holding that array would match
 * itself. The components are kept only to route a click to the one under it.
 */
type FlatMemo = {
	width: number;
	pad: unknown;
	theme: Theme;
	dot: string;
	connector: string;
	call: string[];
	result: string[];
	callChild: Component;
	resultChild: Component;
	row: FlatRow;
};
const empty: Component = { render: () => [], invalidate() {} };
const normal: GroupDecision = { kind: "normal" };
const noLines: string[] = [];
function sameLines(last: string[], lines: string[]): boolean {
	if (last.length !== lines.length) return false;
	for (let i = 0; i < lines.length; i++) if (last[i] !== lines[i]) return false;
	return true;
}

function allFit(lines: string[], width: number): boolean {
	for (const line of lines) if (!isImageProtocolLine(line) && visibleWidth(line) > width) return false;
	return true;
}

/**
 * A renderer's `render()` is typed `string[]`, but the lines are a third party's:
 * one that is not a string (`[undefined, "x"]`) must never reach a string method here.
 */
const isText = (line: unknown): line is string => typeof line === "string";
/** A line the flat shell can neither prefix nor clip: an image-protocol payload, or not text at all. */
const isUnframeable = (line: unknown): boolean => !isText(line) || isImageProtocolLine(line);

function clipOnce(slot: Slot, lines: string[], width: number): string[] {
	const last = slot.clip;
	if (last && last.width === width && sameLines(last.input, lines)) return last.output;
	// Measuring a styled line is the host ruler's fast path, truncating one is not:
	// rows that all fit (every row a well-behaved shell returns) are passed on as they are.
	// So is a self-framed row holding a line that is not text: the host hands those on
	// untouched too, and there is nothing here to measure (the host's Box turns them into text).
	const output = !lines.every(isText) || allFit(lines, width) ? lines : clipTextRows(lines, width);
	// Kept by reference: Box reuses an array only for identical lines, Container never does.
	slot.clip = { width, input: lines, output };
	return output;
}

/**
 * Pi fixes the shell when a row is constructed. Keep it self-owned forever and
 * switch the *contents*, not the descriptor, when /theme-1337 changes state.
 *
 * Both lanes receive every host callback, even when hidden: native renderers may
 * need their final callback to stop a partial-result timer. Each lane has its own
 * state and lastComponent slots, owned solely by the host's per-row state. No
 * execution data is changed and images remain entirely ToolExecutionComponent's.
 *
 * Call with next() as baseline. Wiring must gate isActive on hasUI + mode=tui,
 * and invalidate the TUI before requestRender(true) on either toggle. Exports
 * made from that active TUI inherit these renderers: Pi supplies no render-mode
 * discriminator. Missing/throwing hooks get safe generic text, not a clone of
 * Pi's private fallback formatter. Custom baseline self shells stay self-owned.
 */
export function createSwitchableToolView(
	polished: ToolRenderers,
	baseline: ToolRenderers | undefined,
	isActive: () => boolean,
	dependencies: ToolAdapterDependencies,
	stateKey: symbol = Symbol("pi1337-tool-row"),
): ToolRenderers {
	return createAdapter(polished, baseline, isActive, dependencies, stateKey);
}

/**
 * A third-party renderer in this package's flat shell. The content stays the
 * renderer's: there is ONE lane, so its hooks run once per host update with
 * the host's own `context.state` (never a copy, never reset by a toggle) and
 * its own `lastComponent`. Only the frame switches — while active, its call
 * lines follow one status dot and its result lines hang under `└`, with no
 * background fill and no padding rows; inactive, the same components sit in
 * the host's Box, recomposed exactly as for any baseline lane.
 *
 * The host box is kept, active or not, for what cannot be framed safely: a
 * renderer that declares `renderShell: "self"`, a result carrying image
 * content (the host paints those outside our shell) and a row whose renderer
 * emitted a terminal image-protocol line or a line that is not a string (for
 * the rest of that row's life).
 * Such rows never fold: `dependencies.groups` is ignored here.
 *
 * A row whose slots render no line takes none, in either state. Active, that
 * also covers slots holding only blank lines (the flat row drops them as
 * padding). Inactive it is the one case that cannot equal the host: the host's
 * default shell still prints its separator row above an empty box, and a
 * `renderShell: "self"` row is given that separator only together with at
 * least one line of its own — one blank row alone is not reachable from here.
 * Blank-only slots and a slot beside an empty one do match the host exactly.
 */
export function createFlatToolView(
	foreign: ToolRenderers,
	isActive: () => boolean,
	dependencies: ToolAdapterDependencies,
	stateKey: symbol = Symbol("pi1337-tool-row"),
): ToolRenderers {
	return createAdapter(undefined, foreign, isActive, dependencies, stateKey);
}

/** `polished === undefined`: one lane (the baseline's renderers) whose frame alone switches. */
function createAdapter(
	polished: ToolRenderers | undefined,
	baseline: ToolRenderers | undefined,
	isActive: () => boolean,
	dependencies: ToolAdapterDependencies,
	stateKey: symbol,
): ToolRenderers {
	const { Box, Container, Text } = dependencies;
	const groups = polished ? dependencies.groups : undefined;

	function fallbackCall(args: unknown, theme: Theme): Component {
		let json = "";
		try { json = JSON.stringify(args, null, 2) ?? ""; } catch { json = "[unavailable arguments]"; }
		return new Text(theme.fg("toolTitle", sanitizeInlineText(dependencies.toolName)) +
			(json ? `\n${json.split("\n").map(sanitizeArtLine).join("\n")}` : ""), 0, 0);
	}
	function fallbackResult(result: Result, context: Context, theme: Theme): Component {
		const lines: string[] = [];
		let lineCount = 0;
		const expanded = context.expanded;
		const append = (line: string) => {
			lineCount++;
			if (expanded || lines.length < 10) lines.push(sanitizeArtLine(line));
		};
		for (const block of result.content) {
			if (block.type === "text") {
				const text = block.text;
				let start = 0;
				for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
					lineCount++;
					if (expanded || lines.length < 10) lines.push(sanitizeArtLine(text.slice(start, end)));
					start = end + 1;
				}
				lineCount++;
				if (expanded || lines.length < 10) lines.push(sanitizeArtLine(text.slice(start)));
			} else if (block.type === "image" && !(context.showImages && dependencies.imagesSupported?.())) {
				append(`[image: ${sanitizeInlineText(block.mimeType)}]`);
			}
		}
		if (!expanded && lineCount > lines.length) lines.push(`… (${lineCount - lines.length} more lines; ${sanitizeInlineText(dependencies.expandHint?.() ?? "expand")})`);
		return lines.length ? new Text(theme.fg("toolOutput", lines.join("\n")), 0, 0) : empty;
	}

	function createRow(context: Context, theme: Theme) {
		// Two lanes keep a private state each. A framed third-party row has one lane, and
		// that lane owns the host's state object itself: no toggle can fork or reset it.
		const lanes: Lane[] = polished
			? [polished, baseline ?? {}].map(renderers => ({ renderers, state: {} }))
			: [{ renderers: baseline ?? {}, state: context.state }];
		const laneFor = (active: boolean): Lane => lanes[active ? 0 : lanes.length - 1]!;
		// The flat shell is only ever an option for a third-party row that leaves its frame to the host.
		const frames = !polished && baseline?.renderShell !== "self";
		let unframed = false; // this row's renderer emitted an image-protocol or non-string line: host box from then on
		let resultImages = false; // the host paints the current result's images outside our shell
		let flatShown = false; // the last frame of the call slot was the flat shell (mouse routing)
		let shell: Box | Container | undefined;
		let resultConsumedByCall = false;
		let summary: { view: Component; sentence: string; detailed: string; theme: Theme; context: Context } | undefined;
		const callSlot: Slot = {};
		const resultSlot: Slot = {};
		const resetSlots = () => {
			for (const slot of [callSlot, resultSlot]) {
				slot.shell = undefined;
				slot.lane = undefined;
				slot.children = undefined;
				slot.pad = undefined;
				slot.clip = undefined;
				slot.flat = undefined;
			}
		};
		// Read at paint time: Box samples its bgFn, so a state or theme change
		// repaints without a new shell (and a same-colored change stays cached).
		const background = (text: string) => {
			const ctx = row.context;
			return row.theme.bg(ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg", text);
		};
		// Rebuilt only for another lane, shell kind or child; addChild/setPaddingX
		// would drop Box's cache, so neither runs on an unchanged frame.
		// The children are compared in place: nothing is allocated on an unchanged frame.
		const renderSlot = (slot: Slot, lane: Lane, first: Component, second: Component | undefined, width: number): string[] => {
			const self = lane.renderers.renderShell === "self";
			const kept = slot.children;
			if (!slot.shell || slot.lane !== lane || (slot.shell instanceof Box) === self ||
				!kept || kept.length !== (second ? 2 : 1) || kept[0] !== first || kept[1] !== second) {
				const children = second ? [first, second] : [first];
				slot.shell = self ? new Container() : new Box(0, 1, background);
				for (const child of children) slot.shell.addChild(child);
				slot.lane = lane;
				slot.children = children;
				slot.pad = 0;
				slot.clip = undefined;
			}
			if (slot.shell instanceof Box) {
				// At impossibly narrow widths sacrifice padding, never the terminal's row boundary.
				const pad = Math.min(Math.max(0, Math.floor(row.context.outputPad)), Math.floor((width - 1) / 2));
				if (slot.pad !== pad) slot.shell.setPaddingX(slot.pad = pad);
			}
			return clipOnce(slot, slot.shell.render(width), width);
		};
		// The flat shell has no component of its own to keep: its children render at
		// the inner width every frame (they may change their lines silently) and the
		// composed row is reused while the width, the padding, the theme, both mark
		// roles and every line are last frame's. The marks are painted only when the
		// row is composed: like the renderer's own lines, they bake their colors, and
		// the host invalidates every row when the palette changes. Undefined when a
		// line carries an image-protocol payload or is not a string at all — that
		// row cannot be prefixed or clipped, so the host box takes it (its Box
		// paints a non-string line as the text it coerces to; nothing here throws).
		const renderFlat = (slot: Slot, call: Component, result: Component, width: number, resultOnly: boolean): string[] | undefined => {
			const ctx = row.context;
			const inner = flatInnerWidth(width, ctx.outputPad);
			const callLines = call === empty ? noLines : call.render(inner);
			const resultLines = result === empty ? noLines : result.render(inner);
			const dot = statusRole(ctx);
			const connector = resultRole(ctx);
			const last = slot.flat;
			if (last && last.width === width && last.pad === ctx.outputPad && last.theme === row.theme && last.dot === dot &&
				last.connector === connector && sameLines(last.call, callLines) && sameLines(last.result, resultLines)) {
				last.callChild = call;
				last.resultChild = result;
				return last.row.lines;
			}
			if (callLines.some(isUnframeable) || resultLines.some(isUnframeable)) {
				slot.flat = undefined;
				return undefined;
			}
			slot.flat = { width, pad: ctx.outputPad, theme: row.theme, dot, connector, call: callLines.slice(), result: resultLines.slice(),
				callChild: call, resultChild: result,
				row: flatRow(callLines, resultLines, width, ctx.outputPad, row.theme.fg(dot, "●"), row.theme.fg(connector, "└"), resultOnly) };
			return slot.flat.row.lines;
		};
		// A click lands on the renderer's own component, in that component's
		// coordinates; one on the lead or the side padding is the host's (it expands the row).
		const routeFlat = (event: MouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> => {
			const memo = callSlot.flat;
			if (!memo) return undefined;
			const { left, inner, call, result } = memo.row;
			const x = event.x - left;
			if (x < 0 || x >= inner || event.y < 0) return undefined;
			if (event.y < call.count) {
				return memo.callChild.handleMouse?.({ ...event, x, y: event.y + call.skipped, width: inner, height: call.total });
			}
			const y = event.y - call.count;
			if (y >= result.count) return undefined;
			return memo.resultChild.handleMouse?.({ ...event, x, y: y + result.skipped, width: inner, height: result.total });
		};
		// Folding is a polished-lane presentation of the live TUI. The HTML exporter
		// renders the call slot as partial, so an export never folds.
		const decision = (): GroupDecision => {
			const ctx = row.context;
			return groups && isActive() && !ctx.expanded && !ctx.isPartial
				? groups.decisionFor(ctx.toolCallId) : normal;
		};
		const getCall = (lane: Lane): Component => {
			if (lane.call) return lane.call;
			const currentTheme = row.theme;
			if (!lane.callFallback || lane.callFallbackTheme !== currentTheme) {
				lane.callFallback = fallbackCall(lane.callArgs, currentTheme);
				lane.callFallbackTheme = currentTheme;
			}
			return lane.callFallback;
		};
		const getResult = (lane: Lane): Component => {
			if (lane.result) return lane.result;
			if (!lane.resultValue) return empty;
			const ctx = row.context;
			const currentTheme = row.theme;
			const imagesSupported = !!(ctx.showImages && dependencies.imagesSupported?.());
			const key = lane.resultFallbackKey;
			if (!lane.resultFallback || !key || key.result !== lane.resultValue ||
				key.expanded !== ctx.expanded || key.showImages !== ctx.showImages ||
				key.imagesSupported !== imagesSupported || key.theme !== currentTheme) {
				lane.resultFallback = fallbackResult(lane.resultValue, ctx, currentTheme);
				lane.resultFallbackKey = { result: lane.resultValue, expanded: ctx.expanded,
					showImages: ctx.showImages, imagesSupported, theme: currentTheme };
			}
			return lane.resultFallback;
		};
		const row = {
			context, theme, lanes,
			resetResultConsumed() { resultConsumedByCall = false; },
			setResultImages(images: boolean) { resultImages = images; },
			resultComponent: {
				invalidate() {
					resetSlots();
					for (const lane of lanes) {
						lane.result?.invalidate();
						lane.resultFallback = undefined;
						lane.resultFallbackKey = undefined;
					}
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					const active = isActive();
					const lane = laneFor(active);
					// In the TUI the call slot owns both; the HTML export never folds, so
					// this slot needs no run decision of its own.
					if (resultConsumedByCall) return [];
					const result = getResult(lane);
					if (result === empty) return [];
					if (frames && active && !unframed && !resultImages) {
						const lines = renderFlat(resultSlot, empty, result, width, true);
						if (lines) return lines;
						unframed = true;
					}
					if (lane.renderers.renderShell === "self") return result.render(width);
					return renderSlot(resultSlot, lane, result, undefined, width);
				},
			},
			component: {
				invalidate() {
					summary = undefined;
					resetSlots();
					for (const lane of lanes) {
						lane.call?.invalidate();
						lane.result?.invalidate();
						lane.callFallback?.invalidate();
						lane.callFallback = undefined;
						lane.resultFallback = undefined;
						lane.resultFallbackKey = undefined;
					}
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					const active = isActive();
					const lane = laneFor(active);
					// Taken fresh each frame — the host re-renders every pass, so transitions are free.
					const fold = decision();
					flatShown = false;
					if (fold.kind !== "normal") {
						// The whole row is folded; the result slot must not resurrect it.
						resultConsumedByCall = true;
						shell = undefined;
						if (fold.kind === "hidden") return [];
						if (summary?.sentence !== fold.sentence || summary.detailed !== fold.detailed || summary.theme !== row.theme || summary.context !== row.context) {
							summary = { sentence: fold.sentence, detailed: fold.detailed, theme: row.theme, context: row.context,
								view: createRunSummaryView(fold.sentence, row.theme, row.context, dependencies.expandHint ?? (() => "expand"), fold.detailed) };
						}
						return summary.view.render(width);
					}
					if (frames && active && !unframed && !resultImages) {
						const flat = renderFlat(callSlot, getCall(lane), getResult(lane), width, false);
						if (flat) {
							shell = undefined;
							flatShown = true;
							if (lane.result || lane.resultValue) resultConsumedByCall = true;
							return flat;
						}
						unframed = true;
					}
					// Never clip terminal-image protocol bytes from a custom renderer.
					const result = getResult(lane);
					const lines = renderSlot(callSlot, lane, getCall(lane), result === empty ? undefined : result, width);
					shell = callSlot.shell;
					if (lane.result || lane.resultValue) resultConsumedByCall = true;
					return lines;
				},
				handleMouse(event) {
					if (groups && isActive() && event?.type === "click" && event.button === "left") {
						// A hidden row has no lines to click: it is only reached through the
						// last frame's layout, where it was the tally the user saw.
						const onTally = decision().kind !== "normal";
						// Any click on a run's row unfolds that run for good. On the tally it
						// brings the rows back; on a member row the host is about to expand
						// that row alone, and a row the user opened must never leave its
						// siblings hidden behind a tally nothing renders.
						groups.expand(row.context.toolCallId);
						if (onTally) return { handled: true };
					}
					if (flatShown) return routeFlat(event);
					return shell?.handleMouse(event);
				},
			} satisfies Component,
		};
		return row;
	}
	type Row = ReturnType<typeof createRow>;
	function getRow(context: Context, theme: Theme): Row {
		return context.state[stateKey] ??= createRow(context, theme);
	}
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const row = getRow(context, theme);
			row.context = context;
			row.theme = theme;
			for (const lane of row.lanes) {
				lane.callArgs = args;
				lane.callFallback = undefined;
				lane.callFallbackTheme = undefined;
				try {
					lane.lastCall = lane.renderers.renderCall?.(args, theme, { ...context, state: lane.state, lastComponent: lane.lastCall });
				} catch { lane.lastCall = undefined; }
				lane.call = lane.lastCall;
			}
			return row.component;
		},
		renderResult(result, options, theme, context) {
			const row = getRow(context, theme);
			row.context = context;
			row.theme = theme;
			row.resetResultConsumed();
			if (groups) {
				// The host renders image payloads outside our shell: a call carrying one
				// must never fold, or the images would orphan under an empty row.
				if (result.content.some(block => block.type === "image")) groups.markImages(context.toolCallId);
				// This row now shows its final result, so it may fold or carry a tally.
				if (!options.isPartial) groups.settle(context.toolCallId, context.isError);
			}
			// ...and for the same reason a third-party row carrying one keeps the host box.
			if (!polished) row.setResultImages(result.content.some(block => block.type === "image"));
			for (const lane of row.lanes) {
				lane.resultValue = result;
				lane.resultFallback = undefined;
				lane.resultFallbackKey = undefined;
				try {
					lane.lastResult = lane.renderers.renderResult?.(result, options, theme, { ...context, state: lane.state, lastComponent: lane.lastResult });
				} catch { lane.lastResult = undefined; }
				lane.result = lane.lastResult;
			}
			// TUI consumes both slots through the call component's one native Box; HTML
			// export renders call and result independently, so expose a result-only shell too.
			return row.resultComponent;
		},
	};
}
