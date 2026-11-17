import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRunRegistry, MIN_FOLD, messagePaintsRows, type ToolRunRegistry } from "../src/tool-groups.ts";

const assistantText = { role: "assistant", content: [{ type: "text", text: "done" }] };
const kinds = (runs: ToolRunRegistry, ids: string[]) => ids.map(id => runs.decisionFor(id).kind);

/** Start then end every call; `failed` ids end with isError. */
function settle(runs: ToolRunRegistry, calls: Array<[string, string]>, failed: string[] = []): void {
	for (const [id, name] of calls) runs.onToolStart(id, name);
	for (const [id] of calls) runs.settle(id, failed.includes(id));
}

test("a run folds once MIN_FOLD calls have settled, and the tally grows in place while the run is open", () => {
	assert.equal(MIN_FOLD, 3);
	const runs = createToolRunRegistry();
	const ids = ["a", "b", "c", "d", "e"];
	for (const id of ids.slice(0, 3)) runs.onToolStart(id, "read", { args: { path: `${id}.ts` } });
	runs.settle("a", false);
	runs.settle("b", false);
	assert.deepEqual(kinds(runs, ids), ["normal", "normal", "normal", "normal", "normal"], "two settled calls still read fine as rows");
	runs.settle("c", false);
	assert.deepEqual(kinds(runs, ids), ["hidden", "hidden", "summary", "normal", "normal"], "the third settles and the open run folds");
	assert.deepEqual(runs.decisionFor("c"), { kind: "summary", sentence: "Read 3 files", detailed: "Read a.ts, b.ts, c.ts" });
	runs.onToolStart("d", "grep", { args: { pattern: "TODO" } });
	assert.deepEqual(kinds(runs, ids), ["hidden", "hidden", "summary", "normal", "normal"], "a running call keeps its own row below the tally");
	runs.settle("d", false);
	assert.deepEqual(kinds(runs, ids), ["hidden", "hidden", "hidden", "summary", "normal"], "once settled it takes the tally over, in place");
	assert.deepEqual(runs.decisionFor("d"), { kind: "summary", sentence: "Read 3 files, searched 1 pattern", detailed: "Read a.ts, b.ts, c.ts · searched 1 pattern" });
	assert.equal(runs.decisionFor("a"), runs.decisionFor("b"), "hidden is a shared singleton");
	assert.equal(runs.decisionFor("ghost"), runs.decisionFor("ghost2"), "normal is a shared singleton");
	runs.onMessage(assistantText);
	runs.onToolStart("e", "read", { args: { path: "e.ts" } });
	runs.settle("e", false);
	assert.deepEqual(kinds(runs, ids), ["hidden", "hidden", "hidden", "summary", "normal"], "a call after the run closed starts a new run");
});

test("a row is hidden only while another row of its run renders the tally", () => {
	// Ends arrive in any order during a parallel batch: at every step, hidden rows imply exactly one tally.
	const runs = createToolRunRegistry();
	const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
	for (const id of ids) runs.onToolStart(id, "read", { args: { path: `${id}.ts` } });
	for (const [step, id] of ["p4", "p1", "p6", "p2", "p5", "p3"].entries()) {
		runs.settle(id, id === "p5");
		const now = kinds(runs, ids);
		const hidden = now.filter(kind => kind === "hidden").length;
		const tallies = now.filter(kind => kind === "summary").length;
		assert.equal(tallies, hidden > 0 || step >= 2 ? 1 : 0, `step ${step}: ${now.join(",")}`);
		if (hidden > 0) assert.ok(now.lastIndexOf("summary") > now.lastIndexOf("hidden"), `the tally follows the rows it stands for: ${now.join(",")}`);
	}
	assert.deepEqual(kinds(runs, ids), ["hidden", "hidden", "hidden", "hidden", "normal", "summary"], "the failed call keeps its row");
});

test("two calls never fold", () => {
	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "read"]]);
	runs.onMessage(assistantText);
	assert.deepEqual(kinds(runs, ["a", "b"]), ["normal", "normal"]);
});

test("bash, edit, custom tools and rows rendered elsewhere break the run and stay untracked", () => {
	for (const [breaker, rendersHere] of [["bash", true], ["edit", true], ["delegate", true], ["read", false]] as const) {
		const runs = createToolRunRegistry();
		runs.onToolStart("a", "read");
		runs.onToolStart("b", "read");
		runs.onToolStart("x", breaker, { rendersHere });
		runs.onToolStart("c", "read");
		runs.onToolStart("d", "read");
		for (const id of ["a", "b", "x", "c", "d"]) runs.settle(id, false);
		runs.closeAll();
		assert.deepEqual(kinds(runs, ["a", "b", "x", "c", "d"]), ["normal", "normal", "normal", "normal", "normal"],
			`${breaker} (rendersHere=${rendersHere}) splits 2+2 so neither half folds`);
	}
	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "read"], ["c", "read"], ["x", "bash"]]);
	assert.deepEqual(kinds(runs, ["a", "b", "c", "x"]), ["hidden", "hidden", "summary", "normal"], "the breaker itself closes the run");
});

