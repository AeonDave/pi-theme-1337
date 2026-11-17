# Architecture

pi-1337 is a Pi package with two parts: thirteen color-only theme files and an extension that presents Pi's editor and tool transcript in a phosphor-style interface. The theme files remain valid Pi palettes; extension-only settings live in adjacent `.pi1337` sidecars.

## Boundaries

```text
Pi theme JSON ───────────────> Pi theme system
Pi extension API ─> index.ts ─> editor.ts ─> frame.ts
                           └──> tool renderers
```

`index.ts` owns Pi events, UI changes, and configuration reads. `editor.ts` and the tool adapters connect host components to the presentation code. Pure modules format or lay out data without owning Pi UI state.

| Area | Responsibility |
| --- | --- |
| `themes/*.json` | Color tokens for each palette. |
| `src/index.ts` | Extension lifecycle, commands, theme switching, config, and spinner lifecycle. |
| `src/editor.ts` | Custom editor wrapper that preserves Pi's editing and input behavior. |
| `src/frame.ts` | Pure frame construction, status layout, and narrow-width degradation. |
| `src/format.ts` | Pure sanitizers and label, context, cost and run-delta formatting. |
| `src/tool-activity.ts` | Pure status-row label naming a long-running tool call, and the run clock. |
| `src/run-summary.ts` | Pure per-run collector and the end-of-run transcript row. |
| `src/terminal-title.ts` | Pure terminal-title text for each run state. |
| `src/width.ts` | Shared width measurement seam used by render modules. |
| `src/tool-view.ts`, `src/tool-adapter.ts` | Compact presentation for tool calls, results, and diffs. |
| `src/tool-lexicon.ts` | The one vocabulary for built-in tools: row title, status verb, tally clause. |
| `src/tool-groups.ts` | Pure registry folding runs of settled exploration rows into one tally row. |
| `src/diff-spans.ts` | Bounded comparison of sanitized replacement bodies. |
| `src/avatar.ts`, `src/background.ts`, `src/spinner.ts` | Pure parsing/layout and value helpers for optional presentation settings. |
| `src/redraw-guard.ts` | Pass-through stderr observation and coalesced redraw repair while active. |

## Editor rendering

The editor wrapper asks Pi's base editor to render at the space available inside the frame. A pure formatter removes the host's top and bottom rules, adds the rounded outline and side gutters, then centers the result. The prompt marker and spinner occupy reserved gutters; a status row appears inside the bottom edge when autocomplete is closed.

The wrapper leaves editing, cursor handling, autocomplete, history, and keybindings to Pi. It uses Pi TUI's exported width functions so the measured frame matches the renderer that paints it. A dependency-free width fallback supports pure module tests.

Status values are captured from Pi and extension status sources outside the render path, then formatted into the editor frame. The model identity sits in the top border's right end (`provider/model · level`, narrowing to `model · level` and then `model`). The status row has two groups — where you are on the left, the session's state on the right — and gives up space by meaning: the run's spend, the window denominator, the second quota window, the gauge and a calm quota first, then path detail and the session name, then cost, token count, persona and a quota above 70% (or `limit`), with the context percentage last. The left group gives up whole details, in the order session name, branch, path down to `…/basename`: a branch is an identifier and is shown whole or not at all, while a session name, being free text, may shorten to no fewer than ten columns (nine characters and `…`) before it goes. The activity label that borrows these cells shortens to no fewer than eight columns; with fewer, the workspace keeps its place. Context usage and cost are refreshed on agent, turn and session events, and once more when the first top-level tool call of a response starts: Pi has appended that response to the session by then, so a long call shows current figures. The prompt marker reads the buffer as Pi does: `!` makes it a `bashMode`-colored `$`, `!!` a `dim` one, because that command's output is kept out of the model's context.

## Subscription quota

Between the cost and the persona the status row shows the current provider's subscription quota, as percent used: `5h 43% · wk 12%`, `wk 85%` when one window is known, or `limit` once the usage limit is reached. The pure module `src/quota.ts` builds it from three things Pi already hands extensions; the extension makes no request, reads no credential and starts no timer for it.

| Source (Pi event) | What is read | Status |
| --- | --- | --- |
| Response headers (`after_provider_response`), `anthropic-messages` | `anthropic-ratelimit-unified-{5h,7d}-utilization` (a fraction) and `-reset` (epoch seconds) | Observed on a live subscription; those responses carried the weekly window only. |
| Assistant message that ended in an error (`message_end`) | `errorMessage` containing the phrase `usage limit` | Observed on OpenAI's ChatGPT login, where it is the only signal: the response is a 200 with no quota headers. |
| Response headers, `openai-responses` and `openai-codex-responses` | `x-codex-{primary,secondary}-used-percent` (a percent), `-window-minutes`, `-reset-at`, `-reset-after-seconds` | Implemented from the official client's format; not yet seen live. |
| Raw stream event (`provider_stream_event`), `openai-codex-responses` | `codex.rate_limits` → `rate_limits.primary` / `.secondary` (`used_percent`, `window_minutes`, `reset_at`, `reset_after_seconds`) | Implemented from the shape Pi's own Codex stream test replays; not yet seen live. |

