/**
 * Pure subscription-quota tracking for the status row.
 *
 * Some providers say, on a response, how much of a subscription's rate window
 * is used. This module turns what Pi already hands extensions into the two or
 * three numbers the row prints. It makes no request of its own, starts no
 * timer and reads no clock: time is injected, and every exported function is
 * total — no input makes one throw.
 *
 * Three observations feed one state, kept per provider:
 *
 *   - response headers (`after_provider_response`), in one of two vocabularies
 *     chosen by the model's api and read by exact name: Anthropic's
 *     `anthropic-ratelimit-unified-{5h,7d}-*` (a FRACTION used, reset in epoch
 *     SECONDS) and Codex's `x-codex-{primary,secondary}-*` (a PERCENT used, a
 *     declared window length, reset in epoch seconds or seconds from now);
 *   - the Codex stream event `codex.rate_limits` (`provider_stream_event`),
 *     which carries the same figures as JSON numbers;
 *   - an assistant message that ended in a usage-limit error (`message_end`),
 *     the only signal some routes give.
 *
 * Headers, events and error text are foreign. Nothing read from one is ever
 * returned as text: values are matched against strict numeric patterns (or
 * `typeof === "number"`), only parsed numbers leave, and every label is
 * generated here from a canonical duration.
 *
 * A response rarely carries every window, so windows are kept per canonical
 * duration, each with the time it was last seen. A window leaves when its
 * reset passes, or — without a believable reset — QUOTA_STALE_MS after it was
 * last seen. Two successful responses in a row without any quota mean the
 * account or its auth changed, and drop everything known about that provider.
 */

import { usageLevel, type UsageLevel } from "./format.ts";

/** Which header vocabulary a response speaks. Chosen by the model's api, never by provider id. */
export type QuotaFamily = "anthropic" | "codex";

/** One rate window as last reported. */
export interface QuotaWindow {
	/** Canonical length: whole hours under a day, whole days from there. */
	readonly minutes: number;
	/** Generated from `minutes`: "5h", "wk", "30d". Never copied from a header. */
	readonly label: string;
	/** Whole percent USED, 0..100. */
	readonly percent: number;
	/** When the window renews. Absent when it was missing or implausible; the window then ages out. */
	readonly resetAtMs?: number;
	/** When this figure was last reported. */
	readonly seenAtMs: number;
}

/** What one response or stream event said: one or two windows, shortest first. */
export interface QuotaSnapshot {
	readonly family: QuotaFamily;
	readonly windows: readonly QuotaWindow[];
}

/** Everything known about one provider's subscription. Never stored without a provider. */
export interface QuotaAccount {
	readonly provider: string;
	/** The family `windows` were read in; absent while there are none. */
	readonly family?: QuotaFamily;
	/** One per canonical duration, shortest first, at most MAX_WINDOWS. */
	readonly windows: readonly QuotaWindow[];
	/** Consecutive successful responses that carried no quota. */
	readonly misses: number;
	/** The last assistant message from this provider ended in a usage-limit error. */
	readonly limited: boolean;
}

/** One account per provider, so a model switch away and back finds its figures again. */
export interface QuotaState {
	readonly accounts: readonly QuotaAccount[];
}

export const EMPTY_QUOTA: QuotaState = { accounts: [] };

/** The slice of a provider response the reducer needs. */
export interface QuotaResponse {
	readonly status: number;
	readonly headers: unknown;
	readonly api?: string;
	readonly provider?: string;
}

/** The slice of a raw provider stream event the reducer needs. */
export interface QuotaStreamEvent {
	readonly provider?: string;
	readonly api?: string;
	readonly data: unknown;
}

export interface QuotaViewWindow {
	readonly label: string;
	readonly percent: number;
	/** Same thresholds as the context percentage: above 70 warn, above 90 critical. */
	readonly level: UsageLevel;
	/** "5h 43%". */
	readonly text: string;
	/** Not heard of for QUOTA_STALE_MS (or dated in the future): a calm figure may recede. */
	readonly aged: boolean;
}

