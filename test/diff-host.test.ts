import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createSwitchableToolView } from "../src/tool-adapter.ts";
import { createToolView } from "../src/tool-view.ts";
import { stripAnsi, useTerminalMetrics } from "../src/width.ts";

// The real theme uses Chalk for bold; enable its TTY style in this headless fixture.
const previousColor = process.env.FORCE_COLOR;
process.env.FORCE_COLOR = "1";
const { createEditToolDefinition, generateDiffString, initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
if (previousColor === undefined) delete process.env.FORCE_COLOR;
else process.env.FORCE_COLOR = previousColor;
initTheme("dark", false);
useTerminalMetrics({ visibleWidth, truncateToWidth });

test("Pi 1.4 generated shifted diffs retain span emphasis, live widths and exact native toggle restoration", () => {
	const before = "anchor\nconst first = 'red'; const last = 'small';\ntail\n";
	const after = "inserted\nanchor\nconst first = 'green'; const last = 'large';\ntail\n";
	const details = generateDiffString(before, after);
	assert.match(details.diff, /-2 const first/);
	assert.match(details.diff, /\+3 const first/);
	const args = { path: "example.ts", oldText: before, newText: after };
	const baseline = createEditToolDefinition(process.cwd()) as ToolRenderers;
	let active = true;
	const renderers = createSwitchableToolView(createToolView("edit", () => "expand"), baseline, () => active,
		{ Box, Container, Text, toolName: "edit", expandHint: () => "expand" });
	const ui = { requestRender() {} } as TUI;
	const polished = new ToolExecutionComponent("edit", "polished", args, { outputPad: 1 }, renderers, ui, process.cwd());
	const native = new ToolExecutionComponent("edit", "native", args, { outputPad: 1 }, baseline, ui, process.cwd());
	const result = { content: [{ type: "text" as const, text: "Successfully updated example.ts" }], details, isError: false };
	polished.updateResult(result);
	native.updateResult(result);
	for (const expanded of [false, true]) {
		polished.setExpanded(expanded);
		native.setExpanded(expanded);
		const rows = polished.render(100);
		for (const word of ["red", "small", "green", "large"]) assert.ok(rows.some(row => row.includes(`\x1b[1m${word}\x1b[22m`)), word);
		assert.ok(rows.every(row => !/\x1b\[1m[^\x1b]*const/.test(row)));
		for (let width = 1; width <= 120; width++) for (const row of polished.render(width)) assert.ok(visibleWidth(row) <= width);
		active = false;
		polished.invalidate();
		for (const width of [12, 40, 100, 160]) assert.deepEqual(polished.render(width), native.render(width));
		active = true;
		polished.invalidate();
		assert.match(polished.render(100).map(stripAnsi).join("\n"), /Added 2 lines, removed 1 line/);
	}
	assert.equal(result.details, details);
	assert.equal(args.oldText, before);
});