Other apis are not read, so providers that report nothing (z.ai, OpenRouter and other `openai-completions` routes) show nothing. The family is chosen by the model's api and only that family's exact header names count. Values must be strict numbers; nothing from a header, an event or an error message is printed — labels come from a canonical duration, and a declared length such as 299 or 10079 minutes snaps to the whole hour or day it lies within 5% of.

State is kept per provider, so switching model away and back keeps the figures. A response usually carries a subset of the windows, so each window is kept on its own with the time it was last seen: it leaves when its reset passes or, without a believable reset, thirty minutes after it was last seen. A figure older than thirty minutes is drawn dim while it is calm. Two successful responses in a row with no quota header drop everything known about that provider (the account or its auth changed). `limit` stays until that provider's next assistant message that is an answer; another error or an interrupted attempt leaves it. A response is credited to the model its turn started with, so switching model while a request is in flight does not move one account's figures onto another.

The view is rebuilt on events — a response, a message's end, a model or session change, a run or turn boundary — and cached; rendering only reads the cache, so an expired window disappears at the next event rather than on a timer. A quota above 70% (or `limit`) is content and stays while the row narrows, yielding only to the context percentage; a calm one is a decoration that goes after the gauge. Nothing about quota enters the summary row or the terminal title. Not known from any of these sources: the plan, the absolute limit, model-scoped or overage windows, and when a `limit` will lift. `PI_1337_QUOTA=off` turns the feature off.

## Tool views

The extension registers renderers for compact tool headers, output previews, and edit diffs. This changes transcript presentation only; it does not alter tool schemas, arguments, prompts, execution, or results. Original host renderers return when the redesign is disabled. `PI_1337_POLISH=off` keeps the host's tool views while retaining the framed editor.

Third-party renderers keep their content. A non-built-in tool that defines both `renderCall` and `renderResult` and does not declare `renderShell: "self"` is drawn in a flat shell while the redesign is active: one status dot, then the renderer's call lines; its result lines under `└`; no background fill and no box pad rows. The renderer gets the row width minus the side padding and the two-column lead. Its lines are never rewritten, wrapped or sanitized; a line that is too wide is clipped, and only the blank rows a slot opens or closes with are dropped. The row has one lane, so the hooks run once per host update with the host's own `context.state` and their own `lastComponent`, and a toggle never forks or resets that state. Toggled off, the same components sit in the host's box. A row whose slots render no line at all takes none in either state (active, that includes slots of nothing but blank lines); toggled off this is one blank row short of the host, whose default shell still prints its separator above an empty box — a self-framed row is given that separator only together with a line of its own, so the single row cannot be reproduced. A descriptor with `renderShell: "self"` or with only one of the two hooks is returned unchanged; a result with image content keeps the host box while it is current, and a row that emitted an image-protocol line keeps it for good. So does a row whose renderer returned a line that is not a string: the host's box paints it as the text it coerces to, and the adapter never throws where the host does not. These rows never fold. The flat shell memoizes the composed row per slot, so a repeat frame measures nothing; the child components still render every frame.

A `bash` row that is still running shows the timeout the model chose, as stock Pi does: ` (timeout 30s)` after the title, one dim rung that is the first to yield and is gone with the final result. Only a finite, positive number of seconds within the host shell's ceiling is shown, spelled by the renderer; any other value prints nothing.

Edit previews use only recorded result diffs; write previews show submitted content.
`diff-spans.ts` compares words and punctuation with a longest common subsequence,
then refines each changed span's edges at grapheme boundaries. Common text between
separate edits keeps its normal weight. Equal-sized, contiguous removed/added groups
pair by position, since old/new line numbers diverge after insertions. Context and
omitted-hunk markers end a group; uneven and incomplete preview groups/bodies keep
full-line semantic colors without intra-line emphasis.

Comparison is capped at 8,192 UTF-16 units per body, 256 tokens per side and 65,536
matrix cells (~128 KiB). Over-budget pairs retain line colors. Unified rows preserve
space for code at narrow widths; bold spans survive wrapping and clipping without
styling the renderer's truncation marker. Rendering uses the current host's ruler,
the active theme's semantic colors, and the existing expansion and toggle contracts.

## Activity label and folding

Both features are fed only by Pi's documented events — no host prototypes are
touched — and both take their words from `tool-lexicon.ts`, so a tool reads the
same way on its row (`Read src/width.ts`), in the status row (`Reading
width.ts…`) and in a tally (`Read 3 files`).

`tool-activity.ts` tracks top-level `tool_execution_start`/`end` calls (nested
`parentToolCallId` calls never render as rows). Once the oldest running call has
lasted half a second, the editor names it in the workspace segment's place, with
` +N` for calls running beside it. The frame lays the row out from its normal
two groups first and repaints only the left group's cells; the right group never
moves. No timer is added: the spinner's repaint
reveals the label, and fast calls end before it would appear.

