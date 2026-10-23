import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Box, Component, Container, Text } from "@earendil-works/pi-tui";
import { sanitizeArtLine, sanitizeInlineText } from "./format.ts";
import { truncateToWidth } from "./width.ts";

export interface ToolAdapterDependencies {
	Box: typeof Box;
	Container: typeof Container;
	Text: typeof Text;
	toolName: string;
	expandHint?: () => string;
	imagesSupported?: () => boolean;
}

type Call = NonNullable<ToolRenderers["renderCall"]>;
type Context = Parameters<Call>[2];
type Theme = Parameters<Call>[1];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
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
const empty: Component = { render: () => [], invalidate() {} };

/**
 * Pi fixes the shell when a row is constructed. Keep it self-owned forever and
 * switch the *contents*, not the descriptor, when /pi-1337 changes state.
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
	const { Box, Container, Text } = dependencies;

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
		const lanes: [Lane, Lane] = [polished, baseline ?? {}].map(renderers => ({ renderers, state: {} })) as [Lane, Lane];
		let shell: Box | Container | undefined;
		let resultConsumedByCall = false;
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
			resultComponent: {
				invalidate() {
					for (const lane of lanes) {
						lane.result?.invalidate();
						lane.resultFallback = undefined;
						lane.resultFallbackKey = undefined;
					}
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					const lane = lanes[isActive() ? 0 : 1];
					if (resultConsumedByCall) return [];
					const result = getResult(lane);
					if (result === empty) return [];
					if (lane.renderers.renderShell === "self") return result.render(width);
					const ctx = row.context;
					const bg = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
					const pad = Math.min(Math.max(0, Math.floor(ctx.outputPad)), Math.floor((width - 1) / 2));
					const resultShell = new Box(pad, 1, text => row.theme.bg(bg, text));
					resultShell.addChild(result);
					return resultShell.render(width).map(line =>
						line.includes("\x1b_G") || line.includes("\x1b]1337;File=") ? line : truncateToWidth(line, width, ""));
				},
			},
			component: {
				invalidate() {
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
					const lane = lanes[isActive() ? 0 : 1];
					const ctx = row.context;
					const bg = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
					// At impossibly narrow widths sacrifice padding, never the terminal's row boundary.
					const pad = Math.min(Math.max(0, Math.floor(ctx.outputPad)), Math.floor((width - 1) / 2));
					shell = lane.renderers.renderShell === "self" ? new Container() :
						new Box(pad, 1, text => row.theme.bg(bg, text));
					for (const child of [getCall(lane), getResult(lane)]) if (child !== empty) shell.addChild(child);
					const lines = shell.render(width).map(line =>
						// Never clip terminal-image protocol bytes from a custom renderer.
						line.includes("\x1b_G") || line.includes("\x1b]1337;File=") ? line : truncateToWidth(line, width, ""));
					if (lane.result || lane.resultValue) resultConsumedByCall = true;
					return lines;
				},
				handleMouse(event) { return shell?.handleMouse(event); },
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
