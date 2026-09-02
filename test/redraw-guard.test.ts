import assert from "node:assert/strict";
import test from "node:test";
import { forceFullRedraw, installOutOfBandRedrawGuard, type RedrawWritable } from "../src/redraw-guard.ts";

test("passes stderr writes through unchanged and coalesces a full-redraw request", () => {
	const writes: unknown[][] = [];
	const scheduled: Array<() => void> = [];
	const sink: RedrawWritable = {
		write(...args: unknown[]): boolean {
			assert.equal(this, sink);
			writes.push(args);
			return false;
		},
	};
	let redraws = 0;
	const dispose = installOutOfBandRedrawGuard(sink, () => redraws++, (task) => scheduled.push(task));

	assert.equal(sink.write("warning one", "utf8"), false);
	assert.equal(sink.write("warning two"), false);
	assert.deepEqual(writes, [["warning one", "utf8"], ["warning two"]]);
	assert.equal(scheduled.length, 1, "one event-loop redraw repairs the whole write burst");
	assert.equal(redraws, 0, "raw output is written before the redraw");

	scheduled.shift()?.();
	assert.equal(redraws, 1);

	dispose();
	assert.equal(sink.write("after dispose"), false);
	assert.deepEqual(writes.at(-1), ["after dispose"]);
	assert.equal(scheduled.length, 0);
});

test("dispose never overwrites a writer installed after the guard", () => {
	const scheduled: Array<() => void> = [];
	const original = function (this: RedrawWritable, _chunk: unknown): boolean {
		return true;
	};
	const sink: RedrawWritable = { write: original };
	let redraws = 0;
	const dispose = installOutOfBandRedrawGuard(sink, () => redraws++, (task) => scheduled.push(task));
	const guarded = sink.write;
	const laterWriter = function (this: RedrawWritable, ...args: unknown[]): boolean {
		return Reflect.apply(guarded, this, args) as boolean;
	};
	sink.write = laterWriter;

	dispose();
	assert.equal(sink.write, laterWriter);
	assert.equal(sink.write("still passes through"), true);
	for (const task of scheduled.splice(0)) task();
	assert.equal(redraws, 0, "an inactive guard cannot redraw through a later wrapper");
});

test("forceFullRedraw resets Pi's differential renderer state", () => {
	const calls: Array<boolean | undefined> = [];
	forceFullRedraw({ requestRender: (force) => calls.push(force) });
	forceFullRedraw(undefined);
	assert.deepEqual(calls, [true]);
});

test("the default repair runs after the raw burst and coalesces it", async () => {
	const order: string[] = [];
	const sink: RedrawWritable = {
		write(): boolean {
			order.push("raw-write");
			return true;
		},
	};
	const dispose = installOutOfBandRedrawGuard(sink, () => order.push("force-redraw"));

	assert.equal(sink.write("warning"), true);
	assert.equal(sink.write("same burst"), true);
	assert.deepEqual(order, ["raw-write", "raw-write"], "foreign bytes are visible before the repair");
	await Promise.resolve();
	assert.deepEqual(order, ["raw-write", "raw-write", "force-redraw"]);
	dispose();
});

test("a failed cosmetic repair never changes the foreign writer result", () => {
	const sink: RedrawWritable = { write: () => false };
	const dispose = installOutOfBandRedrawGuard(sink, () => {
		throw new Error("stopped tui");
	});

	assert.doesNotThrow(() => assert.equal(sink.write("warning"), false));
	dispose();
});