test("failed calls stay in place, uncounted; the run folds only if enough successes remain", () => {
	const short = createToolRunRegistry();
	settle(short, [["a", "read"], ["b", "read"], ["c", "read"]], ["b"]);
	short.closeAll();
	assert.deepEqual(kinds(short, ["a", "b", "c"]), ["normal", "normal", "normal"], "two successes are not enough");

	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "grep"], ["c", "read"], ["d", "ls"], ["e", "find"]], ["b", "e"]);
	runs.closeAll();
	assert.deepEqual(kinds(runs, ["a", "b", "c", "d", "e"]), ["hidden", "normal", "hidden", "summary", "normal"],
		"the carrier is the last foldable call even when the tail failed");
	assert.deepEqual(runs.decisionFor("d"), { kind: "summary", sentence: "Read 2 files, listed 1 folder", detailed: "Read 2 files, listed 1 folder" }, "failures are not counted");
});

test("an image-bearing call stays in place while the rest of the run folds", () => {
	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "read"], ["c", "read"], ["d", "read"]]);
	runs.closeAll();
	assert.equal(runs.decisionFor("d").kind, "summary");
	runs.markImages("d");
	assert.deepEqual(kinds(runs, ["a", "b", "c", "d"]), ["hidden", "hidden", "summary", "normal"], "markImages invalidates the cached fold");
	assert.deepEqual(runs.decisionFor("c"), { kind: "summary", sentence: "Read 3 files", detailed: "Read 3 files" });
	runs.markImages("a");
	assert.deepEqual(kinds(runs, ["a", "b", "c", "d"]), ["normal", "normal", "normal", "normal"], "below MIN_FOLD again");
});

test("expand is one-way: the run's rows return for good", () => {
	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "read"], ["c", "read"]]);
	runs.closeAll();
	runs.expand("a");
	assert.deepEqual(kinds(runs, ["a", "b", "c"]), ["normal", "normal", "normal"]);
	runs.expand("c");
	runs.markImages("b");
	assert.deepEqual(kinds(runs, ["a", "b", "c"]), ["normal", "normal", "normal"], "a second expand does not re-collapse");
});

test("messages that paint a transcript row close the run", () => {
	const closers = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "let me look" }, { type: "toolCall", id: "t" }] },
		{ role: "custom", customType: "note", content: "hello", display: true },
		{ role: "user", content: "please continue" },
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
		assistantText,
	];
	// Two reads, the message, a third read: one run of three folds, two runs of 2 + 1 never do.
	const afterMessage = (message: unknown) => {
		const runs = createToolRunRegistry();
		settle(runs, [["a", "read"], ["b", "read"]]);
		runs.onMessage(message);
		settle(runs, [["c", "read"]]);
		return kinds(runs, ["a", "b", "c"]);
	};
	for (const message of closers) {
		assert.deepEqual(afterMessage(message), ["normal", "normal", "normal"], `closes the run: ${JSON.stringify(message)}`);
	}
	const keepers = [
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "t" }], stopReason: "toolUse" },
		{ role: "assistant", content: [{ type: "text", text: "  \n" }, { type: "thinking", thinking: " " }] },
		{ role: "custom", customType: "note", content: "hidden", display: false },
		"a string", null, undefined,
	];
	for (const message of keepers) {
		assert.deepEqual(afterMessage(message), ["hidden", "hidden", "summary"], `leaves the run open: ${JSON.stringify(message)}`);
	}
});

test("messagePaintsRows classifies host-painted messages", () => {
	assert.equal(messagePaintsRows({ role: "assistant", content: "plain string reply" }), true);
	assert.equal(messagePaintsRows({ role: "assistant", content: "   " }), false);
	assert.equal(messagePaintsRows({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }), true);
	for (const stopReason of ["length", "error", "aborted"]) {
		assert.equal(messagePaintsRows({ role: "assistant", content: [], stopReason }), true, stopReason);
	}
	assert.equal(messagePaintsRows({ role: "assistant", content: [], stopReason: "stop" }), false);
	assert.equal(messagePaintsRows({ role: "assistant" }), false);
	assert.equal(messagePaintsRows({ role: "user", content: [] }), true);
	assert.equal(messagePaintsRows({ role: "branchSummary", summary: "s" }), true);
	assert.equal(messagePaintsRows({ role: "custom", display: false }), false);
	assert.equal(messagePaintsRows({ role: "toolResult", display: true }), false);
	assert.equal(messagePaintsRows(42), false);
});

test("onMessage does not inspect messages while no run is open", () => {
	const runs = createToolRunRegistry();
	let reads = 0;
	const spy = { get role() { reads++; return "user"; } };
	runs.onMessage(spy);
	assert.equal(reads, 0);
	runs.onToolStart("a", "read");
	runs.onMessage(spy);
	assert.ok(reads > 0);
});

