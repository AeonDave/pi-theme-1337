import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTIVITY_GRACE_MS, createActivityTracker, createRunClock, currentActivity, describeToolActivity, RUN_CLOCK_GRACE_MS, RUN_CLOCK_LABEL,
} from "../src/tool-activity.ts";

test("every built-in names its verb and a compact target", () => {
	assert.equal(describeToolActivity("bash", { command: "npm test\n--watch" }), "Running npm test…");
	assert.equal(describeToolActivity("read", { path: "/work/src/stats.py" }), "Reading stats.py…");
	assert.equal(describeToolActivity("edit", { path: "/work/src/stats.py" }), "Updating stats.py…");
	assert.equal(describeToolActivity("write", { path: "/work/CHANGELOG.md" }), "Writing CHANGELOG.md…");
	assert.equal(describeToolActivity("ls", { path: "/work/src/" }), "Listing src…");
	assert.equal(describeToolActivity("grep", { pattern: "TODO" }), "Searching “TODO”…");
	assert.equal(describeToolActivity("find", { pattern: "*.spec.ts" }), "Finding “*.spec.ts”…");
});

test("a call without a target reads as the bare verb", () => {
	assert.equal(describeToolActivity("bash", {}), "Running…");
	assert.equal(describeToolActivity("bash", { command: "\n  \n# only a comment\n" }), "Running…");
	assert.equal(describeToolActivity("read", { path: "" }), "Reading…");
	assert.equal(describeToolActivity("edit", undefined), "Updating…");
	assert.equal(describeToolActivity("write", { path: 42 }), "Writing…");
	assert.equal(describeToolActivity("ls", { path: "." }), "Listing…", "the current directory is not a target");
	assert.equal(describeToolActivity("ls", { path: "" }), "Listing…");
	assert.equal(describeToolActivity("ls", {}), "Listing…");
	assert.equal(describeToolActivity("grep", {}), "Searching…");
	assert.equal(describeToolActivity("find", { pattern: "" }), "Finding…");
});

test("bash names the first meaningful line, past comments and a leading cd", () => {
	assert.equal(describeToolActivity("bash", { command: "cd /repo && npm test" }), "Running npm test…");
	assert.equal(describeToolActivity("bash", { command: "cd \"C:\\my repo\"; npm run build" }), "Running npm run build…");
	assert.equal(describeToolActivity("bash", { command: "# run the suite\n\n  npm test -- --watch\nnpm run lint" }), "Running npm test -- --watch…");
	assert.equal(describeToolActivity("bash", { command: "cd /repo" }), "Running cd /repo…", "a bare cd is the command itself");
	assert.equal(describeToolActivity("bash", { command: "\r\nmake all\r\n" }), "Running make all…");
});

test("paths reduce to their basename in either slash direction", () => {
	assert.equal(describeToolActivity("read", { path: "C:\\work\\src\\a.ts" }), "Reading a.ts…");
	assert.equal(describeToolActivity("read", { path: "/work/src/a.ts" }), "Reading a.ts…");
	assert.equal(describeToolActivity("edit", { path: "D:/mixed\\dir/b.md" }), "Updating b.md…");
	assert.equal(describeToolActivity("ls", { path: "C:\\work\\" }), "Listing work…");
});

test("unknown tools name themselves; a name that sanitizes away reads Working", () => {
	assert.equal(describeToolActivity("webfetch", { url: "https://example.test/x" }), "Running webfetch…");
	assert.equal(describeToolActivity("constructor", {}), "Running constructor…", "lookup is not fooled by Object.prototype");
	assert.equal(describeToolActivity("", {}), "Working…");
	assert.equal(describeToolActivity("\u001b[2J\u0007", {}), "Working…");
	assert.equal(describeToolActivity("delegate", { agent: "research", task: "x", name: "alpha" }), "Running delegate…",
		"background launches get no waiting verb");
});

test("hostile text never survives into a label", () => {
	const hostile = [
		describeToolActivity("bash", { command: "\u001b[2J\u001b[Hnpm test" }),
		describeToolActivity("read", { path: "/x/\u001b]0;pwned\u0007stats.py" }),
		describeToolActivity("grep", { pattern: "\u202eevil\u202c" }),
		describeToolActivity("bash", { command: "echo a\u0000b\u009b31m" }),
		describeToolActivity("edit", { path: "/x/line\nbreak.ts" }),
		describeToolActivity("my\u001b[31mtool\ntwo", {}),
	];
	for (const label of hostile) {
		assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(label), `controls survived: ${JSON.stringify(label)}`);
		assert.ok(!label.includes("pwned"), `OSC payload survived: ${JSON.stringify(label)}`);
		assert.ok(label.endsWith("…"));
	}
	assert.equal(hostile[0], "Running npm test…", "printable text after a CSI survives");
	assert.equal(hostile[1], "Reading stats.py…", "an OSC title sequence is removed whole");
	assert.equal(hostile[2], "Searching “evil”…");
	assert.equal(hostile[4], "Updating line break.ts…", "the label stays one line");
});