/** Everything the status row needs, and nothing else. */
export interface QuotaView {
	/** Live windows, shortest first; empty when only the limit is known. */
	readonly windows: readonly QuotaViewWindow[];
	/** The window closest to its limit (a tie goes to the longer one); one of `windows`. */
	readonly binding?: QuotaViewWindow;
	/** The binding window is above 70%, or the limit is reached: never paint it dim, never drop it as an ornament. */
	readonly hot: boolean;
	/** The binding window's figure is aged. */
	readonly aged: boolean;
	/** The provider's last assistant message ended in a usage-limit error. */
	readonly limited: boolean;
	/** Two-window form, "5h 43% · wk 12%"; "" unless two windows are live and the limit is not reached. */
	readonly two: string;
	/** One-window form, the binding window alone, "wk 85%"; "" when the limit is reached. */
	readonly one: string;
	/** Limit form, "limit"; "" unless the limit is reached. It replaces the windows. */
	readonly limit: string;
}

/** Past this age a figure is `aged`, and a window with no known reset is dropped. */
export const QUOTA_STALE_MS = 30 * 60_000;

/** Joins the windows of the two-window form; the status row's own item separator. */
export const QUOTA_SEPARATOR = " · ";

/** What the row prints in place of the windows once the limit is reached. */
export const QUOTA_LIMIT_TEXT = "limit";

/** The api whose raw stream carries `codex.rate_limits` events. */
export const CODEX_STREAM_API = "openai-codex-responses";
/** The `type` of that event. */
export const CODEX_RATE_LIMITS_EVENT = "codex.rate_limits";

/** Successful responses without quota before a provider's account is dropped. */
const MISSES_TO_CLEAR = 2;
/** Windows kept and shown per account. */
const MAX_WINDOWS = 2;
/** Accounts kept; the least recently touched goes first. */
const MAX_ACCOUNTS = 8;
/** A provider id longer than this is not one worth keying on. */
const MAX_PROVIDER_LENGTH = 128;
/** Only this much of an error message is inspected for the usage-limit phrase. */
const MAX_ERROR_LENGTH = 512;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;
/** A window longer than a year is not a rate window. */
const MAX_DAYS = 365;
/** A declared length this close to a whole hour or day is that length (299 → 300, 10079 → 10080). */
const SNAP_TOLERANCE = 0.05;
/** A reset may sit this far past now + the window's own length before it is disbelieved. */
const RESET_SLACK_MS = DAY_MINUTES * MINUTE_MS;
/** A percent (or a fraction ×100) above this is not a reading of a window; up to it, it clamps to 100. */
const MAX_PERCENT = 1000;
/** The widest integer the header patterns admit: nine digits. */
const MAX_INTEGER = 999_999_999;
/** Epoch seconds are ten digits from 2001 to 2286. */
const MIN_EPOCH_SECONDS = 1_000_000_000;
const MAX_EPOCH_SECONDS = 9_999_999_999;

// No sign, exponent, radix prefix, whitespace or leading zero; `\d` without the
// `u`/`v` flag is ASCII only. Twenty fraction digits cover a float printed in
// full. Each pattern is anchored with bounded repetition, so it bounds the
// length it reads by itself: a megabyte of header fails after a few characters.
const DECIMAL = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,20})?$/;
const INTEGER = /^(?:0|[1-9]\d{0,8})$/;
const EPOCH_SECONDS = /^[1-9]\d{9}$/;

/**
 * The account-wide windows of the Anthropic family, a closed set: both have a
 * fixed, known duration, which the header name states and nothing else does.
 * Other `unified-*` claims are left out on purpose — a model-scoped weekly
 * figure would collide with "wk" while measuring something else, and overage
 * is a spend allowance, not a window.
 */
const ANTHROPIC_WINDOWS = [
	{ minutes: 300, used: "anthropic-ratelimit-unified-5h-utilization", reset: "anthropic-ratelimit-unified-5h-reset" },
	{ minutes: WEEK_MINUTES, used: "anthropic-ratelimit-unified-7d-utilization", reset: "anthropic-ratelimit-unified-7d-reset" },
] as const;

/**
 * The Codex family names its slots "primary"/"secondary", which says nothing
 * about their length: each slot declares its own `window-minutes`.
 */
const CODEX_WINDOWS = [
	{
		slot: "primary",
		used: "x-codex-primary-used-percent",
		minutes: "x-codex-primary-window-minutes",
		resetAt: "x-codex-primary-reset-at",
		resetAfter: "x-codex-primary-reset-after-seconds",
	},
	{
		slot: "secondary",
		used: "x-codex-secondary-used-percent",
		minutes: "x-codex-secondary-window-minutes",
		resetAt: "x-codex-secondary-reset-at",
		resetAfter: "x-codex-secondary-reset-after-seconds",
	},
] as const;

