import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTitle, terminalTitle } from "../src/terminal-title.ts";

test("the default is Pi's own title, rebuilt from the same pieces", () => {
	assert.equal(defaultTitle(undefined, "pi-1337"), "π - pi-1337");
	assert.equal(defaultTitle("fold tallies", "pi-1337"), "π - fold tallies - pi-1337");
	assert.equal(terminalTitle({ phase: "idle", session: "fold tallies", cwdBase: "pi-1337" }), "π - fold tallies - pi-1337");
});

test("the state leads; the place is the session name, else the cwd basename", () => {
	assert.equal(terminalTitle({ phase: "running", label: "Running npm test…", cwdBase: "pi-1337" }), "● Running npm test… — pi-1337");
	assert.equal(terminalTitle({ phase: "running", cwdBase: "pi-1337", session: "fold tallies" }), "● Working — fold tallies");
	assert.equal(terminalTitle({ phase: "waiting", cwdBase: "pi-1337" }), "? Waiting for you — pi-1337");
	assert.equal(terminalTitle({ phase: "done", cwdBase: "pi-1337" }), "✓ Done — pi-1337");
	assert.equal(terminalTitle({ phase: "failed", cwdBase: "pi-1337" }), "✗ Failed — pi-1337");
	assert.equal(terminalTitle({ phase: "done", cwdBase: "" }), "✓ Done", "no place, no dangling separator");
});

test("a clean run with background work outstanding is not Done yet: it waits, naming one kind or counting several", () => {
	const work = (agents: number, monitors: number, timers: number, scripts: number) => ({ agents, monitors, timers, scripts });
	const done = (background?: ReturnType<typeof work>, session?: string) => terminalTitle({ phase: "done", background, session, cwdBase: "pi-1337" });
	assert.equal(done(work(3, 0, 0, 0)), "◌ Waiting on 3 agents — pi-1337");
	assert.equal(done(work(1, 0, 0, 0)), "◌ Waiting on 1 agent — pi-1337");
	assert.equal(done(work(0, 1, 0, 0)), "◌ Waiting on 1 monitor — pi-1337");
	assert.equal(done(work(0, 0, 2, 0)), "◌ Waiting on 2 timers — pi-1337");
	assert.equal(done(work(0, 0, 0, 1), "fold tallies"), "◌ Waiting on 1 script — fold tallies");
	assert.equal(done(work(3, 1, 1, 0)), "◌ Waiting on 5 background tasks — pi-1337");
	assert.equal(done(undefined), "✓ Done — pi-1337", "nothing outstanding: done");
	assert.equal(terminalTitle({ phase: "done", background: work(2, 0, 0, 0), cwdBase: "" }), "◌ Waiting on 2 agents", "no place, no dangling separator");
	// Only the done phase reads it: a run in progress, a prompt, a failure and idle are unchanged.
	const background = work(3, 1, 1, 1);
	assert.equal(terminalTitle({ phase: "running", background, cwdBase: "pi-1337" }), "● Working — pi-1337");
	assert.equal(terminalTitle({ phase: "waiting", background, cwdBase: "pi-1337" }), "? Waiting for you — pi-1337");
	assert.equal(terminalTitle({ phase: "failed", background, cwdBase: "pi-1337" }), "✗ Failed — pi-1337");
	assert.equal(terminalTitle({ phase: "idle", background, cwdBase: "pi-1337" }), "π - pi-1337");
});

test("foreign pieces are sanitized and bounded", () => {
	const title = terminalTitle({ phase: "running", label: `Running x\x07\x1b]0;evil\x07‮${"y".repeat(10_000)}`, session: "a\nb\x1b[31m", cwdBase: "r" });
	assert.doesNotMatch(title, /[\x00-\x1f\x7f-\x9f‪-‮]|evil/);
	assert.ok(title.length < 300, `bounded: ${title.length}`);
	assert.match(title, /^● Running xy+… — a b$/);
	assert.equal(defaultTitle("\x1b]0;x\x07", "repo"), "π - repo", "a name that sanitizes away is no name");
});
