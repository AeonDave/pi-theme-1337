import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalMinutes, EMPTY_QUOTA, isUsageLimitMessage, nextQuota, nextQuotaEvent, nextQuotaMessage, parseQuotaEvent, parseQuotaHeaders,
	quotaFamily, quotaLabel, quotaView, QUOTA_STALE_MS,
	type QuotaState, type QuotaView, type QuotaWindow,
} from "../src/quota.ts";

const NOW = Date.UTC(2026, 10, 17, 12);
const NOW_S = NOW / 1000;
const HOUR_S = 3600;
const DAY_S = 86400;
const MINUTE = 60_000;
const ANTHROPIC = "anthropic-messages";
const CODEX = "openai-codex-responses";

/** One real response, names and values exactly as received (status 200, api "anthropic-messages"). */
const OBSERVED = {
	"anthropic-ratelimit-unified-7d-utilization": "0.81",
	"anthropic-ratelimit-unified-7d-reset": "1795316400",
	"anthropic-ratelimit-unified-7d-status": "allowed_warning",
	"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
	"anthropic-ratelimit-unified-representative-claim": "seven_day",
	"anthropic-ratelimit-unified-reset": "1795316400",
	"anthropic-ratelimit-unified-status": "allowed_warning",
	"anthropic-ratelimit-unified-fallback-percentage": "0.5",
	"anthropic-ratelimit-unified-overage-status": "rejected",
	"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
	"anthropic-ratelimit-unified-upgrade-paths": "overage",
};

/** The error an assistant message ended with on OpenAI's ChatGPT route at the account's limit, exactly as received. */
const OBSERVED_LIMIT = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";

/** The stream event Pi's own Codex stream test replays (pi packages/ai/test/openai-codex-stream.test.ts). */
const FIXTURE_EVENT = {
	type: "codex.rate_limits",
	plan_type: "plus",
	rate_limits: {
		allowed: true,
		limit_reached: false,
		primary: { used_percent: 7, window_minutes: 10080, reset_after_seconds: 556112, reset_at: 1785269351 },
		secondary: null,
	},
	code_review_rate_limits: null,
	additional_rate_limits: null,
	credits: { has_credits: false, unlimited: false, balance: "0" },
	promo: null,
};

const WEEK_5H = { "anthropic-ratelimit-unified-5h-utilization": "0.43", "anthropic-ratelimit-unified-7d-utilization": "0.12" };

/** The percent an Anthropic weekly utilization value parses to, or undefined when it is rejected. */
const utilization = (value: unknown): number | undefined =>
	parseQuotaHeaders({ "anthropic-ratelimit-unified-7d-utilization": value }, ANTHROPIC, NOW)?.windows[0]?.percent;

/** The percent a Codex used-percent value parses to, or undefined when it is rejected. */
const usedPercent = (value: unknown): number | undefined =>
	parseQuotaHeaders({ "x-codex-primary-used-percent": value, "x-codex-primary-window-minutes": "300" }, CODEX, NOW)?.windows[0]?.percent;