The same module holds the run clock. When no call is named and the run has
lasted three seconds, the slot reads `Working… 45s`, counted from the run's
first `agent_start` after a settle; retries, mid-run compaction and drained
follow-ups do not restart it. It is shown whole, without its time, or not at
all, and it is hidden during a blocking prompt, during compaction, after
`agent_settled` and for a run that began while the redesign was toggled off.
It uses the label's overlay and the spinner's repaint, so the right group does
not move and no timer is added.

## Run summary and terminal title

`run-summary.ts` collects one run from live events and `index.ts` appends the
result once, at `agent_settled`, as a custom session entry. Four fields are
optional, so earlier entries render unchanged and a malformed one is ignored
on its own. `waiting` is a snapshot of pi-persona's `persona-background`
status as counts; with it a clean run reads `● Turn ended in 9.0s · … ·
waiting on 3 agents, 1 monitor` with a muted dot, and the clause narrows to one
count (`waiting on 4 background tasks`) and outlasts the cost and the work
detail. `modelMs` sums `turn_start` → the turn's assistant `message_end`, and
`outputTokens` sums `usage.output`, absent if any assistant message lacked it.
`thinkingMs` sums `thinking_start` → `thinking_end` from the assistant stream
(`message_update`), closing a block the stream left open at that message's
`message_end`; it is stored only from one second up and never above `modelMs`.
The expanded row shows them as `model 1m 32s (40s thinking) · tools 42s · 48
tok/s`; thinking is part of the model time, so it stands in parentheses, and
`tools` is the run's duration minus model time, so it also holds retry
back-off, compaction and prompt waits. The line narrows by dropping the rate,
then the parenthesis, then the tools time, and on a row too narrow for
`model 1m 32s` it is left empty rather than cut.

The status is parsed strictly (`parseBackgroundStatus` in `format.ts`:
`kind=count` pairs in the order `agents monitors timers scripts`, counts
1–9999); anything else means no background work, and only the parsed numbers
are displayed. After a clean run the terminal title reads `◌ Waiting on 3
agents — …` while the status parses and `✓ Done — …` once it clears. The
footer render compares the raw status string and the title is written from a
microtask. Background work never enters the status row.

`tool-groups.ts` keeps runs of consecutive `read`/`grep`/`find`/`ls` calls. A run
closes when anything else paints a row: another tool, a user or custom message,
assistant text, an error line, or a thinking row. A run with at least three
settled, successful, image-free calls folds, open or closed: the last one renders
a tally row and the others render nothing, so the tally stays in place and counts
up as later calls settle into it. A call still running keeps its own row.
Failed calls and calls with images keep their rows, and the tally counts distinct
files and patterns. Rows painted without any extension event (`notify()`, host
notices) cannot end a run. A click on the tally, or on any row of a run, expands
that run; the host's expand key renders everything. Folding is presentation of
the transcript itself — `notify()`, status indicators, widgets, and every other
Pi channel stay untouched, and HTML export still shows every call.

## Lifecycle and host behavior

`/theme-1337` and shutdown restore the presentation changes made by the extension, including the editor, footer, spinner visibility, theme when still owned by the extension, optional widget, and any terminal tint. The editor slot is shared with other extensions, so it is touched only while `getEditorComponent()` still returns this extension's factory: toggling off then reinstalls the factory that held the slot before (falling back to Pi's own editor if that factory throws), while shutdown only empties it and never builds another extension's editor. An editor installed after this one is left in place. A host without `getEditorComponent` gets the earlier behaviour, an unconditional reset.

While the redesign is on, an editor installed over this extension's frame would leave the user with nothing: the frame is the only place the workspace, model, context, cost and spinner are shown, and the footer is empty and Pi's working row hidden. No event announces it, so the empty footer's render compares `getEditorComponent()` with this extension's factory on each UI pass and, from a microtask after that render, hands the chrome back: Pi's footer returns, its working row shows again and this extension's spinner timer stops. Tool rows, the theme, the terminal title and summary rows carry on. The frame is not taken back by itself; the next `/theme-1337` or session start installs it again. The extension only applies UI changes in Pi's interactive TUI mode; RPC, JSON, and print modes do not acquire the redesign or animation timer.

Pi owns notices, dialogs, widgets, retry indicators, compaction indicators, and other status channels. The extension keeps these host channels intact and does not replace them with a footer status row.

## Development dependencies

The two Pi development packages are pinned to 1.5.2, the latest published
release. That release already depends on `undici` 8.12.3, which includes the
fixes for the reported
[Undici advisories](https://github.com/nodejs/undici/releases/tag/v8.12.2), so
the root override that earlier pins needed is gone. Check the host's own pin
again when updating the matched Pi development packages.

## Inspirations

The compact transcript's visual direction was informed by [pi-polish](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-polish) and [pi-context-bar](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-context-bar). pi-1337 is an independent implementation adapted to its palettes and framed editor.

The `1337-cosmos` palette takes its colors from [pi-starline](https://github.com/Andy8647/pi-starline) (MIT), whose cover art and pill bar use the [Catppuccin](https://github.com/catppuccin/palette) Mocha swatches (MIT). The role mapping, the derived steps and the spinner are original, and no pi-starline or Catppuccin code is bundled.
