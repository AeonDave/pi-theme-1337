import assert from "node:assert/strict";
import { test } from "node:test";
import { isFoldableTool, isPolishedTool, tallyDetails, tallyName, tallySentence, tallySubject, toolWords } from "../src/tool-lexicon.ts";

const calls = (...names: string[]) => names.map(name => ({ name }));

const BUILTINS = ["bash", "read", "grep", "find", "ls", "edit", "write"];
const PROTOTYPE_KEYS = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"];

test("every builtin has a title and a progressive verb", () => {
	for (const name of BUILTINS) {
		const words = toolWords(name);
		assert.ok(words?.title, name);
		assert.match(words.doing, /^[A-Z][a-z]+ing$/, name);
		assert.equal(isPolishedTool(name), true, name);
	}
	assert.deepEqual(BUILTINS.filter(isFoldableTool), ["read", "grep", "find", "ls"], "bash has side effects and never folds");
	assert.deepEqual(BUILTINS.filter(name => toolWords(name)?.quiet), ["bash", "read", "grep", "find", "ls"]);
});

test("model-controlled names that collide with prototype keys are unknown tools", () => {
	for (const name of [...PROTOTYPE_KEYS, "BASH", "unknown", ""]) {
		assert.equal(toolWords(name), undefined, name);
		assert.equal(isPolishedTool(name), false, name);
		assert.equal(isFoldableTool(name), false, name);
	}
	assert.equal(tallySentence(calls(...PROTOTYPE_KEYS)), "");
	assert.equal(tallySentence(calls("toString", "read", "__proto__", "bash", "edit")), "Read 1 file");
	for (const name of PROTOTYPE_KEYS) assert.equal(tallySubject(name, { path: "a.ts", pattern: "x" }), "", name);
});

test("tally sentences merge shared clauses, pluralize, keep first-appearance order and capitalize", () => {
	assert.equal(tallySentence(calls("read", "grep", "read", "find")), "Read 2 files, searched 2 patterns");
	assert.equal(tallySentence(calls("grep", "find")), "Searched 2 patterns", "grep and find are one clause, not two");
	assert.equal(tallySentence(calls("ls", "read", "ls", "grep")), "Listed 2 folders, read 1 file, searched 1 pattern");
	assert.equal(tallySentence(calls("find")), "Searched 1 pattern");
	assert.equal(tallySentence([]), "");
	assert.equal(tallySentence(new Set(calls("read", "ls"))), "Read 1 file, listed 1 folder", "any iterable");
});

test("a tally counts what the calls were about, not how many calls ran", () => {
	const read = (path: unknown) => ({ name: "read", subject: tallySubject("read", { path }) });
	assert.equal(tallySentence([read("src/big.ts"), read("src/big.ts"), read("src/big.ts")]), "Read 1 file", "paging one file is one file");
	assert.equal(tallySentence([read("src\\a.ts"), read("src/a.ts"), read("src/b.ts")]), "Read 2 files", "either slash names the same file");
	assert.equal(tallySentence([read(undefined), read(7), read("a.ts")]), "Read 3 files", "calls without a path each count");
	const grep = { name: "grep", subject: tallySubject("grep", { pattern: "TODO", path: "src" }) };
	const find = { name: "find", subject: tallySubject("find", { pattern: "TODO", path: "test" }) };
	assert.equal(tallySentence([grep, find, { name: "grep", subject: tallySubject("grep", { pattern: "FIXME" }) }]), "Searched 2 patterns");
	assert.equal(tallySubject("ls", { path: "C:\\Work\\src" }), "c:/work/src", "drive paths compare as their filesystem does");
	assert.equal(tallySubject("bash", { path: "a", command: "ls" }), "", "tools without a tally have no subject");
	assert.equal(tallySubject("read", { path: "x".repeat(5000) }).length, 512, "subjects are bounded");
	assert.equal(tallySubject("read", null), "");
});

test("one file is one file however its path is spelled", () => {
	const cwd = "/work/repo";
	const spellings = ["a.ts", "./a.ts", "@a.ts", "src/../a.ts", "/work/repo/a.ts", ".\\a.ts", "/work/repo/./a.ts"];
	const keys = new Set(spellings.map(path => tallySubject("read", { path }, cwd)));
	assert.deepEqual([...keys], ["work/repo/a.ts"], "every spelling Pi's file tools resolve to one target gives one key");
	assert.equal(tallySentence(spellings.map(path => ({ name: "read", subject: tallySubject("read", { path }, cwd) }))), "Read 1 file");
	assert.notEqual(tallySubject("read", { path: "a.ts" }, cwd), tallySubject("read", { path: "b/a.ts" }, cwd));
	assert.equal(tallySubject("read", { path: "D:\\Work\\Repo\\A.ts" }, "d:/work/repo"), tallySubject("read", { path: "a.ts" }, "D:\\work\\repo"),
		"Windows spells one file with either case and either slash");
	assert.notEqual(tallySubject("read", { path: "/work/A.ts" }, cwd), tallySubject("read", { path: "/work/a.ts" }, cwd), "POSIX paths stay case-sensitive");
	// `ls` with no path lists the working directory; a read without a path names nothing.
	const here = ["", ".", "./", "/work/repo", undefined].map(path => tallySubject("ls", path === undefined ? {} : { path }, cwd));
	assert.equal(new Set(here).size, 1, here.join(" | "));
	assert.equal(tallySubject("read", {}, cwd), "");
});