/** A header under one of these belongs to its family's quota, readable or not. */
const FAMILY_PREFIXES: Record<QuotaFamily, readonly string[]> = {
	anthropic: ["anthropic-ratelimit-unified-"],
	codex: ["x-codex-primary-", "x-codex-secondary-"],
};

/** The header family an api speaks; `undefined` keeps gateways and virtual models out. */
export function quotaFamily(api: unknown): QuotaFamily | undefined {
	if (api === "anthropic-messages") return "anthropic";
	if (api === "openai-responses" || api === CODEX_STREAM_API) return "codex";
	return undefined;
}

/** The label of a canonical window length, or `undefined` when it has no clean name. */
export function quotaLabel(minutes: number): string | undefined {
	if (!Number.isInteger(minutes) || minutes <= 0) return undefined;
	if (minutes === WEEK_MINUTES) return "wk";
	if (minutes % DAY_MINUTES === 0) return minutes / DAY_MINUTES <= MAX_DAYS ? `${minutes / DAY_MINUTES}d` : undefined;
	return minutes < DAY_MINUTES && minutes % 60 === 0 ? `${minutes / 60}h` : undefined;
}

/** The whole multiple of `unit` nearest to `minutes` when it lies within the tolerance, the nearer neighbour first. */
function snapTo(minutes: number, unit: number): number | undefined {
	const below = Math.floor(minutes / unit) * unit;
	const above = below + unit;
	const candidates = minutes - below <= above - minutes ? [below, above] : [above, below];
	return candidates.find((candidate) => candidate > 0 && Math.abs(minutes - candidate) <= candidate * SNAP_TOLERANCE);
}

/**
 * The canonical length a declared one stands for: itself when it is whole
 * hours under a day or whole days; otherwise the whole hour (under a day) or
 * the whole day it lies within 5% of, as servers report 299 and 10079 for the
 * five-hour and weekly windows. `undefined` when it is neither.
 */
export function canonicalMinutes(minutes: number): number | undefined {
	if (!Number.isInteger(minutes) || minutes <= 0 || minutes > (MAX_DAYS + 1) * DAY_MINUTES) return undefined;
	if (quotaLabel(minutes) !== undefined) return minutes;
	const hours = snapTo(minutes, 60);
	const snapped = hours !== undefined && hours < DAY_MINUTES ? hours : snapTo(minutes, DAY_MINUTES);
	return snapped !== undefined && quotaLabel(snapped) !== undefined ? snapped : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null ? (value as Record<string, unknown>) : undefined;
}

