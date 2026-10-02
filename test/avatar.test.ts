import assert from "node:assert/strict";
import { test } from "node:test";
import { getCapabilities, getCellDimensions, renderImage, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { avatarImageColumns, parseAvatar, selectAvatar } from "../src/avatar.ts";

test("avatar centering uses the columns actually reserved by Kitty and iTerm2", () => {
	const caps = getCapabilities();
	const cell = getCellDimensions();
	try {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const dims = { widthPx: 46, heightPx: 100 }; // ideal 9.2 columns at height 10
		for (const [protocol, expected] of [["kitty", 9], ["iterm2", 10]] as const) {
			setCapabilities({ ...caps, images: protocol });
			const rendered = renderImage("AA==", dims, { maxWidthCells: 18, maxHeightCells: 10, moveCursor: false });
			assert.equal(rendered?.columns, expected, `${protocol} public renderer oracle`);
			const span = avatarImageColumns(dims, getCellDimensions(), 18, 10, protocol);
			assert.equal(span, rendered.columns, `${protocol}: centering must match Pi's reserved width`);
			assert.equal(Math.floor((41 - span) / 2), protocol === "kitty" ? 16 : 15);
		}
	} finally {
		setCapabilities(caps);
		setCellDimensions(cell);
	}
});

test("avatar image columns respect the same narrow widget cap as Image.render", () => {
	const caps = getCapabilities();
	const cell = getCellDimensions();
	try {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		for (const protocol of ["kitty", "iterm2"] as const) {
			setCapabilities({ ...caps, images: protocol });
			const dims = { widthPx: 200, heightPx: 50 };
			const maxWidth = Math.max(1, Math.min(12 - 2, 18));
			const rendered = renderImage("AA==", dims, { maxWidthCells: maxWidth, maxHeightCells: 10, moveCursor: false });
			assert.equal(avatarImageColumns(dims, getCellDimensions(), maxWidth, 10, protocol), rendered?.columns);
		}
	} finally {
		setCapabilities(caps);
		setCellDimensions(cell);
	}
});

test("parseAvatar returns undefined when the theme ships no avatar", () => {
	assert.equal(parseAvatar(undefined), undefined);
	assert.equal(parseAvatar(null), undefined);
	assert.equal(parseAvatar({}), undefined);
	assert.equal(parseAvatar([]), undefined);
	assert.equal(parseAvatar(42), undefined);
	assert.equal(parseAvatar("   "), undefined);
});

test("parseAvatar reads a bare PNG path as a pinned image (idle + working)", () => {
	assert.deepEqual(parseAvatar("assets/vaultboy.png"), {
		idle: { image: "assets/vaultboy.png" },
		working: { image: "assets/vaultboy.png" },
	});
});

test("parseAvatar reads the four per-state image frames", () => {
	assert.deepEqual(
		parseAvatar({ idle: "a/wink.png", working: "a/gum.png", confused: "a/dizzy.png", error: "a/ko.png" }),
		{
			idle: { image: "a/wink.png" },
			working: { image: "a/gum.png" },
			confused: { image: "a/dizzy.png" },
			error: { image: "a/ko.png" },
		},
	);
	// A single named state is enough; the rest fall back.
	assert.deepEqual(parseAvatar({ error: "a/ko.png" }), { idle: undefined, working: undefined, confused: undefined, error: { image: "a/ko.png" } });
});

test("parseAvatar still accepts ASCII frames (fallback art)", () => {
	assert.deepEqual(parseAvatar(["o", "/|\\"]), { idle: { lines: ["o", "/|\\"] }, working: { lines: ["o", "/|\\"] } });
	assert.deepEqual(parseAvatar({ working: "a\nb" }), { idle: undefined, working: { lines: ["a", "b"] }, confused: undefined, error: undefined });
});

test("parseAvatar makes custom ASCII frames safe for one terminal row", () => {
	assert.deepEqual(parseAvatar(["\x1b[2Jred\r\nspoof\u202e", "👩‍⚕️ 医療"]), {
		idle: { lines: ["red spoof", "👩‍⚕️ 医療"] },
		working: { lines: ["red spoof", "👩‍⚕️ 医療"] },
	});
});

test("selectAvatar returns the frame for each state", () => {
	const frames = parseAvatar({ idle: "wink.png", working: "gum.png", confused: "dizzy.png", error: "ko.png" });
	assert.deepEqual(selectAvatar(frames, "idle"), { image: "wink.png" });
	assert.deepEqual(selectAvatar(frames, "working"), { image: "gum.png" });
	assert.deepEqual(selectAvatar(frames, "confused"), { image: "dizzy.png" });
	assert.deepEqual(selectAvatar(frames, "error"), { image: "ko.png" });
});

test("selectAvatar falls back toward idle; idle never borrows another state", () => {
	const only = parseAvatar("wink.png"); // idle + working = wink, no confused/error
	assert.deepEqual(selectAvatar(only, "confused"), { image: "wink.png" }); // confused → working → idle
	assert.deepEqual(selectAvatar(only, "error"), { image: "wink.png" }); // error → idle
	// working-only: idle stays hidden, other states fall back to working.
	const w = parseAvatar({ working: "gum.png" });
	assert.equal(selectAvatar(w, "idle"), undefined);
	assert.deepEqual(selectAvatar(w, "confused"), { image: "gum.png" });
	assert.equal(selectAvatar(w, "error"), undefined); // error → idle (absent) → hidden
	assert.equal(selectAvatar(undefined, "working"), undefined);
});
