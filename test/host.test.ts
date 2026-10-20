import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi 1.3 loads the package and all palettes through its real resource loader", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi1337-host-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: join(dir, "agent"),
			settingsManager: SettingsManager.inMemory({ packages: [resolve(import.meta.dirname, "..")] }),
			disabledBuiltinExtensions: ["mcp"],
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const extension = loaded.extensions[0];
		assert.ok(extension);
		for (const event of ["agent_settled", "ui_prompt_start", "ui_prompt_end", "session_compact_failed"]) {
			assert.ok(extension.handlers.has(event), `missing Pi 1.3 handler: ${event}`);
		}
		const themes = loader.getThemes();
		assert.deepEqual(themes.diagnostics, []);
		assert.deepEqual(themes.themes.map((theme) => theme.name).sort(), [
			"1337", "1337-amber", "1337-cyber", "1337-fallout", "1337-ice", "1337-neon", "1337-skynet", "1337-split",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