/** The label a Codex window-minutes value earns, or undefined when the window is dropped. */
const minutesLabel = (value: unknown): string | undefined =>
	parseQuotaHeaders({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": value }, CODEX, NOW)?.windows[0]?.label;

const window = (minutes: number, label: string, percent: number, resetAtMs?: number, seenAtMs = NOW): QuotaWindow =>
	({ minutes, label, percent, ...(resetAtMs === undefined ? {} : { resetAtMs }), seenAtMs });

function stateOf(headers: unknown, api = ANTHROPIC, provider = "sub", at = NOW): QuotaState {
	const state = nextQuota(undefined, { status: 200, headers, api, provider }, at);
	assert.equal(state.accounts.length, 1, "the fixture must parse");
	return state;
}

const SUB = { provider: "sub", api: ANTHROPIC };
const shape = (view: QuotaView | undefined) => view?.windows.map((item) => [item.label, item.percent, item.level]);
/** What the row would print: the limit, else the two-window form, else the one-window form. */
const shown = (view: QuotaView | undefined) => view === undefined ? undefined : view.limit || view.two || view.one;
const assistant = (fields: Record<string, unknown> = {}) => ({ role: "assistant", provider: "sub", stopReason: "stop", ...fields });
const limitMessage = (fields: Record<string, unknown> = {}) => assistant({ stopReason: "error", errorMessage: OBSERVED_LIMIT, ...fields });

/** Strings that are not the plain decimal or integer a quota header must be. */
const MALFORMED_NUMBERS: readonly string[] = [
	"", " ", "+0.5", "-0.5", "-0", "5e-1", "1e0", "0x1", "0b1", ".5", "5.", "0..5", "0.5.1", " 0.5", "0.5 ", "\t0.5", "0.5\n", "0.5\r\n",
	"0.5%", "0.5abc", "abc", "0,5", "1_0", "00.5", "01", "NaN", "nan", "Infinity", "-Infinity", "inf", "null", "undefined", "true",
	"０.５", "٠.٥", "0.5\u0000", "\u001b[31m0.5", "0.111111111111111111111", `0.${"1".repeat(39)}`, "1".repeat(41),
];

const NOT_STRINGS: readonly unknown[] = [0.5, 50, 300, 0, null, undefined, true, ["0.5"], { toString: () => "0.5" }, new String("0.5"), 5n, Symbol("0.5")];

test("the observed Anthropic response reads as one weekly window at 81%", () => {
	const snapshot = parseQuotaHeaders(OBSERVED, ANTHROPIC, NOW);
	assert.deepEqual(snapshot, { family: "anthropic", windows: [window(10080, "wk", 81, 1795316400 * 1000)] });
	assert.equal(new Date(1795316400 * 1000).toISOString(), "2026-11-22T03:00:00.000Z", "reset is epoch seconds");

	const view = quotaView(stateOf(OBSERVED), SUB, NOW);
	const wk = { label: "wk", percent: 81, level: "warn", text: "wk 81%", aged: false };
	assert.deepEqual(view, { windows: [wk], binding: wk, hot: true, aged: false, limited: false, two: "", one: "wk 81%", limit: "" });
});

test("Anthropic: one window or two, shortest first, without or with resets", () => {
	assert.deepEqual(parseQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.43" }, ANTHROPIC, NOW), {
		family: "anthropic",
		windows: [window(300, "5h", 43)],
	});
	const both = parseQuotaHeaders({
		"anthropic-ratelimit-unified-7d-utilization": "0.81",
		"anthropic-ratelimit-unified-7d-reset": String(NOW_S + 5 * DAY_S),
		"anthropic-ratelimit-unified-5h-utilization": "0.43",
		"anthropic-ratelimit-unified-5h-reset": String(NOW_S + 2 * HOUR_S),
	}, ANTHROPIC, NOW);
	assert.deepEqual(both, {
		family: "anthropic",
		windows: [window(300, "5h", 43, NOW + 2 * HOUR_S * 1000), window(10080, "wk", 81, NOW + 5 * DAY_S * 1000)],
	});
});

test("Anthropic: only the closed window set is read", () => {
	assert.equal(parseQuotaHeaders({
		"anthropic-ratelimit-unified-utilization": "0.5",
		"anthropic-ratelimit-unified-1h-utilization": "0.5",
		"anthropic-ratelimit-unified-7d_opus-utilization": "0.5",
		"anthropic-ratelimit-unified-overage-utilization": "0.5",
		"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
		"anthropic-ratelimit-unified-fallback-percentage": "0.5",
		"anthropic-ratelimit-unified-reset": String(NOW_S + HOUR_S),
		"Anthropic-Ratelimit-Unified-7d-Utilization": "0.5",
	}, ANTHROPIC, NOW), undefined);
});

test("Codex: a window is labelled from its declared duration, never from its slot", () => {
	const two = parseQuotaHeaders({
		"x-codex-primary-used-percent": "43.2",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": String(NOW_S + HOUR_S),
		"x-codex-secondary-used-percent": "81",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-at": String(NOW_S + 3 * DAY_S),
	}, CODEX, NOW);
	assert.deepEqual(two, {
		family: "codex",
		windows: [window(300, "5h", 43, NOW + HOUR_S * 1000), window(10080, "wk", 81, NOW + 3 * DAY_S * 1000)],
	});

	// The weekly window in the primary slot, no secondary at all.
	assert.deepEqual(parseQuotaHeaders({
		"x-codex-primary-used-percent": "12.0",
		"x-codex-primary-window-minutes": "10080",
	}, "openai-responses", NOW), { family: "codex", windows: [window(10080, "wk", 12)] });

	// Slots reversed: still shortest first.
	const reversed = parseQuotaHeaders({
		"x-codex-primary-used-percent": "81",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-secondary-used-percent": "43",
		"x-codex-secondary-window-minutes": "300",
	}, CODEX, NOW);
	assert.deepEqual(reversed?.windows.map((item) => item.label), ["5h", "wk"]);
});

test("Codex: two slots of the same duration keep the fuller one; a tie keeps the one that knows its reset, then the first", () => {
	const headers = {
		"x-codex-primary-used-percent": "20",
		"x-codex-primary-window-minutes": "300",
		"x-codex-secondary-used-percent": "60",
		"x-codex-secondary-window-minutes": "300",
		"x-codex-secondary-reset-at": String(NOW_S + HOUR_S),
	};
	assert.deepEqual(parseQuotaHeaders(headers, CODEX, NOW)?.windows, [window(300, "5h", 60, NOW + HOUR_S * 1000)]);
	const swapped = { ...headers, "x-codex-primary-used-percent": "60", "x-codex-secondary-used-percent": "20" };
	assert.deepEqual(parseQuotaHeaders(swapped, CODEX, NOW)?.windows, [window(300, "5h", 60)]);

	// Equal percent, same duration: the dated reading wins from either slot.
	const tied = { ...headers, "x-codex-primary-used-percent": "60" };
	assert.deepEqual(parseQuotaHeaders(tied, CODEX, NOW)?.windows, [window(300, "5h", 60, NOW + HOUR_S * 1000)]);
	const tiedPrimaryDated = {
		"x-codex-primary-used-percent": "60",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": String(NOW_S + 2 * HOUR_S),
		"x-codex-secondary-used-percent": "60",
		"x-codex-secondary-window-minutes": "300",
	};
	assert.deepEqual(parseQuotaHeaders(tiedPrimaryDated, CODEX, NOW)?.windows, [window(300, "5h", 60, NOW + 2 * HOUR_S * 1000)]);
	// Both dated: the first slot stands.
	const bothDated = { ...tiedPrimaryDated, "x-codex-secondary-reset-at": String(NOW_S + HOUR_S) };
	assert.deepEqual(parseQuotaHeaders(bothDated, CODEX, NOW)?.windows, [window(300, "5h", 60, NOW + 2 * HOUR_S * 1000)]);
	// A snapped duration is the same window as the exact one.
	const snapped = { ...headers, "x-codex-primary-window-minutes": "299", "x-codex-secondary-window-minutes": "301" };
	assert.deepEqual(parseQuotaHeaders(snapped, CODEX, NOW)?.windows, [window(300, "5h", 60, NOW + HOUR_S * 1000)]);
});

test("Codex: a slot needs both its percent and a labelable duration", () => {
	assert.equal(parseQuotaHeaders({ "x-codex-primary-used-percent": "50" }, CODEX, NOW), undefined);
	assert.equal(parseQuotaHeaders({ "x-codex-primary-window-minutes": "300" }, CODEX, NOW), undefined);
	assert.equal(parseQuotaHeaders({ "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "330" }, CODEX, NOW), undefined);
	// One bad slot does not take the good one with it.
	assert.deepEqual(parseQuotaHeaders({
		"x-codex-primary-used-percent": "50",
		"x-codex-primary-window-minutes": "45",
		"x-codex-secondary-used-percent": "7",
		"x-codex-secondary-window-minutes": "10080",
	}, CODEX, NOW)?.windows, [window(10080, "wk", 7)]);
});

test("only the exact x-codex- family is read", () => {
	assert.equal(parseQuotaHeaders({
		"x-other-primary-used-percent": "50",
		"x-other-primary-window-minutes": "300",
		"x-codex-other-primary-used-percent": "50",
		"x-codex-other-primary-window-minutes": "300",
		"x-codex-tertiary-used-percent": "50",
		"x-codex-tertiary-window-minutes": "300",
		"X-Codex-Primary-Used-Percent": "50",
		"X-Codex-Primary-Window-Minutes": "300",
	}, CODEX, NOW), undefined);
});

test("labels are generated from a canonical duration", () => {
	const table: readonly (readonly [number, string | undefined])[] = [
		[300, "5h"], [10080, "wk"], [60, "1h"], [120, "2h"], [720, "12h"], [1380, "23h"],
		[1440, "1d"], [2880, "2d"], [20160, "14d"], [43200, "30d"], [525600, "365d"],
		[0, undefined], [1, undefined], [45, undefined], [90, undefined], [299, undefined], [301, undefined],
		[1441, undefined], [1500, undefined], [10079, undefined], [527040, undefined],
		[-300, undefined], [300.5, undefined], [Number.NaN, undefined], [Number.POSITIVE_INFINITY, undefined],
	];
	for (const [minutes, label] of table) assert.equal(quotaLabel(minutes), label, `quotaLabel(${minutes})`);
});

test("a declared duration snaps to the whole hour or day it lies within 5% of, and the stored minutes are canonical", () => {
	const table: readonly (readonly [number, number | undefined])[] = [
		// Exact lengths stand.
		[60, 60], [300, 300], [1380, 1380], [1440, 1440], [10080, 10080], [43200, 43200], [525600, 525600],
		// What servers report for the five-hour and weekly windows.
		[299, 300], [301, 300], [10079, 10080], [10081, 10080],
		// The tolerance is 5% of the canonical length, inclusive.
		[285, 300], [284, undefined], [315, 300], [316, undefined],
		[57, 60], [56, undefined], [63, 60], [64, undefined],
		[9576, 10080], [9575, undefined], [10584, 10080], [10585, undefined],
		// The nearer neighbour first: under a day whole hours, from a day up whole days.
		[1400, 1380], [1430, 1440], [1500, 1440], [1512, 1440], [1513, undefined], [2800, 2880], [43199, 43200],
		// Neither.
		[0, undefined], [1, undefined], [45, undefined], [90, undefined], [330, undefined], [2160, undefined],
		[527040, undefined], [999_999_999, undefined],
		[-300, undefined], [300.5, undefined], [Number.NaN, undefined], [Number.POSITIVE_INFINITY, undefined],
	];
	for (const [declared, canonical] of table) {
		assert.equal(canonicalMinutes(declared), canonical, `canonicalMinutes(${declared})`);
		if (Number.isInteger(declared) && declared >= 0) {
			const parsed = parseQuotaHeaders({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": String(declared) }, CODEX, NOW)?.windows[0];
			assert.equal(parsed?.minutes, canonical, `stored minutes for ${declared}`);
			assert.equal(parsed?.label, canonical === undefined ? undefined : quotaLabel(canonical), `label for ${declared}`);
		}
	}
	assert.equal(minutesLabel("299"), "5h");
	assert.equal(minutesLabel("10079"), "wk");
});

test("window-minutes must be a strict integer", () => {
	assert.equal(minutesLabel("300"), "5h");
	for (const value of [...MALFORMED_NUMBERS, "300.0", "0300", "3e2", "300m", "5h", "1234567890"]) {
		assert.equal(minutesLabel(value), undefined, JSON.stringify(value));
	}
	for (const value of NOT_STRINGS) assert.equal(minutesLabel(value), undefined, String(value));
});

test("unit trap: an Anthropic utilization is a fraction", () => {
	assert.equal(utilization("0.73"), 73, "0.73 is 73%, never 1%");
	assert.equal(utilization("0"), 0);
	assert.equal(utilization("0.0"), 0);
	assert.equal(utilization("0.004"), 0);
	assert.equal(utilization("0.29"), 29);
	assert.equal(utilization("0.8100000000000001"), 81);
	assert.equal(utilization("0.999"), 100);
	assert.equal(utilization("1"), 100);
	assert.equal(utilization("1.0"), 100);
	assert.equal(utilization("1.37"), 100, "above the limit clamps");
	assert.equal(utilization("10"), 100);
	assert.equal(utilization("10.01"), undefined);
	assert.equal(utilization("73"), undefined, "a percent where a fraction belongs is out of range");
	assert.equal(utilization("100"), undefined);

	const over = quotaView(stateOf({ "anthropic-ratelimit-unified-5h-utilization": "1.37" }), SUB, NOW);
	assert.deepEqual(shape(over), [["5h", 100, "critical"]]);
	assert.equal(over?.one, "5h 100%");
});

test("unit trap: a Codex used-percent is already a percent, and past the limit it clamps", () => {
	assert.equal(usedPercent("0.73"), 1, "0.73 is under one percent, not 73%");
	assert.equal(usedPercent("0.4"), 0);
	assert.equal(usedPercent("0"), 0);
	assert.equal(usedPercent("73"), 73);
	assert.equal(usedPercent("73.4"), 73);
	assert.equal(usedPercent("73.5"), 74);
	assert.equal(usedPercent("99.6"), 100);
	assert.equal(usedPercent("100"), 100);
	assert.equal(usedPercent("100.0"), 100);
	assert.equal(usedPercent("100.1"), 100, "over the limit is still this window, full");
	assert.equal(usedPercent("101"), 100);
	assert.equal(usedPercent("137.5"), 100);
	assert.equal(usedPercent("999"), 100);
	assert.equal(usedPercent("999.99"), 100);
	assert.equal(usedPercent("1000"), undefined, "four digits are not a percent");

	const over = quotaView(stateOf({ "x-codex-primary-used-percent": "104.2", "x-codex-primary-window-minutes": "300" }, CODEX), { provider: "sub", api: CODEX }, NOW);
	assert.deepEqual(shape(over), [["5h", 100, "critical"]]);
});

test("a malformed number is rejected in both families", () => {
	for (const value of MALFORMED_NUMBERS) {
		assert.equal(utilization(value), undefined, `utilization ${JSON.stringify(value)}`);
		assert.equal(usedPercent(value), undefined, `used-percent ${JSON.stringify(value)}`);
	}
	for (const value of NOT_STRINGS) {
		assert.equal(utilization(value), undefined, `utilization ${String(value)}`);
		assert.equal(usedPercent(value), undefined, `used-percent ${String(value)}`);
	}
	// Text that looks like our own output is still not a number.
	assert.equal(utilization("5h 43%"), undefined);
	assert.equal(utilization("wk 81%"), undefined);
});

test("a value of 21 to 40 characters is read only while it is a number: twenty fraction digits, no more", () => {
	const fraction = (digits: number) => `0.${"4".repeat(digits)}`;
	assert.equal(fraction(19).length, 21);
	assert.equal(utilization(fraction(19)), 44);
	assert.equal(utilization(fraction(20)), 44, "22 characters: the longest fraction");
	assert.equal(usedPercent(`100.${"0".repeat(20)}`), 100, "24 characters: the longest value there is");
	assert.equal(usedPercent(`44.${"4".repeat(20)}`), 44);
	for (const length of [23, 24, 25, 30, 39, 40]) {
		assert.equal(utilization(fraction(length - 2)), undefined, `a ${length}-character fraction`);
		assert.equal(usedPercent(`4.${"4".repeat(length - 2)}`), undefined, `a ${length}-character percent`);
		assert.equal(minutesLabel("3".padEnd(length, "0")), undefined, `${length} digits of minutes`);
		assert.equal(utilization("1".repeat(length)), undefined, `${length} digits`);
	}
	// Twenty-one to forty characters of something else are not read at all.
	assert.equal(utilization(`0.5${" ".repeat(20)}`), undefined);
	assert.equal(utilization(`${"0".repeat(21)}.5`), undefined);
});

test("headers must be a plain object", () => {
	const key = "anthropic-ratelimit-unified-7d-utilization";
	const array: unknown[] = [];
	Object.assign(array, { [key]: "0.5" });
	const fn = Object.assign(() => undefined, { [key]: "0.5" });
	class Carrier { [key] = "0.5"; }
	const shapes: readonly unknown[] = [
		undefined, null, 0, 1, "", `{"${key}":"0.5"}`, true, Symbol("x"), array, [[key, "0.5"]], fn,
		new Map([[key, "0.5"]]), new Headers({ [key]: "0.5" }), new Carrier(), new Date(0), Object.create({ [key]: "0.5" }),
	];
	for (const headers of shapes) assert.equal(parseQuotaHeaders(headers, ANTHROPIC, NOW), undefined, Object.prototype.toString.call(headers));

	// A null-prototype record and a JSON-parsed one are plain.
	const bare: Record<string, string> = Object.create(null);
	bare[key] = "0.5";
	assert.equal(parseQuotaHeaders(bare, ANTHROPIC, NOW)?.windows[0]?.percent, 50);
	assert.equal(parseQuotaHeaders(JSON.parse(`{"${key}":"0.5"}`), ANTHROPIC, NOW)?.windows[0]?.percent, 50);
});

test("prototype keys are neither read nor trusted", () => {
	const hostile: unknown = JSON.parse('{"__proto__":"0.5","constructor":"0.5","toString":"0.5","hasOwnProperty":"0.5","valueOf":"0.5"}');
	assert.ok(Object.hasOwn(hostile as object, "__proto__"), "the fixture carries an own __proto__ key");
	assert.equal(parseQuotaHeaders(hostile, ANTHROPIC, NOW), undefined);
	assert.equal(parseQuotaHeaders(hostile, CODEX, NOW), undefined);
	assert.deepEqual(
		parseQuotaHeaders(Object.assign(JSON.parse('{"__proto__":"0.9","hasOwnProperty":"no"}'), OBSERVED), ANTHROPIC, NOW)?.windows.map((item) => item.percent),
		[81],
	);

	// A value inherited from a polluted Object.prototype is not the response's.
	const key = "anthropic-ratelimit-unified-7d-utilization";
	const prototype = Object.prototype as Record<string, unknown>;
	prototype[key] = "0.5";
	try {
		assert.equal(({} as Record<string, unknown>)[key], "0.5", "the pollution is visible to a plain read");
		assert.equal(parseQuotaHeaders({}, ANTHROPIC, NOW), undefined);
	} finally {
		delete prototype[key];
	}
});

test("hostile input never throws from any entry point", () => {
	const key = "anthropic-ratelimit-unified-7d-utilization";
	const getter = {};
	Object.defineProperty(getter, key, { enumerable: true, get() { throw new Error("getter"); } });
	const trap = () => { throw new Error("trap"); };
	const proxy = new Proxy({}, { getOwnPropertyDescriptor: trap, getPrototypeOf: trap, get: trap, has: trap, ownKeys: trap });
	const state = stateOf(OBSERVED);
	for (const hostile of [getter, proxy]) {
		assert.equal(parseQuotaHeaders(hostile, ANTHROPIC, NOW), undefined);
		assert.equal(parseQuotaEvent(hostile, CODEX, NOW), undefined);
		assert.equal(isUsageLimitMessage(hostile), false);
		assert.equal(nextQuota(state, { status: 200, headers: hostile, api: ANTHROPIC, provider: "other" }, NOW), state);
		assert.equal(nextQuota(state, hostile as never, NOW), state);
		assert.equal(nextQuotaEvent(state, { provider: "sub", api: CODEX, data: hostile }, NOW), state);
		assert.equal(nextQuotaEvent(state, hostile as never, NOW), state);
		assert.equal(nextQuotaMessage(state, hostile, "sub", NOW), state);
		assert.equal(quotaView(state, hostile as never, NOW), undefined);
	}
	// A message whose fields throw, and state or arguments that are not what the types promise.
	const message = { get role(): string { throw new Error("getter"); } };
	assert.equal(isUsageLimitMessage(message), false);
	assert.equal(nextQuotaMessage(state, message, "sub", NOW), state);
	for (const junk of [null, 0, "state", [], { accounts: null }, { accounts: [null] }, proxy] as never[]) {
		assert.doesNotThrow(() => nextQuota(junk, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider: "sub" }, NOW));
		assert.doesNotThrow(() => nextQuotaEvent(junk, { provider: "sub", api: CODEX, data: FIXTURE_EVENT }, NOW));
		assert.doesNotThrow(() => nextQuotaMessage(junk, limitMessage(), undefined, NOW));
		assert.doesNotThrow(() => quotaView(junk, SUB, NOW));
		assert.doesNotThrow(() => nextQuota(state, junk, NOW));
		assert.doesNotThrow(() => nextQuotaEvent(state, junk, NOW));
		assert.doesNotThrow(() => quotaView(state, junk, NOW));
	}
	for (const time of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined as never]) {
		assert.doesNotThrow(() => quotaView(nextQuota(state, { status: 200, headers: WEEK_5H, api: ANTHROPIC, provider: "sub" }, time), SUB, time));
	}
});

test("the family is chosen by api and prefix together", () => {
	assert.equal(quotaFamily("anthropic-messages"), "anthropic");
	assert.equal(quotaFamily("openai-responses"), "codex");
	assert.equal(quotaFamily("openai-codex-responses"), "codex");

	const codexHeaders = { "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300" };
	const everything = { ...OBSERVED, ...codexHeaders };
	assert.equal(parseQuotaHeaders(OBSERVED, CODEX, NOW), undefined);
	assert.equal(parseQuotaHeaders(OBSERVED, "openai-responses", NOW), undefined);
	assert.equal(parseQuotaHeaders(codexHeaders, ANTHROPIC, NOW), undefined);
	assert.deepEqual(parseQuotaHeaders(everything, ANTHROPIC, NOW)?.windows.map((item) => item.label), ["wk"]);
	assert.deepEqual(parseQuotaHeaders(everything, CODEX, NOW)?.windows.map((item) => item.label), ["5h"]);

	const others: readonly unknown[] = [
		undefined, null, "", "openai-completions", "google-generative-ai", "bedrock-converse-stream", "Anthropic-Messages",
		"anthropic-messages ", "anthropic", "__proto__", "constructor", 0, {}, ["anthropic-messages"],
	];
	for (const api of others) {
		assert.equal(quotaFamily(api), undefined, String(api));
		assert.equal(parseQuotaHeaders(everything, api as string | undefined, NOW), undefined, String(api));
	}
});

test("a reset already past drops its window", () => {
	const at = (reset: number) => parseQuotaHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "0.5",
		"anthropic-ratelimit-unified-5h-reset": String(reset),
		"anthropic-ratelimit-unified-7d-utilization": "0.2",
	}, ANTHROPIC, NOW)?.windows.map((item) => item.label);
	assert.deepEqual(at(NOW_S + 1), ["5h", "wk"]);
	assert.deepEqual(at(NOW_S), ["wk"], "a reset at this instant is past");
	assert.deepEqual(at(NOW_S - 1), ["wk"]);
	assert.deepEqual(at(NOW_S - 30 * DAY_S), ["wk"]);
	assert.deepEqual(at(1_000_000_000), ["wk"], "the earliest ten-digit second is long past");
});

test("a reset further than the window is long, plus a day, is not believed", () => {
	const resetOf = (reset: number) => parseQuotaHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "0.5",
		"anthropic-ratelimit-unified-5h-reset": String(reset),
	}, ANTHROPIC, NOW)?.windows;
	const limit = NOW_S + 5 * HOUR_S + DAY_S;
	assert.deepEqual(resetOf(limit), [window(300, "5h", 50, limit * 1000)]);
	assert.deepEqual(resetOf(limit + 1), [window(300, "5h", 50)], "kept without a reset: it ages out instead");
	assert.deepEqual(resetOf(NOW_S + 400 * DAY_S), [window(300, "5h", 50)]);
	assert.deepEqual(resetOf(9_999_999_999), [window(300, "5h", 50)]);
});