function own(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function decimal(value: unknown): number | undefined {
	return typeof value === "string" && DECIMAL.test(value) ? Number(value) : undefined;
}

function integer(value: unknown): number | undefined {
	return typeof value === "string" && INTEGER.test(value) ? Number(value) : undefined;
}

function epochSeconds(value: unknown): number | undefined {
	return typeof value === "string" && EPOCH_SECONDS.test(value) ? Number(value) : undefined;
}

/** A JSON number that is a whole count within `min..max`. */
function wholeNumber(value: unknown, min: number, max: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function providerOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_LENGTH ? value : undefined;
}

/** Whole percent, clamped: a window can be reported past its limit. */
function percentOf(value: number | undefined): number | undefined {
	return value === undefined || !(value >= 0 && value <= MAX_PERCENT) ? undefined : Math.min(100, Math.round(value));
}

function windowOf(minutes: number | undefined, percent: number | undefined, resetAtMs: number | undefined, nowMs: number): QuotaWindow | undefined {
	if (minutes === undefined || percent === undefined) return undefined;
	const label = quotaLabel(minutes);
	if (label === undefined) return undefined;
	const undated: QuotaWindow = { minutes, label, percent, seenAtMs: nowMs };
	if (resetAtMs === undefined) return undated;
	// Already renewed: the figure describes a window that is over.
	if (resetAtMs <= nowMs) return undefined;
	// A reset further away than the window is long is not this window's: keep the figure, let it age out.
	if (resetAtMs > nowMs + minutes * MINUTE_MS + RESET_SLACK_MS) return undated;
	return { ...undated, resetAtMs };
}

/** The four numbers a Codex slot states, from headers or from the stream event. */
interface CodexSlot {
	readonly used?: number;
	readonly minutes?: number;
	readonly resetAtSeconds?: number;
	readonly resetAfterSeconds?: number;
}

function codexWindow(slot: CodexSlot, nowMs: number): QuotaWindow | undefined {
	// A PERCENT already: 0.73 is under one percent, not 73.
	const percent = percentOf(slot.used);
	const minutes = slot.minutes === undefined ? undefined : canonicalMinutes(slot.minutes);
	const resetAtMs = slot.resetAtSeconds !== undefined ? slot.resetAtSeconds * 1000
		: slot.resetAfterSeconds !== undefined ? nowMs + slot.resetAfterSeconds * 1000 : undefined;
	return windowOf(minutes, percent, resetAtMs, nowMs);
}

function anthropicWindows(headers: Record<string, unknown>, nowMs: number): (QuotaWindow | undefined)[] {
	return ANTHROPIC_WINDOWS.map((keys) => {
		// A FRACTION of the window: 0.81 is 81% used, and it can pass 1.
		const fraction = decimal(own(headers, keys.used));
		const reset = epochSeconds(own(headers, keys.reset));
		return windowOf(keys.minutes, percentOf(fraction === undefined ? undefined : fraction * 100), reset === undefined ? undefined : reset * 1000, nowMs);
	});
}

function codexHeaderWindows(headers: Record<string, unknown>, nowMs: number): (QuotaWindow | undefined)[] {
	return CODEX_WINDOWS.map((keys) => codexWindow({
		used: decimal(own(headers, keys.used)),
		minutes: integer(own(headers, keys.minutes)),
		resetAtSeconds: epochSeconds(own(headers, keys.resetAt)),
		resetAfterSeconds: integer(own(headers, keys.resetAfter)),
	}, nowMs));
}

/** The fuller of two readings of one window; a tie goes to the one that knows its reset, then to the first. */
function fuller(kept: QuotaWindow, next: QuotaWindow): QuotaWindow {
	if (next.percent !== kept.percent) return next.percent > kept.percent ? next : kept;
	return kept.resetAtMs === undefined && next.resetAtMs !== undefined ? next : kept;
}

/** One window per canonical duration, shortest first. */
function arrange(found: readonly (QuotaWindow | undefined)[]): QuotaWindow[] {
	const byDuration = new Map<number, QuotaWindow>();
	for (const window of found) {
		if (!window) continue;
		const kept = byDuration.get(window.minutes);
		byDuration.set(window.minutes, kept ? fuller(kept, window) : window);
	}
	return [...byDuration.values()].sort((a, b) => a.minutes - b.minutes).slice(0, MAX_WINDOWS);
}

function readHeaders(headers: unknown, api: unknown, nowMs: number): { snapshot?: QuotaSnapshot; present: boolean } {
	try {
		const family = quotaFamily(api);
		const record = plainObject(headers);
		if (!family || !record) return { present: false };
		const windows = arrange(family === "anthropic" ? anthropicWindows(record, nowMs) : codexHeaderWindows(record, nowMs));
		if (windows.length > 0) return { snapshot: { family, windows }, present: true };
		const prefixes = FAMILY_PREFIXES[family];
		return { present: Object.keys(record).some((key) => prefixes.some((prefix) => key.startsWith(prefix))) };
	} catch {
		// A hostile object (a throwing getter or proxy trap) is just a response without quota.
		return { present: false };
	}
}

/**
 * Read one response's quota headers. Never throws; `undefined` when the api
 * speaks no known family or the headers carry no valid window of it.
 */
export function parseQuotaHeaders(headers: unknown, api: string | undefined, nowMs: number): QuotaSnapshot | undefined {
	return readHeaders(headers, api, nowMs).snapshot;
}

/**
 * Read one raw stream event of the Codex api. The shape is the one Pi's own
 * Codex stream test replays (pi `packages/ai/test/openai-codex-stream.test.ts`):
 *
 *   { type: "codex.rate_limits",
 *     rate_limits: { primary: { used_percent: 7, window_minutes: 10080,
 *       reset_after_seconds: 556112, reset_at: 1785269351 }, secondary: null } }
 *
 * Only `typeof === "number"` fields are read, with the bounds the headers
 * have. Never throws; `undefined` for any other api, event or shape.
 */
export function parseQuotaEvent(data: unknown, api: string | undefined, nowMs: number): QuotaSnapshot | undefined {
	try {
		if (api !== CODEX_STREAM_API) return undefined;
		const event = plainObject(data);
		if (!event || own(event, "type") !== CODEX_RATE_LIMITS_EVENT) return undefined;
		const limits = plainObject(own(event, "rate_limits"));
		if (!limits) return undefined;
		const windows = arrange(CODEX_WINDOWS.map(({ slot }) => {
			const fields = plainObject(own(limits, slot));
			if (!fields) return undefined;
			const used = own(fields, "used_percent");
			return codexWindow({
				used: typeof used === "number" && Number.isFinite(used) ? used : undefined,
				minutes: wholeNumber(own(fields, "window_minutes"), 0, MAX_INTEGER),
				resetAtSeconds: wholeNumber(own(fields, "reset_at"), MIN_EPOCH_SECONDS, MAX_EPOCH_SECONDS),
				resetAfterSeconds: wholeNumber(own(fields, "reset_after_seconds"), 0, MAX_INTEGER),
			}, nowMs);
		}));
		return windows.length > 0 ? { family: "codex", windows } : undefined;
	} catch {
		return undefined;
	}
}

/** Still describing a running window: before its reset, or — undated — within QUOTA_STALE_MS of when it was seen. */
function alive(window: QuotaWindow, nowMs: number): boolean {
	return window.resetAtMs !== undefined ? nowMs < window.resetAtMs : Math.abs(nowMs - window.seenAtMs) <= QUOTA_STALE_MS;
}

function accountOf(state: QuotaState | undefined, provider: string | undefined): QuotaAccount | undefined {
	return provider === undefined ? undefined : state?.accounts.find((account) => account.provider === provider);
}

/** Replace (or, with `undefined`, remove) one provider's account; the touched one moves last, the oldest falls off. */
function withAccount(state: QuotaState | undefined, provider: string, account: QuotaAccount | undefined): QuotaState {
	const others = (state?.accounts ?? []).filter((kept) => kept.provider !== provider);
	const accounts = account ? [...others, account] : others;
	return { accounts: accounts.slice(Math.max(0, accounts.length - MAX_ACCOUNTS)) };
}

/**
 * Fold fresh windows into what is known: one per duration, the fresh reading
 * replacing the kept one, expired ones gone. Another family's windows are not
 * this account's any more. Over MAX_WINDOWS, the most recently seen stay.
 */
function mergeWindows(account: QuotaAccount | undefined, snapshot: QuotaSnapshot, nowMs: number): QuotaWindow[] {
	const byDuration = new Map<number, QuotaWindow>();
	if (account?.family === snapshot.family) {
		for (const window of account.windows) if (alive(window, nowMs)) byDuration.set(window.minutes, window);
	}
	for (const window of snapshot.windows) byDuration.set(window.minutes, window);
	return [...byDuration.values()]
		.sort((a, b) => b.seenAtMs - a.seenAtMs || b.percent - a.percent || b.minutes - a.minutes)
		.slice(0, MAX_WINDOWS)
		.sort((a, b) => a.minutes - b.minutes);
}

function withSnapshot(state: QuotaState | undefined, provider: string, snapshot: QuotaSnapshot, nowMs: number): QuotaState {
	const account = accountOf(state, provider);
	return withAccount(state, provider, {
		provider,
		family: snapshot.family,
		windows: mergeWindows(account, snapshot, nowMs),
		misses: 0,
		limited: account?.limited ?? false,
	});
}

/**
 * Fold one provider response into the state.
 *
 * Valid windows update the provider's account whatever the status: a 429 at
 * 100% is the most useful figure there is. A successful response without any
 * header of the family is a miss, and two in a row drop the account — the
 * account or its auth changed. A response whose family headers are present but
 * unusable is not a miss, and an unsuccessful one without quota says nothing.
 * Without a provider nothing is stored.
 */
export function nextQuota(state: QuotaState | undefined, response: QuotaResponse, nowMs: number): QuotaState {
	const before = state ?? EMPTY_QUOTA;
	try {
		const provider = providerOf(response.provider);
		if (provider === undefined) return before;
		const { status } = response;
		const { snapshot, present } = readHeaders(response.headers, response.api, nowMs);
		if (snapshot) return withSnapshot(before, provider, snapshot, nowMs);
		if (typeof status !== "number" || !(status >= 200 && status < 300) || present) return before;
		const account = accountOf(before, provider);
		if (!account) return before;
		const misses = account.misses + 1;
		return withAccount(before, provider, misses >= MISSES_TO_CLEAR ? undefined : { ...account, misses });
	} catch {
		return before;
	}
}

/** Fold one raw stream event into the state; anything but a readable Codex rate-limit event changes nothing. */
export function nextQuotaEvent(state: QuotaState | undefined, event: QuotaStreamEvent, nowMs: number): QuotaState {
	const before = state ?? EMPTY_QUOTA;
	try {
		const provider = providerOf(event.provider);
		const snapshot = provider === undefined ? undefined : parseQuotaEvent(event.data, event.api, nowMs);
		return provider !== undefined && snapshot ? withSnapshot(before, provider, snapshot, nowMs) : before;
	} catch {
		return before;
	}
}

/**
 * An assistant message that ended because the subscription's usage limit was
 * reached. On OpenAI's ChatGPT route this is the only signal there is: the
 * response is a 200 without quota headers and the message ends with
 * `stopReason: "error"` and "The ChatGPT user has reached their Subscription
 * Sharing usage limit. …". The test is deliberately narrow — the phrase "usage
 * limit", any case, within the first MAX_ERROR_LENGTH characters — so the
 * generic "rate limit" errors of pay-per-use APIs do not match.
 */
export function isUsageLimitMessage(message: unknown): boolean {
	try {
		if (typeof message !== "object" || message === null) return false;
		const { role, stopReason, errorMessage } = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
		return role === "assistant" && stopReason === "error" && typeof errorMessage === "string"
			&& errorMessage.slice(0, MAX_ERROR_LENGTH).toLowerCase().includes("usage limit");
	} catch {
		return false;
	}
}

/**
 * Fold the end of one message into the state. An assistant message that ended
 * in a usage-limit error marks its provider as limited (and is news about the
 * account, so the miss count starts again); that provider's next assistant
 * message that is an answer — neither an error nor an abort — clears the mark. The provider is the message's own, else
 * `fallbackProvider` (the current model's).
 */
export function nextQuotaMessage(state: QuotaState | undefined, message: unknown, fallbackProvider: string | undefined, nowMs: number): QuotaState {
	const before = state ?? EMPTY_QUOTA;
	try {
		if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "assistant") return before;
		const provider = providerOf((message as { provider?: unknown }).provider) ?? providerOf(fallbackProvider);
		if (provider === undefined) return before;
		const account = accountOf(before, provider);
		if (isUsageLimitMessage(message)) {
			if (account?.limited && account.misses === 0) return before;
			const windows = (account?.windows ?? []).filter((window) => alive(window, nowMs));
			return withAccount(before, provider, { provider, family: windows.length > 0 ? account?.family : undefined, windows, misses: 0, limited: true });
		}
		if (!account?.limited) return before;
		// Only an answer proves the limit lifted: an interrupted attempt or another
		// error (overloaded, network) says nothing about the account.
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		if (stopReason === "error" || stopReason === "aborted") return before;
		// Never keep an account that says nothing.
		return withAccount(before, provider, account.windows.length > 0 ? { ...account, limited: false } : undefined);
	} catch {
		return before;
	}
}

