import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeHex, OSC11_RESET, osc11Set, resolveBackground, resolveBackgroundHex } from "../src/background.ts";

test("normalizeHex expands #rgb, lowercases, trims, and rejects junk", () => {
	assert.equal(normalizeHex("#0a0303"), "#0a0303");
	assert.equal(normalizeHex("  #0A0303 "), "#0a0303"); // trimmed + lowercased
	assert.equal(normalizeHex("#abc"), "#aabbcc"); // shorthand expanded
	assert.equal(normalizeHex("#ABC"), "#aabbcc");
	assert.equal(normalizeHex("0a0303"), undefined); // missing #
	assert.equal(normalizeHex("#12"), undefined); // wrong length
	assert.equal(normalizeHex("#1234"), undefined);
	assert.equal(normalizeHex("#gggggg"), undefined); // non-hex digits
	assert.equal(normalizeHex(""), undefined);
	assert.equal(normalizeHex(undefined), undefined);
});

test("osc11Set builds a BEL-terminated OSC 11 set sequence", () => {
	assert.equal(osc11Set("#0a0303"), "\x1b]11;#0a0303\x07");
});

test("OSC11_RESET is the OSC 111 reset-to-default sequence", () => {
	assert.equal(OSC11_RESET, "\x1b]111\x07");
});

test("resolveBackgroundHex prefers a valid override, else the theme pageBg", () => {
	assert.equal(resolveBackgroundHex("#123456", "#0a0303"), "#123456"); // override wins
	assert.equal(resolveBackgroundHex("#ABC", "#0a0303"), "#aabbcc"); // override normalized
	assert.equal(resolveBackgroundHex(undefined, "#0a0303"), "#0a0303"); // fall back to theme void
	assert.equal(resolveBackgroundHex("nonsense", "#0a0303"), "#0a0303"); // invalid override ignored
	assert.equal(resolveBackgroundHex(undefined, undefined), undefined); // nothing usable → untouched
	assert.equal(resolveBackgroundHex("bad", "also-bad"), undefined);
});

test("resolveBackground lets env override the theme, and reads on/off/hex", () => {
	// Off by default: neither source opts in → terminal untouched.
	assert.deepEqual(resolveBackground(undefined, undefined), { enabled: false });
	// Theme opts in when the env var is unset.
	assert.deepEqual(resolveBackground(undefined, "on"), { enabled: true });
	assert.deepEqual(resolveBackground(undefined, "#0a0303"), { enabled: true, hex: "#0a0303" });
	assert.deepEqual(resolveBackground(undefined, "off"), { enabled: false });
	// A defined env value wins over the theme — including an explicit off/empty.
	assert.deepEqual(resolveBackground("off", "on"), { enabled: false });
	assert.deepEqual(resolveBackground("", "on"), { enabled: false });
	assert.deepEqual(resolveBackground("on", undefined), { enabled: true });
	assert.deepEqual(resolveBackground("#112233", "on"), { enabled: true, hex: "#112233" });
	assert.deepEqual(resolveBackground("AUTO", "off"), { enabled: true }); // case-insensitive, no explicit hex
});
