import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name: string; version: string };
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
	name: string;
	version: string;
	packages: { "": { name: string; version: string } };
};

test("package identity is aligned in the manifest and root lock entry", () => {
	assert.equal(manifest.name, "pi-theme-1337");
	assert.equal(lock.name, manifest.name);
	assert.equal(lock.packages[""].name, manifest.name);
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
});