/**
 * What the status row shows for the current model, or `undefined` for nothing:
 * no account for its provider, or an account that is not limited and whose
 * windows are all over or were read in a family the current api does not speak.
 */
export function quotaView(
	state: QuotaState | undefined,
	current: { readonly provider?: string; readonly api?: string },
	nowMs: number,
): QuotaView | undefined {
	try {
		const account = accountOf(state, providerOf(current.provider));
		if (!account) return undefined;
		const live = account.family !== undefined && quotaFamily(current.api) === account.family
			? account.windows.filter((window) => alive(window, nowMs)).slice(0, MAX_WINDOWS) : [];
		const windows: QuotaViewWindow[] = live.map(({ label, percent, seenAtMs }) => {
			const age = nowMs - seenAtMs;
			return { label, percent, level: usageLevel(percent), text: `${label} ${percent}%`, aged: age < 0 || age > QUOTA_STALE_MS };
		});
		let binding = windows[0];
		// `>=` over a shortest-first list: a tie goes to the longer window, the one that takes longer to clear.
		for (const window of windows) if (binding && window.percent >= binding.percent) binding = window;
		const { limited } = account;
		if (!binding && !limited) return undefined;
		return {
			windows,
			...(binding ? { binding } : {}),
			hot: limited || (binding !== undefined && binding.level !== "normal"),
			aged: binding?.aged ?? false,
			limited,
			two: !limited && windows.length === 2 ? windows.map((window) => window.text).join(QUOTA_SEPARATOR) : "",
			one: !limited && binding ? binding.text : "",
			limit: limited ? QUOTA_LIMIT_TEXT : "",
		};
	} catch {
		return undefined;
	}
}