test("empty and duplicate ids are ignored, unknown ids are normal and inert", () => {
	const runs = createToolRunRegistry();
	assert.equal(runs.decisionFor("ghost").kind, "normal");
	runs.expand("ghost");
	runs.markImages("ghost");
	runs.settle("ghost", true);
	runs.onToolStart("", "read");
	runs.onToolStart("a", "read");
	runs.onToolStart("a", "read");
	runs.onToolStart("b", "read");
	settle(runs, [["c", "read"]]);
	runs.settle("a", false);
	runs.settle("b", false);
	runs.settle("a", true); // a replayed end must not turn a success into a failure
	runs.closeAll();
	assert.deepEqual(kinds(runs, ["a", "b", "c"]), ["hidden", "hidden", "summary"]);
	assert.deepEqual(runs.decisionFor("c"), { kind: "summary", sentence: "Read 3 files", detailed: "Read 3 files" }, "the duplicate start is not counted");
});

test("reset clears every run", () => {
	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "read"], ["c", "read"]]);
	runs.closeAll();
	runs.reset();
	assert.deepEqual(kinds(runs, ["a", "b", "c"]), ["normal", "normal", "normal"]);
	settle(runs, [["a", "read"], ["b", "read"], ["c", "read"]]);
	runs.closeAll();
	assert.equal(runs.decisionFor("c").kind, "summary", "reset ids are free to be tracked again");
});

test("a closed short run leaves no entries behind", () => {
	const runs = createToolRunRegistry();
	settle(runs, [["a", "read"], ["b", "read"]]);
	runs.closeAll();
	// Duplicate ids are ignored, so these starts can only register if the short
	// run's entries were dropped when it closed.
	settle(runs, [["a", "read"], ["b", "read"], ["c", "read"]]);
	runs.closeAll();
	assert.deepEqual(kinds(runs, ["a", "b", "c"]), ["hidden", "hidden", "summary"]);

	const kept = createToolRunRegistry();
	settle(kept, [["a", "read"], ["b", "read"], ["c", "read"]], ["c"]);
	kept.closeAll();
	settle(kept, [["a", "read"], ["b", "read"], ["c", "read"]]);
	kept.closeAll();
	assert.deepEqual(kinds(kept, ["a", "b", "c"]), ["normal", "normal", "normal"],
		"a closed run of MIN_FOLD calls stays tracked (it may still fold after markImages/expand), so its ids remain taken");
});

test("the tally counts distinct files and patterns from the calls' arguments", () => {
	const runs = createToolRunRegistry();
	const calls: [string, string, Record<string, unknown>][] = [
		["p1", "read", { path: "src/big.ts", offset: 0 }],
		["p2", "read", { path: "src/big.ts", offset: 200 }],
		["p3", "read", { path: "src\\big.ts", offset: 400 }],
		["p4", "grep", { pattern: "TODO", path: "src" }],
		["p5", "find", { pattern: "TODO", path: "test" }],
	];
	for (const [id, name, args] of calls) {
		runs.onToolStart(id, name, { args, cwd: "/work" });
		runs.settle(id, false);
	}
	runs.closeAll();
	assert.deepEqual(runs.decisionFor("p5"), { kind: "summary", sentence: "Read 1 file, searched 1 pattern", detailed: "Read big.ts · searched 1 pattern" });
	assert.equal(runs.decisionFor("p1").kind, "hidden", "five calls still fold as five rows");
});

test("the summary decision carries the counted sentence and the form that names the files", () => {
	const runs = createToolRunRegistry();
	const calls: [string, string, Record<string, unknown>][] = [
		["n1", "read", { path: "D:\\Repo\\src\\Width.ts" }],
		["n2", "ls", {}],
		["n3", "read", { path: "src/width.ts" }],
		["n4", "grep", { pattern: "TODO" }],
		["n5", "read", { path: "src/\x1b[2Jframe.ts" }],
	];
	for (const [id, name, args] of calls) {
		runs.onToolStart(id, name, { args, cwd: "D:/Repo" });
		runs.settle(id, false);
	}
	assert.deepEqual(runs.decisionFor("n5"), {
		kind: "summary",
		sentence: "Read 2 files, listed 1 folder, searched 1 pattern",
		detailed: "Read Width.ts, frame.ts · listed Repo · searched 1 pattern",
	}, "one file spelled two ways is named once, by its first spelling; ls without a path names the cwd");
	runs.onToolStart("n6", "read", { cwd: "D:/Repo" });
	runs.settle("n6", false);
	assert.deepEqual(runs.decisionFor("n6"), {
		kind: "summary",
		sentence: "Read 3 files, listed 1 folder, searched 1 pattern",
		detailed: "Read 3 files · listed Repo · searched 1 pattern",
	}, "a read without a path cannot be named, so its clause is counted");
});
