import assert from "node:assert/strict";
import { test } from "node:test";
import { countSubagentsFromInput, countSubagentsFromResult } from "../src/subagents.ts";

test("countSubagentsFromInput counts a single delegated agent", () => {
	assert.equal(countSubagentsFromInput({ agent: "operator", task: "implement" }), 1);
});

test("countSubagentsFromInput counts parallel tasks", () => {
	assert.equal(
		countSubagentsFromInput({
			tasks: [
				{ agent: "scout", task: "scan" },
				{ agent: "operator", task: "review" },
			],
		}),
		2,
	);
});

test("countSubagentsFromInput ignores malformed or agent-less input", () => {
	assert.equal(countSubagentsFromInput({}), 0);
	assert.equal(countSubagentsFromInput({ task: "no agent" }), 0);
	assert.equal(countSubagentsFromInput({ tasks: [{ task: "no agent" }, { agent: "ok", task: "x" }] }), 1);
	assert.equal(countSubagentsFromInput(null), 0);
});

test("countSubagentsFromResult counts running views", () => {
	assert.equal(
		countSubagentsFromResult({
			details: {
				views: [
					{ agent: "scout", running: true },
					{ agent: "operator", running: true },
					{ agent: "done", running: false },
				],
			},
		}),
		2,
	);
});

test("countSubagentsFromResult returns 0 when all views are done", () => {
	assert.equal(countSubagentsFromResult({ details: { views: [{ agent: "x", running: false }] } }), 0);
});

test("countSubagentsFromResult returns undefined when there are no views", () => {
	assert.equal(countSubagentsFromResult({ details: {} }), undefined);
	assert.equal(countSubagentsFromResult({}), undefined);
});
