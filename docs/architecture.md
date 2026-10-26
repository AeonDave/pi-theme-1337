# Architecture

pi-1337 is a Pi package with two parts: twelve color-only theme files and an extension that presents Pi's editor and tool transcript in a phosphor-style interface. The theme files remain valid Pi palettes; extension-only settings live in adjacent `.pi1337` sidecars.

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
| `src/format.ts`, `src/subagents.ts` | Pure label, context, cost, and live-agent formatting. |
| `src/width.ts` | Shared width measurement seam used by render modules. |
| `src/tool-view.ts`, `src/tool-adapter.ts` | Compact presentation for tool calls, results, and diffs. |
| `src/diff-spans.ts` | Bounded comparison of sanitized replacement bodies. |
| `src/avatar.ts`, `src/background.ts`, `src/spinner.ts` | Pure parsing/layout and value helpers for optional presentation settings. |
| `src/redraw-guard.ts` | Pass-through stderr observation and coalesced redraw repair while active. |

## Editor rendering

The editor wrapper asks Pi's base editor to render at the space available inside the frame. A pure formatter removes the host's top and bottom rules, adds the rounded outline and side gutters, then centers the result. The prompt marker and spinner occupy reserved gutters; a status row appears inside the bottom edge when autocomplete is closed.

The wrapper leaves editing, cursor handling, autocomplete, history, and keybindings to Pi. It uses Pi TUI's exported width functions so the measured frame matches the renderer that paints it. A dependency-free width fallback supports pure module tests.

Status values are captured from Pi and extension status sources outside the render path, then formatted into the editor frame. Long labels give up space by meaning: optional path details and session labels shorten before context and the useful model or persona label.

## Tool views

The extension registers renderers for compact tool headers, output previews, and edit diffs. This changes transcript presentation only; it does not alter tool schemas, arguments, prompts, execution, or results. Existing third-party renderers remain available, and original host renderers return when the redesign is disabled. `PI_1337_POLISH=off` keeps the host's tool views while retaining the framed editor.

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

## Lifecycle and host behavior

`/pi-1337` and shutdown restore the presentation changes made by the extension, including the editor, footer, spinner visibility, theme when still owned by the extension, optional widget, and any terminal tint. The extension only applies UI changes in Pi's interactive TUI mode; RPC, JSON, and print modes do not acquire the redesign or animation timer.

Pi owns notices, dialogs, widgets, retry indicators, compaction indicators, and other status channels. The extension keeps these host channels intact and does not replace them with a footer status row.

## Development dependencies

The two Pi development packages remain pinned to 1.4.0. A root override scopes
`undici` 8.12.2 to `@earendil-works/pi-coding-agent@1.4.0`, replacing its pinned
8.10.2 dependency with the release that fixes the reported
[Undici advisories](https://github.com/nodejs/undici/releases/tag/v8.12.2).
This applies to this repository's development install only; it does not update
a globally installed Pi host or propagate to consuming projects. Revisit the
override when updating the matched Pi development packages.

## Inspirations

The compact transcript's visual direction was informed by [pi-polish](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-polish) and [pi-context-bar](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-context-bar). pi-1337 is an independent implementation adapted to its palettes and framed editor.