test("a malformed reset leaves the window without one: epoch seconds are exactly ten digits", () => {
	const malformed = [
		...MALFORMED_NUMBERS, "1795316400.0", "1795316400s", "+1795316400", "-1795316400", "1.7953164e9", "0x6B02F6F0",
		"2026-11-22T03:00:00Z", "soon", "0000000000", "0795316400",
		// Nine digits (2001 at the latest), eleven (the year 7600), and milliseconds where seconds belong.
		"17953164", "179531640", "999999999", "17953164000", "99999999999", "179531640000", "1795316400000",
	];
	for (const value of malformed) {
		assert.deepEqual(
			parseQuotaHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.5", "anthropic-ratelimit-unified-7d-reset": value }, ANTHROPIC, NOW)?.windows,
			[window(10080, "wk", 50)],
			JSON.stringify(value),
		);
	}
	for (const value of NOT_STRINGS) {
		assert.deepEqual(
			parseQuotaHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.5", "anthropic-ratelimit-unified-7d-reset": value }, ANTHROPIC, NOW)?.windows,
			[window(10080, "wk", 50)],
			String(value),
		);
	}
});

test("Codex: reset-at wins, reset-after-seconds is relative to now", () => {
	const reset = (extra: Record<string, unknown>) => {
		const windows = parseQuotaHeaders({ "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300", ...extra }, CODEX, NOW)?.windows;
		return windows === undefined ? "dropped" : windows[0]?.resetAtMs;
	};
	assert.equal(reset({}), undefined);
	assert.equal(reset({ "x-codex-primary-reset-after-seconds": "3600" }), NOW + 3_600_000);
	assert.equal(reset({ "x-codex-primary-reset-at": String(NOW_S + 60), "x-codex-primary-reset-after-seconds": "3600" }), NOW + 60_000);
	assert.equal(reset({ "x-codex-primary-reset-at": "", "x-codex-primary-reset-after-seconds": "3600" }), NOW + 3_600_000, "an unreadable reset-at falls back");
	// Thirteen digits are milliseconds, nine and eleven are no epoch second: each falls back to reset-after.
	for (const unreadable of [String(NOW + 60_000), String(NOW_S + 60).slice(0, 9), `${NOW_S + 60}0`]) {
		assert.equal(reset({ "x-codex-primary-reset-at": unreadable, "x-codex-primary-reset-after-seconds": "3600" }), NOW + 3_600_000, unreadable);
		assert.equal(reset({ "x-codex-primary-reset-at": unreadable }), undefined, `${unreadable} alone`);
	}
	assert.equal(reset({ "x-codex-primary-reset-after-seconds": "0" }), "dropped", "a window renewing this instant is over");
	assert.equal(reset({ "x-codex-primary-reset-at": String(NOW_S - 1), "x-codex-primary-reset-after-seconds": "3600" }), "dropped", "a past reset-at is still an answer");
	assert.equal(reset({ "x-codex-primary-reset-after-seconds": String(5 * HOUR_S + DAY_S) }), NOW + (5 * HOUR_S + DAY_S) * 1000);
	assert.equal(reset({ "x-codex-primary-reset-after-seconds": String(5 * HOUR_S + DAY_S + 1) }), undefined, "implausibly far: no reset");
	for (const value of [...MALFORMED_NUMBERS, "3600.0", "-3600", "3.6e3", "1h", "1234567890"]) {
		assert.equal(reset({ "x-codex-primary-reset-after-seconds": value }), undefined, JSON.stringify(value));
	}
	// The secondary slot reads its own reset headers, not the primary's.
	assert.deepEqual(parseQuotaHeaders({
		"x-codex-primary-reset-after-seconds": "60",
		"x-codex-secondary-used-percent": "50",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-after-seconds": "7200",
	}, CODEX, NOW)?.windows, [window(10080, "wk", 50, NOW + 7_200_000)]);
});