test("trailing dots and ellipses collapse into the single visual ellipsis", () => {
	assert.equal(describeToolActivity("bash", { command: "echo waiting..." }), "Running echo waiting…");
	assert.equal(describeToolActivity("bash", { command: "sleep 5 …  " }), "Running sleep 5…");
	assert.equal(describeToolActivity("ls", { path: "/x/..." }), "Listing…");
	for (const label of [describeToolActivity("bash", { command: "echo waiting..." }), describeToolActivity("read", { path: "a.…" })]) {
		assert.equal(label.match(/…|\.\.\./gu)?.length, 1, `exactly one ellipsis: ${label}`);
	}
});

test("a multi-megabyte command is bounded before it is scanned", () => {
	const huge = "x".repeat(5 * 1024 * 1024);
	const started = performance.now();
	const label = describeToolActivity("bash", { command: `${huge}\nnpm test` });
	assert.ok(performance.now() - started < 250, "the label is built from a bounded prefix");
	assert.ok(label.length <= 600, `label stays bounded: ${label.length}`);
	assert.ok(label.startsWith("Running xxx") && label.endsWith("…"));
	// The bound is real, not just fast: a first command line beyond it is never seen.
	assert.equal(describeToolActivity("bash", { command: `${"\n".repeat(5000)}npm test` }), "Running…");
	assert.equal(describeToolActivity("read", { path: `${"a/".repeat(5000)}deep.ts` }), "Reading a…");
});

test("the tracker names nothing before the grace period and the oldest call at or after it", () => {
	const tracker = createActivityTracker();
	assert.equal(tracker.current(0), undefined);
	tracker.onStart("c1", "bash", { command: "npm test" }, 1000);
	assert.equal(tracker.current(1000), undefined, "a call that just started never flashes");
	assert.equal(tracker.current(1000 + ACTIVITY_GRACE_MS - 1), undefined);
	assert.deepEqual(tracker.current(1000 + ACTIVITY_GRACE_MS), { label: "Running npm test…", more: 0, elapsedMs: ACTIVITY_GRACE_MS });
	assert.deepEqual(tracker.current(60_000), { label: "Running npm test…", more: 0, elapsedMs: 59_000 });
	tracker.onEnd("c1");
	assert.equal(tracker.current(60_000), undefined);
});

test("the oldest call stays current while newer ones start and end", () => {
	const tracker = createActivityTracker();
	tracker.onStart("c1", "bash", { command: "npm test" }, 0);
	tracker.onStart("c2", "read", { path: "/a.ts" }, 100);
	tracker.onStart("c3", "grep", { pattern: "TODO" }, 200);
	assert.deepEqual(tracker.current(600), { label: "Running npm test…", more: 2, elapsedMs: 600 }, "more counts the other running calls");
	tracker.onEnd("c3");
	assert.deepEqual(tracker.current(700), { label: "Running npm test…", more: 1, elapsedMs: 700 });
	tracker.onStart("c4", "ls", { path: "/work" }, 800);
	assert.deepEqual(tracker.current(900), { label: "Running npm test…", more: 2, elapsedMs: 900 }, "a newer start never takes the label");
});

test("ending the current call promotes the next-oldest, gated by its own start time", () => {
	const tracker = createActivityTracker();
	tracker.onStart("c1", "bash", { command: "npm test" }, 0);
	tracker.onStart("c2", "read", { path: "/a.ts" }, 1000);
	tracker.onStart("c3", "edit", { path: "/b.ts" }, 1100);
	assert.deepEqual(tracker.current(1200), { label: "Running npm test…", more: 2, elapsedMs: 1200 });
	tracker.onEnd("c1");
	assert.equal(tracker.current(1200), undefined, "the promoted call has run only 200 ms");
	assert.deepEqual(tracker.current(1000 + ACTIVITY_GRACE_MS), { label: "Reading a.ts…", more: 1, elapsedMs: ACTIVITY_GRACE_MS });
});

test("elapsedMs is the named call's own age and switches with the label", () => {
	const tracker = createActivityTracker();
	tracker.onStart("c1", "bash", { command: "npm test" }, 1_000);
	tracker.onStart("c2", "bash", { command: "npm run lint" }, 4_000);
	assert.equal(tracker.current(15_000)?.elapsedMs, 14_000, "now − the oldest call's start");
	assert.equal(tracker.current(16_250)?.elapsedMs, 15_250, "it advances with the injected clock");
	tracker.onEnd("c1");
	assert.deepEqual(tracker.current(16_250), { label: "Running npm run lint…", more: 0, elapsedMs: 12_250 },
		"the next call reports its own elapsed time, not the ended call's");
});

