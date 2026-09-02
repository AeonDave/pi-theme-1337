/** Pure helpers for the live sub-agent count shown in the editor frame.
 *  Tracks pi-persona's `delegate` tool: single `{agent, task}` or parallel
 *  `{tasks: [...]}`, with running children read from `details.views`. */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTask(value: unknown): boolean {
	return isRecord(value) && typeof value.agent === "string" && value.agent.length > 0;
}

/** Count the child agents requested by a `delegate` tool input (single or parallel). */
export function countSubagentsFromInput(input: unknown): number {
	if (!isRecord(input)) return 0;
	if (Array.isArray(input.tasks)) return input.tasks.filter(isTask).length;
	return isTask(input) && typeof input.task === "string" ? 1 : 0;
}

/** Count currently-running children from a `delegate` result/update payload
 *  (`details.views[].running`). Returns undefined when the payload carries no
 *  view information (so the previous count is kept). */
export function countSubagentsFromResult(result: unknown): number | undefined {
	if (!isRecord(result) || !isRecord(result.details)) return undefined;
	const views = result.details.views;
	if (!Array.isArray(views)) return undefined;
	return views.filter((v) => isRecord(v) && v.running === true).length;
}