// --- the Codex stream event ---------------------------------------------------

test("stream event: the shape Pi's own Codex test replays reads as one weekly window", () => {
	const at = (1785269351 - 556112) * 1000;
	assert.deepEqual(parseQuotaEvent(FIXTURE_EVENT, CODEX, at), {
		family: "codex",
		windows: [window(10080, "wk", 7, 1785269351 * 1000, at)],
	});
	const state = nextQuotaEvent(undefined, { provider: "openai-codex", api: CODEX, data: FIXTURE_EVENT }, at);
	assert.deepEqual(state.accounts, [{ provider: "openai-codex", family: "codex", windows: [window(10080, "wk", 7, 1785269351 * 1000, at)], misses: 0, limited: false }]);
	assert.equal(shown(quotaView(state, { provider: "openai-codex", api: CODEX }, at)), "wk 7%");
	// It survives a JSON round trip, which is how it arrives.
	assert.deepEqual(parseQuotaEvent(JSON.parse(JSON.stringify(FIXTURE_EVENT)), CODEX, at)?.windows.map((item) => item.label), ["wk"]);
});

test("stream event: two slots, the same bounds as the headers, and reset-at before reset-after", () => {
	const event = (primary: unknown, secondary: unknown = null) => ({ type: "codex.rate_limits", rate_limits: { primary, secondary } });
	const read = (primary: unknown, secondary: unknown = null) => parseQuotaEvent(event(primary, secondary), CODEX, NOW)?.windows;

	assert.deepEqual(read(
		{ used_percent: 81.4, window_minutes: 10079, reset_at: NOW_S + 3 * DAY_S },
		{ used_percent: 43.5, window_minutes: 299, reset_after_seconds: 3600 },
	), [window(300, "5h", 44, NOW + 3_600_000), window(10080, "wk", 81, NOW + 3 * DAY_S * 1000)], "snapped, rounded, shortest first");

	assert.deepEqual(read({ used_percent: 0.73, window_minutes: 300 }), [window(300, "5h", 1)], "a percent already");
	assert.deepEqual(read({ used_percent: 104.2, window_minutes: 300 }), [window(300, "5h", 100)], "clamped");
	assert.deepEqual(read({ used_percent: 1000, window_minutes: 300 }), [window(300, "5h", 100)]);
	assert.equal(read({ used_percent: 1000.5, window_minutes: 300 }), undefined);
	assert.equal(read({ used_percent: -1, window_minutes: 300 }), undefined);
	assert.equal(read({ used_percent: 50 }), undefined, "no declared length");
	assert.equal(read({ window_minutes: 300 }), undefined, "no percent");
	assert.equal(read({ used_percent: 50, window_minutes: 330 }), undefined, "no canonical length");
	assert.equal(read({ used_percent: 50, window_minutes: 300.5 }), undefined);
	assert.equal(read({ used_percent: 50, window_minutes: 1_000_000_000 }), undefined);

	// Only JSON numbers are read: a string where a number belongs is not parsed.
	for (const value of ["50", "0.5", null, true, [50], { valueOf: () => 50 }, Number.NaN, Number.POSITIVE_INFINITY, 5n]) {
		assert.equal(read({ used_percent: value, window_minutes: 300 }), undefined, `used_percent ${String(value)}`);
		assert.equal(read({ used_percent: 50, window_minutes: value }), undefined, `window_minutes ${String(value)}`);
		assert.deepEqual(read({ used_percent: 50, window_minutes: 300, reset_at: value, reset_after_seconds: value }), [window(300, "5h", 50)], `resets ${String(value)}`);
	}

	// reset_at must be a ten-digit epoch second; otherwise reset_after_seconds answers.
	const resetOf = (fields: Record<string, unknown>) => {
		const windows = read({ used_percent: 50, window_minutes: 300, ...fields });
		return windows === undefined ? "dropped" : windows[0]?.resetAtMs;
	};
	assert.equal(resetOf({ reset_at: NOW_S + 60, reset_after_seconds: 3600 }), NOW + 60_000);
	assert.equal(resetOf({ reset_at: NOW + 60_000, reset_after_seconds: 3600 }), NOW + 3_600_000, "milliseconds are not seconds");
	assert.equal(resetOf({ reset_at: 999_999_999, reset_after_seconds: 3600 }), NOW + 3_600_000, "nine digits");
	assert.equal(resetOf({ reset_at: 10_000_000_000, reset_after_seconds: 3600 }), NOW + 3_600_000, "eleven digits");
	assert.equal(resetOf({ reset_at: NOW_S + 60.5, reset_after_seconds: 3600 }), NOW + 3_600_000, "a fractional second");
	assert.equal(resetOf({ reset_at: NOW_S - 1, reset_after_seconds: 3600 }), "dropped", "a past reset_at is still an answer");
	assert.equal(resetOf({ reset_after_seconds: 0 }), "dropped");
	assert.equal(resetOf({ reset_after_seconds: -5 }), undefined);
	assert.equal(resetOf({ reset_after_seconds: 5 * HOUR_S + DAY_S + 1 }), undefined, "implausibly far");

	// Two slots of one duration: the fuller, as in the headers.
	assert.deepEqual(read({ used_percent: 20, window_minutes: 300 }, { used_percent: 60, window_minutes: 301 }), [window(300, "5h", 60)]);
});

test("stream event: only the Codex api's rate-limit event, in exactly that shape", () => {
	const good = { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 50, window_minutes: 300 } } };
	assert.equal(parseQuotaEvent(good, CODEX, NOW)?.windows[0]?.percent, 50);
	for (const api of ["openai-responses", ANTHROPIC, "openai-completions", "", undefined, "OPENAI-CODEX-RESPONSES"]) {
		assert.equal(parseQuotaEvent(good, api, NOW), undefined, String(api));
	}
	const shapes: readonly unknown[] = [
		undefined, null, 0, "codex.rate_limits", [], JSON.stringify(good),
		{ ...good, type: "response.created" }, { ...good, type: "codex.rate_limits " }, { ...good, type: ["codex.rate_limits"] }, { rate_limits: good.rate_limits },
		{ type: "codex.rate_limits" }, { type: "codex.rate_limits", rate_limits: null }, { type: "codex.rate_limits", rate_limits: [good.rate_limits.primary] },
		{ type: "codex.rate_limits", rate_limits: { primary: null, secondary: null } },
		{ type: "codex.rate_limits", rate_limits: { tertiary: good.rate_limits.primary } },
		{ type: "codex.rate_limits", primary: good.rate_limits.primary },
		{ type: "codex.rate_limits", rate_limits: Object.create({ primary: good.rate_limits.primary }) },
		Object.create(good), new Map(Object.entries(good)),
	];
	for (const data of shapes) assert.equal(parseQuotaEvent(data, CODEX, NOW), undefined, JSON.stringify(data));

	// The reducer stores nothing for those, nor without a provider, and an unreadable event is never a miss.
	const state = stateOf({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300" }, CODEX);
	for (const data of shapes) assert.equal(nextQuotaEvent(state, { provider: "sub", api: CODEX, data }, NOW + 1), state);
	assert.equal(nextQuotaEvent(state, { api: CODEX, data: good }, NOW + 1), state);
	assert.equal(nextQuotaEvent(state, { provider: "", api: CODEX, data: good }, NOW + 1), state);
	assert.equal(nextQuotaEvent(state, { provider: "sub", api: "openai-responses", data: good }, NOW + 1), state);
	assert.deepEqual(nextQuotaEvent(undefined, { api: CODEX, data: good }, NOW), EMPTY_QUOTA);
	// A readable one updates the same account the headers feed.
	const updated = nextQuotaEvent(state, { provider: "sub", api: CODEX, data: good }, NOW + 1);
	assert.deepEqual(updated.accounts[0]?.windows, [window(300, "5h", 50, undefined, NOW + 1)]);
});

// --- the reducer -------------------------------------------------------------