test("the tracker ignores duplicate and empty ids, clears wholly, and stays bounded", () => {
	const tracker = createActivityTracker();
	tracker.onStart("c1", "read", { path: "/a.ts" }, 0);
	tracker.onStart("c1", "bash", { command: "echo replay" }, 5000);
	assert.deepEqual(tracker.current(ACTIVITY_GRACE_MS), { label: "Reading a.ts…", more: 0, elapsedMs: ACTIVITY_GRACE_MS },
		"a replayed start rewrites neither the label nor the start time");
	tracker.onStart("", "bash", { command: "ghost" }, 0);
	assert.deepEqual(tracker.current(ACTIVITY_GRACE_MS), { label: "Reading a.ts…", more: 0, elapsedMs: ACTIVITY_GRACE_MS }, "an empty id is not tracked");
	tracker.onEnd("missing");
	tracker.clear();
	assert.equal(tracker.current(10_000), undefined);
	for (let i = 0; i < 70; i++) tracker.onStart(`c${i}`, "read", { path: `/${i}.ts` }, i);
	// The six oldest fall off (a lost end event must not pin the label forever).
	assert.deepEqual(tracker.current(10_000), { label: "Reading 6.ts…", more: 63, elapsedMs: 9_994 });
	tracker.onEnd("c0");
	assert.deepEqual(tracker.current(10_000), { label: "Reading 6.ts…", more: 63, elapsedMs: 9_994 }, "ending an evicted call is a no-op");
	tracker.onEnd("c6");
	assert.deepEqual(tracker.current(10_000), { label: "Reading 7.ts…", more: 62, elapsedMs: 9_993 });
});

test("the run clock shows nothing for three seconds, then the run's own age against the injected clock", () => {
	const clock = createRunClock();
	assert.equal(RUN_CLOCK_GRACE_MS, 3000);
	assert.equal(clock.current(1_000_000), undefined, "no run: no clock");
	clock.start(10_000);
	assert.equal(clock.current(10_000), undefined);
	assert.equal(clock.current(10_000 + RUN_CLOCK_GRACE_MS - 1), undefined, "a quick reply never grows a counter");
	assert.deepEqual(clock.current(10_000 + RUN_CLOCK_GRACE_MS), { label: RUN_CLOCK_LABEL, more: 0, elapsedMs: RUN_CLOCK_GRACE_MS, run: true });
	assert.deepEqual(clock.current(55_999), { label: "Working…", more: 0, elapsedMs: 45_999, run: true }, "it advances with the clock it is read against");
	assert.equal(clock.current(9_000), undefined, "a clock that stepped backwards shows nothing");
	assert.equal(clock.current(Number.NaN), undefined);
	clock.stop();
	assert.equal(clock.current(1_000_000), undefined, "stopped at settlement");
	clock.stop(); // idempotent
	clock.start(Number.NaN);
	assert.equal(clock.current(1_000_000), undefined, "a start that is not a time is no start");
});

test("the clock is the run's: only a new start moves it, and it starts from nothing each run", () => {
	const clock = createRunClock();
	clock.start(0);
	assert.equal(clock.current(60_000)?.elapsedMs, 60_000);
	clock.stop();
	clock.start(100_000);
	assert.equal(clock.current(102_000), undefined, "the new run is two seconds old, not the last run's age");
	assert.equal(clock.current(104_000)?.elapsedMs, 4_000);
});

test("a named call takes the slot after its own grace period and the clock returns when none is named", () => {
	const tracker = createActivityTracker();
	const clock = createRunClock();
	clock.start(0);
	assert.equal(currentActivity(tracker, clock, 2_000), undefined, "a young run with no call shows the workspace");
	assert.deepEqual(currentActivity(tracker, clock, 45_000), { label: "Working…", more: 0, elapsedMs: 45_000, run: true });
	tracker.onStart("c1", "bash", { command: "npm test" }, 45_000);
	assert.deepEqual(currentActivity(tracker, clock, 45_000 + ACTIVITY_GRACE_MS - 1), { label: "Working…", more: 0, elapsedMs: 45_000 + ACTIVITY_GRACE_MS - 1, run: true },
		"a call inside its grace period does not blank the slot");
	assert.deepEqual(currentActivity(tracker, clock, 45_000 + ACTIVITY_GRACE_MS), { label: "Running npm test…", more: 0, elapsedMs: ACTIVITY_GRACE_MS },
		"the call's own label and age, not the run's");
	assert.ok(!("run" in currentActivity(tracker, clock, 50_000)!), "a named call is never marked as the clock");
	tracker.onEnd("c1");
	assert.deepEqual(currentActivity(tracker, clock, 52_000), { label: "Working…", more: 0, elapsedMs: 52_000, run: true }, "the clock returns with the run's whole age");
	// A fast call (shorter than its grace period) never interrupts the clock.
	tracker.onStart("c2", "read", { path: "/a.ts" }, 52_100);
	assert.equal(currentActivity(tracker, clock, 52_105)?.label, "Working…");
	tracker.onEnd("c2");
	// No clock: exactly the tracker (the run began while the redesign was off, or compaction).
	tracker.onStart("c3", "bash", { command: "npm test" }, 60_000);
	assert.equal(currentActivity(tracker, undefined, 60_100), undefined);
	assert.equal(currentActivity(tracker, undefined, 61_000)?.label, "Running npm test…");
	clock.stop();
	tracker.clear();
	assert.equal(currentActivity(tracker, clock, 90_000), undefined, "settled: nothing");
});