/** A call as the registry records it: comparison key and display name from the same arguments. */
const named = (name: string, args: Record<string, unknown>, cwd = "/work/repo") =>
	({ name, subject: tallySubject(name, args, cwd), display: tallyName(name, args, cwd) });

test("the detailed tally names distinct files in first-appearance order and keeps searches counted", () => {
	assert.equal(tallyDetails([named("read", { path: "src/width.ts" }), named("read", { path: "src/frame.ts" }), named("read", { path: "src/editor.ts" })]),
		"Read width.ts, frame.ts, editor.ts");
	assert.equal(tallyDetails([
		named("read", { path: "src/width.ts" }), named("grep", { pattern: "TODO" }), named("read", { path: "src/frame.ts" }),
		named("ls", { path: "src" }), named("find", { pattern: "*.ts" }), named("read", { path: "src/width.ts" }),
	]), "Read width.ts, frame.ts · searched 2 patterns · listed src", "clauses in first-appearance order, joined with ·");
	assert.equal(tallyDetails([named("grep", { pattern: "a" }), named("find", { pattern: "b" }), named("grep", { pattern: "a" })]), "Searched 2 patterns",
		"nothing to name is the counted sentence itself");
	assert.equal(tallyDetails([]), "");
});

test("the detailed tally lists one file once however it is spelled, by its first spelling", () => {
	const spellings = ["src/A.ts", "./src/A.ts", "@src/A.ts", "lib/../src/A.ts", "/work/repo/src/A.ts", ".\\src\\A.ts"];
	assert.equal(tallyDetails(spellings.map(path => named("read", { path }))), "Read A.ts");
	assert.equal(tallyDetails(["D:\\Repo\\Src\\Width.ts", "d:/repo/src/width.ts"].map(path => named("read", { path }, "D:/Repo"))), "Read Width.ts",
		"Windows keys are case-folded; the name keeps the model's spelling");
	assert.equal(tallyName("ls", {}, "D:\\Work\\Pi-1337"), "Pi-1337", "ls without a path lists the working directory, by its own name");
	assert.equal(tallyName("ls", { path: "src/" }, "/w"), "src");
	assert.equal(tallyName("read", { path: "src/a.ts" }, ""), "a.ts");
	assert.equal(tallyName("ls", {}, ""), "", "a directory with no known name has none");
	assert.equal(tallyName("grep", { pattern: "x", path: "src" }), "", "pattern clauses are counted, never named");
	assert.equal(tallyName("bash", { path: "a" }), "");
});

test("a path clause with a call it cannot name stays counted, and names are bounded and sanitized", () => {
	assert.equal(tallyDetails([named("read", { path: "a.ts" }), named("read", {}), named("read", { path: "b.ts" })]), "Read 3 files",
		"a list that left one call out would read as the whole run");
	assert.equal(tallyDetails([named("read", { path: "a.ts" }), named("read", { path: "/" }), named("grep", { pattern: "x" })]),
		"Read 2 files, searched 1 pattern");
	assert.equal(tallyDetails([named("read", { path: "a.ts" }), { name: "read", subject: "b" }]), "Read 2 files", "a subject without a display name");
	assert.equal(tallyDetails([named("read", { path: "src/a/index.ts" }), named("read", { path: "src/b/index.ts" }), named("ls", { path: "src" })]),
		"Read 2 files · listed src", "two files sharing a basename would read as one listed twice");
	const hostile = named("read", { path: "src/\x1b]52;c;evil\x07x\u202e.ts" });
	assert.equal(hostile.display, "x.ts", "controls and bidi overrides never reach the name");
	assert.equal(named("read", { path: "\x1b[2J\u2066" }).display, "", "a name of nothing but controls is no name");
	assert.equal(tallyDetails([hostile, named("read", { path: "\x1b[2J\u2066" })]), "Read 2 files");
	assert.equal(named("read", { path: `src/${"n".repeat(5000)}` }).display, "", "an over-long name is never listed, cut or whole");
	const many = Array.from({ length: 40 }, (_, i) => named("read", { path: `src/a-rather-long-module-name-${i}.ts` }));
	assert.equal(tallyDetails(many), "Read 40 files", "a list longer than any row is counted, never cut");
});

test("a name that cannot be listed truthfully is not listed", () => {
	const named = (path: string) => ({ name: "read", subject: tallySubject("read", { path }), display: tallyName("read", { path }) });
	const long = `${"L".repeat(140)}.ts`;
	assert.equal(tallyName("read", { path: `src/${long}` }), "", "a cut name is not the file that was read");
	assert.equal(tallyName("read", { path: "docs/a, b.ts" }), "", "a comma would read as two files");
	assert.equal(tallyName("read", { path: "notes · todo.md" }), "", "a middle dot would read as a new clause");
	assert.equal(tallyName("read", { path: "src/a,b.ts" }), "a,b.ts", "a bare comma is not the separator");
	for (const odd of [long, "a, b.ts", "notes · todo.md"]) {
		assert.equal(tallyDetails([named(odd), named("c.ts")]), tallySentence([named(odd), named("c.ts")]), `${odd.slice(0, 12)}…: the clause is counted`);
	}
});