test("reducer: quota is stored per provider, and never without one", () => {
	const first = nextQuota(undefined, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider: "sub" }, NOW);
	assert.deepEqual(first, {
		accounts: [{ provider: "sub", family: "anthropic", windows: [window(10080, "wk", 81, 1795316400 * 1000)], misses: 0, limited: false }],
	});

	// Another provider's quota is kept beside it: switching back finds the first again.
	const codexHeaders = { "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300" };
	const second = nextQuota(first, { status: 200, headers: codexHeaders, api: CODEX, provider: "codex" }, NOW + 2000);
	assert.deepEqual(second.accounts.map((account) => account.provider), ["sub", "codex"]);
	assert.equal(shown(quotaView(second, SUB, NOW + 2000)), "wk 81%");
	assert.equal(shown(quotaView(second, { provider: "codex", api: CODEX }, NOW + 2000)), "5h 50%");
	assert.equal(quotaView(second, { provider: "zai", api: "openai-completions" }, NOW + 2000), undefined);

	// No provider, no state: not under "", not under undefined, not under a non-string or an absurd id.
	for (const provider of [undefined, "", 0, null, {}, ["sub"], "p".repeat(129)] as never[]) {
		assert.deepEqual(nextQuota(undefined, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider }, NOW), EMPTY_QUOTA, String(provider));
		assert.equal(nextQuota(first, { status: 200, headers: WEEK_5H, api: ANTHROPIC, provider }, NOW), first, String(provider));
		assert.equal(nextQuota(first, { status: 200, headers: {}, api: ANTHROPIC, provider }, NOW), first, String(provider));
		assert.equal(quotaView(first, { provider, api: ANTHROPIC }, NOW), undefined, String(provider));
	}
	assert.equal(nextQuota(undefined, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider: "p".repeat(128) }, NOW).accounts.length, 1);

	// Nothing to store when the very first response has none, or no api names a family.
	assert.deepEqual(nextQuota(undefined, { status: 200, headers: {}, api: ANTHROPIC, provider: "sub" }, NOW), EMPTY_QUOTA);
	assert.deepEqual(nextQuota(undefined, { status: 200, headers: OBSERVED, provider: "sub" }, NOW), EMPTY_QUOTA, "no api, no family");
});

test("reducer: at most eight providers are remembered, the least recently heard goes first", () => {
	let state: QuotaState = EMPTY_QUOTA;
	for (let index = 0; index < 8; index++) state = nextQuota(state, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider: `p${index}` }, NOW + index);
	state = nextQuota(state, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider: "p0" }, NOW + 8);
	state = nextQuota(state, { status: 200, headers: OBSERVED, api: ANTHROPIC, provider: "p8" }, NOW + 9);
	assert.deepEqual(state.accounts.map((account) => account.provider), ["p2", "p3", "p4", "p5", "p6", "p7", "p0", "p8"]);
});

test("reducer: a response with valid family headers updates the figure whatever its status", () => {
	const state = stateOf({ "x-codex-primary-used-percent": "96", "x-codex-primary-window-minutes": "300" }, CODEX);
	const exhausted = { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "1800" };
	const current = { provider: "sub", api: CODEX };
	for (const status of [429, 400, 401, 500, 529, 304, 0, Number.NaN, "429" as never, undefined as never]) {
		const next = nextQuota(state, { status, headers: exhausted, api: CODEX, provider: "sub" }, NOW + 1000);
		assert.deepEqual(next.accounts[0]?.windows, [window(300, "5h", 100, NOW + 1000 + 1_800_000, NOW + 1000)], `status ${String(status)}`);
		assert.equal(shown(quotaView(next, current, NOW + 1000)), "5h 100%");
		// And creates the account when there was none.
		assert.equal(shown(quotaView(nextQuota(undefined, { status, headers: exhausted, api: CODEX, provider: "sub" }, NOW), current, NOW)), "5h 100%");
	}
	// It also ends a count of misses.
	const missed = nextQuota(state, { status: 200, headers: {}, api: CODEX, provider: "sub" }, NOW + 1);
	assert.equal(missed.accounts[0]?.misses, 1);
	assert.equal(nextQuota(missed, { status: 429, headers: exhausted, api: CODEX, provider: "sub" }, NOW + 2).accounts[0]?.misses, 0);
});

test("reducer: an unsuccessful response without quota says nothing, and only successful ones count as misses", () => {
	const state = stateOf(OBSERVED);
	const bare = { status: 200, headers: { "content-type": "text/event-stream" }, api: ANTHROPIC, provider: "sub" };
	for (const status of [0, 100, 199, 300, 304, 400, 401, 429, 500, 529, -200, Number.NaN, Number.POSITIVE_INFINITY, "200" as never, undefined as never]) {
		assert.equal(nextQuota(state, { ...bare, status }, NOW + 1000), state, `status ${String(status)}`);
		assert.deepEqual(nextQuota(undefined, { ...bare, status }, NOW), EMPTY_QUOTA);
	}
	for (const status of [200, 201, 204, 299]) assert.equal(nextQuota(state, { ...bare, status }, NOW + 1000).accounts[0]?.misses, 1, `status ${status}`);

	// Errors between two successes neither count nor start the count again.
	const once = nextQuota(state, bare, NOW + 1000);
	let between = once;
	for (const status of [429, 500, 529]) between = nextQuota(between, { ...bare, status }, NOW + 2000);
	assert.equal(between, once);
	assert.deepEqual(nextQuota(between, bare, NOW + 3000), EMPTY_QUOTA);
});

test("reducer: two consecutive quota-less successes from the same provider clear it", () => {
	const state = stateOf(OBSERVED);
	const bare = { status: 200, headers: { "content-type": "text/event-stream" }, api: ANTHROPIC, provider: "sub" };

	const once = nextQuota(state, bare, NOW + 1000);
	assert.deepEqual(once.accounts, [{ ...state.accounts[0], misses: 1 }], "one miss keeps the figures and when they were seen");
	assert.equal(shown(quotaView(once, SUB, NOW + 1000)), "wk 81%");
	assert.deepEqual(nextQuota(once, bare, NOW + 2000), EMPTY_QUOTA);

	// Quota in between starts the count again.
	const renewed = nextQuota(once, { ...bare, headers: OBSERVED }, NOW + 2000);
	assert.equal(renewed.accounts[0]?.misses, 0);
	assert.equal(nextQuota(renewed, bare, NOW + 3000).accounts[0]?.misses, 1);

	// The same provider on an api without the family counts too.
	assert.deepEqual(nextQuota(once, { ...bare, headers: OBSERVED, api: "openai-completions" }, NOW + 2000), EMPTY_QUOTA);
	// Only that provider's account goes.
	const two = nextQuota(once, { status: 200, headers: WEEK_5H, api: ANTHROPIC, provider: "other" }, NOW + 1500);
	assert.deepEqual(nextQuota(two, bare, NOW + 2000).accounts.map((account) => account.provider), ["other"]);
});

