import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "src", "index.ts"), "utf8");

test("only /theme-1337 is registered as the redesign toggle", () => {
	const registeredCommands = [...source.matchAll(/pi\.registerCommand\("([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(registeredCommands, ["theme-1337"]);
	assert.doesNotMatch(source, /\/pi-theme-1337\b|\/pi-1337\b|registerCommand\("(?:pi-theme-1337|pi-1337)"/);
});