test("reducer: family headers that are present but unusable are not a miss", () => {
	const state = stateOf(OBSERVED);
	const unusable: readonly Record<string, unknown>[] = [
		{ "anthropic-ratelimit-unified-status": "allowed" },
		{ "anthropic-ratelimit-unified-7d-utilization": "NaN" },
		{ "anthropic-ratelimit-unified-7d-utilization": "0.5", "anthropic-ratelimit-unified-7d-reset": String(NOW_S - 60) },
		{ "anthropic-ratelimit-unified-7d_opus-utilization": "0.5" },
	];
	for (const headers of unusable) {
		let next = state;
		for (let round = 0; round < 5; round++) next = nextQuota(next, { status: 200, headers, api: ANTHROPIC, provider: "sub" }, NOW + 1000 + round);
		assert.equal(next, state, JSON.stringify(headers));
	}
	const codex = stateOf({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300" }, CODEX);
	const codexUnusable = { "x-codex-primary-used-percent": "soon", "x-codex-secondary-window-minutes": "45" };
	assert.equal(nextQuota(nextQuota(codex, { status: 200, headers: codexUnusable, api: CODEX, provider: "sub" }, NOW), { status: 200, headers: codexUnusable, api: CODEX, provider: "sub" }, NOW), codex);

	// Headers of the family's neighbourhood that say nothing about quota are a miss:
	// these are what OpenAI's ChatGPT route sent with a 200 at the account's limit.
	const neighbours = { "x-codex-safety-buffering-enabled": "true", "x-codex-turn-state": "abc" };
	const once = nextQuota(codex, { status: 200, headers: neighbours, api: CODEX, provider: "sub" }, NOW);
	assert.equal(once.accounts[0]?.misses, 1);
	assert.deepEqual(nextQuota(once, { status: 200, headers: neighbours, api: CODEX, provider: "sub" }, NOW), EMPTY_QUOTA);
	// And another family's headers are not this one's.
	assert.equal(nextQuota(codex, { status: 200, headers: OBSERVED, api: CODEX, provider: "sub" }, NOW).accounts[0]?.misses, 1);
});

test("reducer: a response that carries one window does not erase the other", () => {
	const current = SUB;
	const both = stateOf({
		"anthropic-ratelimit-unified-5h-utilization": "0.43",
		"anthropic-ratelimit-unified-5h-reset": String(NOW_S + 2 * HOUR_S),
		"anthropic-ratelimit-unified-7d-utilization": "0.12",
		"anthropic-ratelimit-unified-7d-reset": String(NOW_S + 3 * DAY_S),
	});
	// The observed case: later responses carry the weekly window only.
	const later = nextQuota(both, { status: 200, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.13", "anthropic-ratelimit-unified-7d-reset": String(NOW_S + 3 * DAY_S) }, api: ANTHROPIC, provider: "sub" }, NOW + 5 * MINUTE);
	assert.deepEqual(later.accounts[0]?.windows, [
		window(300, "5h", 43, NOW + 2 * HOUR_S * 1000, NOW),
		window(10080, "wk", 13, NOW + 3 * DAY_S * 1000, NOW + 5 * MINUTE),
	], "each window keeps the time it was last seen");
	assert.equal(shown(quotaView(later, current, NOW + 5 * MINUTE)), "5h 43% · wk 13%");

	// The kept window leaves when its own reset passes, not before and not with the other.
	assert.equal(shown(quotaView(later, current, NOW + 2 * HOUR_S * 1000 - 1)), "5h 43% · wk 13%");
	assert.equal(shown(quotaView(later, current, NOW + 2 * HOUR_S * 1000)), "wk 13%");
	// Once over it is also gone from the state at the next merge.
	const afterReset = nextQuota(later, { status: 200, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.2" }, api: ANTHROPIC, provider: "sub" }, NOW + 3 * HOUR_S * 1000);
	assert.deepEqual(afterReset.accounts[0]?.windows.map((item) => item.label), ["wk"]);
});

test("reducer: a window without a believable reset leaves thirty minutes after it was last seen", () => {
	const undated = stateOf(WEEK_5H);
	const weekly = { status: 200, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.2" }, api: ANTHROPIC, provider: "sub" };
	const later = nextQuota(undated, weekly, NOW + 20 * MINUTE);
	assert.deepEqual(later.accounts[0]?.windows, [window(300, "5h", 43, undefined, NOW), window(10080, "wk", 20, undefined, NOW + 20 * MINUTE)]);
	assert.equal(shown(quotaView(later, SUB, NOW + QUOTA_STALE_MS)), "5h 43% · wk 20%");
	assert.equal(shown(quotaView(later, SUB, NOW + QUOTA_STALE_MS + 1)), "wk 20%", "the five-hour figure was last seen thirty minutes ago");
	assert.equal(shown(quotaView(later, SUB, NOW + 20 * MINUTE + QUOTA_STALE_MS)), "wk 20%");
	assert.equal(quotaView(later, SUB, NOW + 20 * MINUTE + QUOTA_STALE_MS + 1), undefined);
	// A merge past that point drops it from the state too.
	const merged = nextQuota(later, weekly, NOW + QUOTA_STALE_MS + 1);
	assert.deepEqual(merged.accounts[0]?.windows.map((item) => item.label), ["wk"]);
	// A quota-less response does not refresh anything.
	const missed = nextQuota(undated, { ...weekly, headers: {} }, NOW + QUOTA_STALE_MS);
	assert.equal(quotaView(missed, SUB, NOW + QUOTA_STALE_MS + 1), undefined);
});

test("reducer: windows are kept within one family, two at most, the most recently seen", () => {
	const anthropic = stateOf(WEEK_5H);
	// The provider now answers in the other family: its old windows are not this account's any more.
	const switched = nextQuota(anthropic, { status: 200, headers: { "x-codex-primary-used-percent": "9", "x-codex-primary-window-minutes": "1440" }, api: CODEX, provider: "sub" }, NOW + 1);
	assert.deepEqual(switched.accounts[0], { provider: "sub", family: "codex", windows: [window(1440, "1d", 9, undefined, NOW + 1)], misses: 0, limited: false });
	assert.equal(quotaView(switched, SUB, NOW + 1), undefined, "the anthropic api no longer speaks the stored family");

	// A third duration displaces the least recently seen one.
	const codex = (minutes: number, percent: number) => ({ status: 200, headers: { "x-codex-primary-used-percent": String(percent), "x-codex-primary-window-minutes": String(minutes) }, api: CODEX, provider: "sub" });
	let state = nextQuota(undefined, codex(300, 10), NOW);
	state = nextQuota(state, codex(10080, 20), NOW + 1);
	state = nextQuota(state, codex(43200, 30), NOW + 2);
	assert.deepEqual(state.accounts[0]?.windows.map((item) => item.label), ["wk", "30d"]);
	// A fresh reading of a kept duration replaces it rather than adding one.
	state = nextQuota(state, codex(10079, 25), NOW + 3);
	assert.deepEqual(state.accounts[0]?.windows, [window(10080, "wk", 25, undefined, NOW + 3), window(43200, "30d", 30, undefined, NOW + 2)]);
});

test("reducer: another provider's responses leave an account alone", () => {
	let state: QuotaState = stateOf(OBSERVED);
	const original = state.accounts[0];
	for (let i = 0; i < 5; i++) {
		state = nextQuota(state, { status: 200, headers: {}, api: "openai-completions", provider: "gateway" }, NOW + i);
		state = nextQuota(state, { status: 200, headers: OBSERVED, api: "openai-completions", provider: "gateway" }, NOW + i);
		state = nextQuota(state, { status: 200, headers: {}, api: ANTHROPIC }, NOW + i);
	}
	assert.deepEqual(state.accounts, [original]);
	assert.equal(quotaView(state, { provider: "gateway", api: "openai-completions" }, NOW), undefined);
	assert.equal(shown(quotaView(state, SUB, NOW)), "wk 81%");
});

// --- the usage-limit marker ---------------------------------------------------

test("limit: the observed sentence is recognised, by one narrow phrase", () => {
	assert.equal(isUsageLimitMessage({ role: "assistant", stopReason: "error", errorMessage: OBSERVED_LIMIT }), true);
	for (const errorMessage of ["usage limit", "Usage Limit reached", "YOU HAVE HIT YOUR USAGE LIMIT.", "weekly usage limits apply", `${"x".repeat(501)}usage limit`]) {
		assert.equal(isUsageLimitMessage({ role: "assistant", stopReason: "error", errorMessage }), true, errorMessage.slice(0, 40));
	}
	// The generic throttling errors of pay-per-use APIs are not a subscription limit.
	const others = [
		"Rate limit exceeded", "429 rate_limit_error: This request would exceed your organization's rate limit of 50,000 input tokens per minute.",
		"Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000.",
		"You exceeded your current quota, please check your plan and billing details.", "Too Many Requests", "overloaded_error: Overloaded",
		"limit", "usage", "usage  limit", "usage-limit", "usage_limit_reached", "usagelimit", "limit usage", "", " ",
		// Past the bound the text is not read.
		`${"x".repeat(502)}usage limit`, `${"x".repeat(5000)}usage limit`,
	];
	for (const errorMessage of others) assert.equal(isUsageLimitMessage({ role: "assistant", stopReason: "error", errorMessage }), false, errorMessage.slice(0, 60));

	// Only an assistant message that ended in an error, with a string to read.
	const not: readonly unknown[] = [
		undefined, null, 0, OBSERVED_LIMIT, [],
		{ role: "user", stopReason: "error", errorMessage: OBSERVED_LIMIT },
		{ role: "toolResult", stopReason: "error", errorMessage: OBSERVED_LIMIT },
		{ stopReason: "error", errorMessage: OBSERVED_LIMIT },
		{ role: "assistant", stopReason: "stop", errorMessage: OBSERVED_LIMIT },
		{ role: "assistant", stopReason: "aborted", errorMessage: OBSERVED_LIMIT },
		{ role: "assistant", errorMessage: OBSERVED_LIMIT },
		{ role: "assistant", stopReason: "error" },
		{ role: "assistant", stopReason: "error", errorMessage: [OBSERVED_LIMIT] },
		{ role: "assistant", stopReason: "error", errorMessage: { toString: () => OBSERVED_LIMIT } },
		{ role: "assistant", stopReason: "error", content: [{ type: "text", text: OBSERVED_LIMIT }] },
	];
	for (const message of not) assert.equal(isUsageLimitMessage(message), false, JSON.stringify(message)?.slice(0, 80));
});

test("limit: the mark is per provider, replaces the windows, and the next clean assistant message clears it", () => {
	const openai = { provider: "openai", api: "openai-responses" };
	const marked = nextQuotaMessage(undefined, limitMessage({ provider: "openai" }), undefined, NOW);
	assert.deepEqual(marked.accounts, [{ provider: "openai", family: undefined, windows: [], misses: 0, limited: true }]);
	assert.deepEqual(quotaView(marked, openai, NOW), { windows: [], hot: true, aged: false, limited: true, two: "", one: "", limit: "limit" });
	assert.equal(quotaView(marked, { provider: "zai", api: "openai-completions" }, NOW), undefined, "another provider is not limited");
	// It does not age out: there is no reset to wait for, only the next message.
	assert.equal(shown(quotaView(marked, openai, NOW + 30 * DAY_S * 1000)), "limit");
	assert.equal(nextQuotaMessage(marked, limitMessage({ provider: "openai" }), undefined, NOW + 1), marked, "marked again: nothing new");

	// Messages that are not this provider's assistant ending leave it alone.
	for (const message of [{ role: "user", content: "hi" }, { role: "toolResult" }, assistant({ provider: "zai" }), undefined, null, "assistant", { role: "custom" }]) {
		assert.equal(nextQuotaMessage(marked, message, "openai", NOW + 1), marked, JSON.stringify(message));
	}
	// An answer from it clears the mark — and an account that says nothing is not kept.
	assert.deepEqual(nextQuotaMessage(marked, assistant({ provider: "openai" }), undefined, NOW + 1), EMPTY_QUOTA);
	// An interrupted attempt or another error says nothing about the account: the mark stays.
	for (const message of [assistant({ provider: "openai", stopReason: "aborted" }), assistant({ provider: "openai", stopReason: "error", errorMessage: "Rate limit exceeded" }), assistant({ provider: "openai", stopReason: "error", errorMessage: "529 overloaded" })]) {
		assert.equal(nextQuotaMessage(marked, message, undefined, NOW + 1), marked, JSON.stringify(message));
	}

	// With windows known, the limit replaces them and they return when it clears.
	const state = stateOf(WEEK_5H);
	const limited = nextQuotaMessage(state, limitMessage(), undefined, NOW + 1);
	const view = quotaView(limited, SUB, NOW + 1);
	assert.equal(shown(view), "limit");
	assert.deepEqual([view?.two, view?.one, view?.limit, view?.limited, view?.hot], ["", "", "limit", true, true]);
	assert.deepEqual(shape(view), [["5h", 43, "normal"], ["wk", 12, "normal"]], "the windows are still known");
	// Fresh quota headers do not clear it; only a message does.
	const refreshed = nextQuota(limited, { status: 200, headers: WEEK_5H, api: ANTHROPIC, provider: "sub" }, NOW + 2);
	assert.equal(shown(quotaView(refreshed, SUB, NOW + 2)), "limit");
	const cleared = nextQuotaMessage(refreshed, assistant(), undefined, NOW + 3);
	assert.equal(shown(quotaView(cleared, SUB, NOW + 3)), "5h 43% · wk 12%");
	assert.equal(nextQuotaMessage(cleared, assistant(), undefined, NOW + 4), cleared, "a clean message with no mark changes nothing");
	// Windows already over are not carried along by the mark.
	const stale = nextQuotaMessage(state, limitMessage(), undefined, NOW + QUOTA_STALE_MS + 1);
	assert.deepEqual(stale.accounts[0], { provider: "sub", family: undefined, windows: [], misses: 0, limited: true });
});

test("limit: the provider is the message's own, else the current model's, else nothing is stored", () => {
	const bare = { role: "assistant", stopReason: "error", errorMessage: OBSERVED_LIMIT };
	assert.deepEqual(nextQuotaMessage(undefined, bare, "openai", NOW).accounts.map((account) => account.provider), ["openai"]);
	assert.deepEqual(nextQuotaMessage(undefined, { ...bare, provider: "own" }, "openai", NOW).accounts.map((account) => account.provider), ["own"]);
	for (const provider of [undefined, "", 7, null, "p".repeat(129)] as never[]) {
		assert.deepEqual(nextQuotaMessage(undefined, { ...bare, provider }, provider, NOW), EMPTY_QUOTA, String(provider));
		assert.deepEqual(nextQuotaMessage(undefined, { ...bare, provider }, "openai", NOW).accounts.map((account) => account.provider), ["openai"], `fallback for ${String(provider)}`);
	}
});

test("limit: two quota-less successes clear it, and each limit error starts that count again", () => {
	const bare = { status: 200, headers: { "x-codex-turn-state": "abc" }, api: "openai-responses", provider: "openai" };
	const openai = { provider: "openai", api: "openai-responses" };
	// The observed route: every attempt is a 200 without quota, then the error.
	let state = nextQuotaMessage(undefined, limitMessage({ provider: "openai" }), undefined, NOW);
	for (let attempt = 1; attempt <= 4; attempt++) {
		state = nextQuota(state, bare, NOW + attempt);
		assert.equal(state.accounts[0]?.misses, 1, `attempt ${attempt}: one miss`);
		assert.equal(shown(quotaView(state, openai, NOW + attempt)), "limit", `attempt ${attempt}: still shown while the request runs`);
		state = nextQuotaMessage(state, limitMessage({ provider: "openai" }), undefined, NOW + attempt);
		assert.equal(state.accounts[0]?.misses, 0, `attempt ${attempt}: the error is news about the account`);
	}
	// Without a message in between (the account changed under us), the second success clears everything.
	state = nextQuota(state, bare, NOW + 10);
	assert.deepEqual(nextQuota(state, bare, NOW + 11), EMPTY_QUOTA);
});

// --- the view ----------------------------------------------------------------

test("view: nothing without a matching account", () => {
	const state = stateOf(OBSERVED);
	assert.equal(quotaView(undefined, SUB, NOW), undefined);
	assert.equal(quotaView(EMPTY_QUOTA, SUB, NOW), undefined);
	assert.equal(quotaView(state, { provider: "other", api: ANTHROPIC }, NOW), undefined);
	assert.equal(quotaView(state, { api: ANTHROPIC }, NOW), undefined);
	assert.equal(quotaView(state, { provider: "sub" }, NOW), undefined);
	assert.equal(quotaView(state, { provider: "sub", api: "openai-completions" }, NOW), undefined);
	assert.equal(quotaView(state, { provider: "sub", api: CODEX }, NOW), undefined, "the api now speaks the other family");
	assert.equal(quotaView(state, {}, NOW), undefined);

	// Either api of a family still maps to it.
	const codex = stateOf({ "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300" }, "openai-responses", "codex");
	assert.equal(shown(quotaView(codex, { provider: "codex", api: CODEX }, NOW)), "5h 50%");
	assert.equal(quotaView(codex, { provider: "codex", api: ANTHROPIC }, NOW), undefined);
});

test("view: two windows, the binding one and the three texts", () => {
	const view = quotaView(stateOf({
		"anthropic-ratelimit-unified-5h-utilization": "0.43",
		"anthropic-ratelimit-unified-7d-utilization": "0.81",
	}), SUB, NOW);
	const short = { label: "5h", percent: 43, level: "normal", text: "5h 43%", aged: false };
	const long = { label: "wk", percent: 81, level: "warn", text: "wk 81%", aged: false };
	assert.deepEqual(view, { windows: [short, long], binding: long, hot: true, aged: false, limited: false, two: "5h 43% · wk 81%", one: "wk 81%", limit: "" });
	assert.equal(view?.binding, view?.windows[1], "the binding window is one of the list");

	// The short window can be the binding one; percents print unpadded.
	const other = quotaView(stateOf({
		"anthropic-ratelimit-unified-5h-utilization": "1",
		"anthropic-ratelimit-unified-7d-utilization": "0.05",
	}), SUB, NOW);
	assert.equal(other?.two, "5h 100% · wk 5%");
	assert.equal(other?.one, "5h 100%");
	assert.equal(other?.binding, other?.windows[0]);
	assert.equal(other?.binding?.level, "critical");

	// One window: the two-window form does not exist.
	const single = quotaView(stateOf({ "anthropic-ratelimit-unified-7d-utilization": "0.85" }), SUB, NOW);
	assert.deepEqual([single?.two, single?.one, single?.limit], ["", "wk 85%", ""]);
});

test("view: a tie binds the longer window", () => {
	const anthropic = quotaView(stateOf({
		"anthropic-ratelimit-unified-5h-utilization": "0.5",
		"anthropic-ratelimit-unified-7d-utilization": "0.5",
	}), SUB, NOW);
	assert.equal(anthropic?.one, "wk 50%");
	assert.equal(anthropic?.binding, anthropic?.windows[1]);

	// Whatever slot the longer window arrived in.
	const codex = quotaView(stateOf({
		"x-codex-primary-used-percent": "100",
		"x-codex-primary-window-minutes": "43200",
		"x-codex-secondary-used-percent": "100",
		"x-codex-secondary-window-minutes": "1440",
	}, CODEX), { provider: "sub", api: CODEX }, NOW);
	assert.equal(codex?.two, "1d 100% · 30d 100%");
	assert.equal(codex?.one, "30d 100%");
});

test("view: levels follow the context thresholds on the printed percent", () => {
	const at = (percent: number) => quotaView(
		stateOf({ "x-codex-primary-used-percent": String(percent), "x-codex-primary-window-minutes": "300" }, CODEX),
		{ provider: "sub", api: CODEX },
		NOW,
	);
	const expected: readonly (readonly [number, string, boolean])[] = [
		[0, "normal", false], [70, "normal", false], [70.4, "normal", false], [70.5, "warn", true], [71, "warn", true],
		[90, "warn", true], [90.4, "warn", true], [90.5, "critical", true], [91, "critical", true], [100, "critical", true],
	];
	for (const [percent, level, hot] of expected) {
		const view = at(percent);
		assert.equal(view?.binding?.level, level, `level at ${percent}`);
		assert.equal(view?.hot, hot, `hot at ${percent}`);
	}
});

test("view: a window ends exactly at its reset instant", () => {
	const state = stateOf({
		"anthropic-ratelimit-unified-5h-utilization": "0.95",
		"anthropic-ratelimit-unified-5h-reset": String(NOW_S + HOUR_S),
		"anthropic-ratelimit-unified-7d-utilization": "0.2",
		"anthropic-ratelimit-unified-7d-reset": String(NOW_S + DAY_S),
	});
	const shortEnds = NOW + HOUR_S * 1000;
	const longEnds = NOW + DAY_S * 1000;

	assert.equal(quotaView(state, SUB, shortEnds - 1)?.two, "5h 95% · wk 20%");
	assert.equal(quotaView(state, SUB, shortEnds - 1)?.one, "5h 95%");
	const after = quotaView(state, SUB, shortEnds);
	assert.deepEqual([after?.two, after?.one], ["", "wk 20%"], "the binding window is chosen among the live ones");
	assert.equal(after?.hot, false);
	assert.equal(quotaView(state, SUB, longEnds - 1)?.one, "wk 20%");
	assert.equal(quotaView(state, SUB, longEnds), undefined);
	assert.equal(quotaView(state, SUB, longEnds + DAY_S * 1000), undefined);
});

test("view: thirty minutes without news ages a figure, and so does a clock that stepped back", () => {
	assert.equal(QUOTA_STALE_MS, 30 * 60_000);

	const dated = stateOf(OBSERVED);
	assert.equal(quotaView(dated, SUB, NOW + QUOTA_STALE_MS)?.aged, false);
	const old = quotaView(dated, SUB, NOW + QUOTA_STALE_MS + 1);
	assert.equal(old?.aged, true);
	assert.equal(old?.binding?.aged, true);
	assert.equal(old?.hot, true, "the caller keeps a hot figure lit however old");
	assert.equal(old?.one, "wk 81%", "a window with a reset outlives the aging");

	// A negative age is aged too: the figure is dated after now, so nothing vouches for it.
	assert.equal(quotaView(dated, SUB, NOW)?.aged, false);
	assert.equal(quotaView(dated, SUB, NOW - 1)?.aged, true);
	assert.equal(quotaView(dated, SUB, NOW - 60_000)?.aged, true);
	assert.equal(quotaView(dated, SUB, NOW - 60_000)?.one, "wk 81%");

	// Each window ages by its own last sighting; the view's flag is the binding window's.
	const mixed = nextQuota(
		stateOf({ "anthropic-ratelimit-unified-5h-utilization": "0.6", "anthropic-ratelimit-unified-5h-reset": String(NOW_S + 4 * HOUR_S) }),
		{ status: 200, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.2", "anthropic-ratelimit-unified-7d-reset": String(NOW_S + DAY_S) }, api: ANTHROPIC, provider: "sub" },
		NOW + 20 * MINUTE,
	);
	const view = quotaView(mixed, SUB, NOW + 40 * MINUTE);
	assert.deepEqual(view?.windows.map((item) => [item.label, item.aged]), [["5h", true], ["wk", false]]);
	assert.equal(view?.binding?.label, "5h");
	assert.equal(view?.aged, true);

	// Undated: kept through the thirtieth minute either side of its sighting, gone after.
	const undated = stateOf({ "anthropic-ratelimit-unified-7d-utilization": "0.2" });
	assert.equal(quotaView(undated, SUB, NOW + QUOTA_STALE_MS)?.one, "wk 20%");
	assert.equal(quotaView(undated, SUB, NOW + QUOTA_STALE_MS)?.aged, false);
	assert.equal(quotaView(undated, SUB, NOW + QUOTA_STALE_MS + 1), undefined);
	assert.equal(quotaView(undated, SUB, NOW - QUOTA_STALE_MS)?.aged, true);
	assert.equal(quotaView(undated, SUB, NOW - QUOTA_STALE_MS - 1), undefined);
});

// --- generated inputs -------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Kind = "fraction" | "percent" | "minutes" | "epoch" | "seconds" | "word";

const GENERATED_KEYS: readonly (readonly [string, Kind])[] = [
	["anthropic-ratelimit-unified-5h-utilization", "fraction"],
	["anthropic-ratelimit-unified-5h-reset", "epoch"],
	["anthropic-ratelimit-unified-7d-utilization", "fraction"],
	["anthropic-ratelimit-unified-7d-reset", "epoch"],
	["anthropic-ratelimit-unified-7d-status", "word"],
	["anthropic-ratelimit-unified-representative-claim", "word"],
	["anthropic-ratelimit-unified-reset", "epoch"],
	["x-codex-primary-used-percent", "percent"],
	["x-codex-primary-window-minutes", "minutes"],
	["x-codex-primary-reset-at", "epoch"],
	["x-codex-primary-reset-after-seconds", "seconds"],
	["x-codex-secondary-used-percent", "percent"],
	["x-codex-secondary-window-minutes", "minutes"],
	["x-codex-secondary-reset-at", "epoch"],
	["x-codex-secondary-reset-after-seconds", "seconds"],
	["x-other-primary-used-percent", "percent"],
	["x-other-primary-window-minutes", "minutes"],
	["__proto__", "word"],
	["constructor", "fraction"],
	["toString", "percent"],
	["retry-after", "seconds"],
];

// None of these shares four consecutive characters with any text the module
// can produce (digit runs of at most three, then "h", "d", "%", "wk " or
// "limit"), so the echo check below cannot fail by coincidence.
const JUNK: readonly string[] = [
	"", "allowed_warning", "seven_day", "org_level_disabled", "rejected", "\u001b[31m0.5\u001b[0m", "\u001b]0;owned\u0007",
	"NaN", "Infinity", "-0.5", "+0.5", "5e-1", "0x1F", "0.5\n", "\t0.5", "0.5abc", "１２３", "‮0.81", "<b>81</b>", "0,81",
	"9".repeat(41), "../../etc/passwd", "${process.env.HOME}", "true",
];
const JUNK_SUFFIXES: readonly string[] = ["abc", "\n", "e3", "_", "\u001b[2J", ".", "\u0000"];
const NON_STRING_VALUES: readonly unknown[] = [0.5, 300, 1795316400, null, undefined, true, ["0.5"], { toString: () => "0.5" }];
const GENERATED_MINUTES: readonly number[] = [300, 299, 10080, 10079, 60, 720, 1440, 20160, 43200, 0, 45, 330, 1500, 527040];
const GENERATED_APIS: readonly (string | undefined)[] = [ANTHROPIC, ANTHROPIC, CODEX, "openai-responses", "openai-completions", undefined];
const GENERATED_PROVIDERS: readonly (string | undefined)[] = ["sub", "sub", "other", undefined];

test("generated input: nothing throws, numbers stay in range, no input text comes back out", () => {
	const random = mulberry32(0x1337);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
	const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

	const plausible = (kind: Kind): string => {
		switch (kind) {
			case "fraction": return (random() * 1.3).toFixed(between(0, 4));
			case "percent": return (random() * 110).toFixed(between(0, 2));
			case "minutes": return String(pick(GENERATED_MINUTES));
			case "epoch": return String(NOW_S + between(-HOUR_S, 9 * DAY_S));
			case "seconds": return String(between(0, 9 * DAY_S));
			case "word": return pick(JUNK);
		}
	};
	const value = (kind: Kind): unknown => {
		const roll = random();
		if (roll < 0.7) return plausible(kind);
		if (roll < 0.82) return pick(JUNK);
		if (roll < 0.92) return plausible(kind) + pick(JUNK_SUFFIXES);
		return pick(NON_STRING_VALUES);
	};
	/** A slot of a stream event: numbers mostly, sometimes the junk a string field would carry. */
	const slot = (inputs: string[]): unknown => {
		if (random() < 0.2) return null;
		const field = (kind: Kind): unknown => {
			if (random() < 0.8) return Number(plausible(kind));
			const generated = value(kind);
			if (typeof generated === "string") inputs.push(generated);
			return generated;
		};
		return { used_percent: field("percent"), window_minutes: field("minutes"), reset_at: field("epoch"), reset_after_seconds: field("seconds") };
	};

	const LABEL = /^(\d{1,3}[hd]|wk)$/;
	const TEXT = /^(\d{1,3}[hd]|wk) (\d{1,2}|100)%$/;
	const inRange = (percent: number) => Number.isInteger(percent) && percent >= 0 && percent <= 100;

	let state: QuotaState = EMPTY_QUOTA;
	let parsed = 0;
	let twoWindows = 0;
	let viewed = 0;
	let limits = 0;
	let events = 0;

	for (let round = 0; round < 4000; round++) {
		const headers: Record<string, unknown> = random() < 0.1 ? Object.create(null) : {};
		const inputs: string[] = [];
		const density = random();
		for (const [key, kind] of GENERATED_KEYS) {
			if (random() > density) continue;
			const generated = value(kind);
			// defineProperty, so "__proto__" becomes an own key instead of a prototype assignment.
			Object.defineProperty(headers, key, { value: generated, enumerable: true, writable: true, configurable: true });
			if (typeof generated === "string") inputs.push(generated);
		}
		const api = pick(GENERATED_APIS);
		const provider = pick(GENERATED_PROVIDERS);
		const at = NOW + round;
		const texts: string[] = [];

		const check = (snapshot: ReturnType<typeof parseQuotaHeaders>) => {
			if (!snapshot) return;
			if (snapshot.windows.length === 2) twoWindows++;
			assert.ok(snapshot.windows.length >= 1 && snapshot.windows.length <= 2, "one or two windows");
			assert.ok(snapshot.windows.every((item, index) => index === 0 || item.minutes > (snapshot.windows[index - 1]?.minutes ?? 0)), "shortest first, no duplicates");
			for (const item of snapshot.windows) {
				assert.ok(inRange(item.percent), `percent ${item.percent}`);
				assert.match(item.label, LABEL);
				assert.equal(item.label, quotaLabel(item.minutes), "stored minutes are canonical");
				assert.equal(item.seenAtMs, at);
				if (item.resetAtMs !== undefined) {
					assert.ok(item.resetAtMs > at && item.resetAtMs <= at + (item.minutes + 1440) * 60_000, "a kept reset is ahead and plausible");
				}
				texts.push(item.label);
			}
		};

		const snapshot = parseQuotaHeaders(headers, api, at);
		if (snapshot) parsed++;
		check(snapshot);
		state = nextQuota(state, { status: pick([200, 200, 200, 204, 429, 500]), headers, api, provider }, at);

		if (random() < 0.3) {
			const data = { type: pick(["codex.rate_limits", "codex.rate_limits", "response.created"]), rate_limits: { primary: slot(inputs), secondary: slot(inputs) } };
			const eventApi = pick([CODEX, CODEX, "openai-responses"]);
			const fromEvent = parseQuotaEvent(data, eventApi, at);
			if (fromEvent) events++;
			check(fromEvent);
			state = nextQuotaEvent(state, { provider, api: eventApi, data }, at);
		}
		if (random() < 0.15) {
			// Message text is not part of the echo check: the limit form is a constant, not a copy.
			const message = pick([limitMessage({ provider }), assistant({ provider }), assistant({ provider, stopReason: "error", errorMessage: pick(JUNK) }), { role: "user" }]);
			state = nextQuotaMessage(state, message, pick(GENERATED_PROVIDERS), at);
		}

		assert.ok(state.accounts.length <= 2, "one account per provider");
		for (const account of state.accounts) {
			assert.ok(account.provider === "sub" || account.provider === "other", "never stored without a provider");
			assert.ok(account.windows.length <= 2);
			assert.ok(account.windows.length > 0 || account.limited, "an account always says something");
		}

		const view = quotaView(state, { provider: pick(["sub", "other"]), api: pick(GENERATED_APIS) }, at + between(0, 40 * 60_000));
		if (view) {
			viewed++;
			assert.ok(view.windows.length <= 2, "at most two windows in view");
			assert.equal(view.hot, view.limited || (view.binding?.percent ?? 0) > 70);
			assert.equal(view.aged, view.binding?.aged ?? false);
			assert.equal(view.limit, view.limited ? "limit" : "");
			assert.equal(view.one, view.limited ? "" : view.binding?.text);
			assert.equal(view.two, !view.limited && view.windows.length === 2 ? view.windows.map((item) => item.text).join(" · ") : "");
			assert.ok(view.limit || view.one, "a view always has a form to print");
			if (view.limited) limits++;
			else assert.ok(view.binding && view.windows.includes(view.binding));
			for (const item of view.windows) {
				assert.ok(inRange(item.percent), `percent ${item.percent}`);
				assert.ok(item.percent <= (view.binding?.percent ?? 0));
				assert.match(item.label, LABEL);
				assert.match(item.text, TEXT);
				assert.equal(item.level, item.percent > 90 ? "critical" : item.percent > 70 ? "warn" : "normal");
				texts.push(item.label, item.text);
			}
			texts.push(view.two, view.one, view.limit);
		}

		for (const input of inputs) {
			for (let start = 0; start + 4 <= input.length; start++) {
				const piece = input.slice(start, start + 4);
				for (const text of texts) assert.ok(!text.includes(piece), `output ${JSON.stringify(text)} repeats ${JSON.stringify(piece)} from an input`);
			}
		}
	}

	// The loop must have exercised real output, not four thousand rejections.
	assert.ok(parsed > 500, `snapshots parsed: ${parsed}`);
	assert.ok(events > 100, `stream events parsed: ${events}`);
	assert.ok(twoWindows > 50, `two-window snapshots: ${twoWindows}`);
	assert.ok(viewed > 300, `views produced: ${viewed}`);
	assert.ok(limits > 30, `limit views: ${limits}`);
});
