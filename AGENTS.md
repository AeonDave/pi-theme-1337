# pi-1337 — architecture

A Pi **package**: a bundled theme + an advanced-redesign extension. The theme is
pure color; the extension reframes the editor and hides the rest of the chrome.
Keep the pure render logic separate from the Pi wiring.

## Layout

```
pi-1337/
├── package.json        # pi.extensions + pi.themes
├── themes/
│   ├── 1337.json       # 1985-inspired yellow-green phosphor + amber UI accents
│   ├── 1337-amber.json   # amber CRT sibling      ┐
│   ├── 1337-ice.json     # cool blue-white         │
│   ├── 1337-cyber.json   # modern indigo-blue      ├ same 51-token contract, other hues
│   ├── 1337-cyberpunk-2077.json # neon yellow + cyan-blue accents on black
│   ├── 1337-cyberpunk-2077-edgerunner.json # muted red + yellow titles + cyan accent on burgundy-black
│   ├── 1337-neon.json    # synthwave violet        │
│   ├── 1337-poison.json  # toxic green/orchid mix   │
│   ├── 1337-magma.json   # molten coral/orange + cyan│
│   ├── 1337-fallout.json # radioactive Pip-Boy lime │
│   ├── 1337-skynet.json  # Terminator 2 warm-white HUD on red-tinted black
│   ├── 1337-skynet-dark.json # red-on-near-black sibling                      ┘
│   └── *.pi1337        # per-palette spinner; both Cyberpunk variants, Fallout, and both Skynets opt into tint (not theme resources)
├── src/
│   ├── index.ts        # wiring: events, /pi-1337 command, copy shortcut, apply/clear, theme switch, spinner timer
│   ├── editor.ts       # FramedEditor (CustomEditor subclass) + setEditorComponent factory
│   ├── frame.ts        # pure: frameEditor / layoutRow / isRuleLine (drops Pi's rules, builds the rounded box)
│   ├── format.ts       # pure: shortCwd / cleanModel / formatContext
│   ├── subagents.ts    # pure: countSubagentsFromInput / countSubagentsFromResult (live agent count)
│   ├── width.ts        # measurement seam: useTerminalMetrics + box geometry (+ pure fallback)
│   ├── background.ts   # pure: OSC 11 tint build/reset + hex normalize/resolve (opt-in terminal bg)
│   ├── avatar.ts       # pure: parse/select optional user-configured avatar frames
│   ├── spinner.ts      # pure: validated text-motion profiles and frame selection
│   ├── redraw-guard.ts # reversible stderr observer → coalesced full TUI redraw (never alters bytes)
│   └── config.ts       # env-driven config (PI_1337_*)
└── test/
    ├── width.test.ts     # width math (ANSI-aware, emoji = 2 cols)
    ├── format.test.ts    # path + model + context formatting
    ├── frame.test.ts     # rule detection, border composition, framing + margins
    ├── subagents.test.ts # input/result agent counting
    ├── config.test.ts    # copy-shortcut env contract
    ├── redraw-guard.test.ts # pass-through, coalescing, full-redraw, ownership-safe disposal
    ├── theme.test.ts     # 51-token contract + var resolution + monochrome guard
    └── parity.ts         # NOT in `npm test`: frames pi's real editor, measures with pi-tui
```

## How the editor is reframed

Pi's editor renders **open-sided**: a top `─` rule, the content lines (cursor
drawn *inline* as inverse-video text), a bottom `─` rule, then autocomplete rows.
`FramedEditor.render(width)`:

1. computes `boxWidth = min(maxWidth, width − 2·margin)` and a centered
   `leftMargin`;
2. calls `super.render(editorWidthFor(boxWidth, spinnerColumns))` to get the
   real editor at the inner width: two rails, left `GUTTER = 2`, and a right
   gutter of `1 + spinnerColumns` (one to three indicator cells). This width is
   reserved even when idle or waiting; two-row profiles also reserve a
   `1 + spinnerColumns` status-row slot (four cells for Skynet), included in the
   gauge-fit budget. Render caching and mouse
   mapping use the same input-width helper, so activity never reflows the buffer;
3. hands the raw lines to `frameEditor` (pure), which drops the two rules, wraps
   the content lines in `│` rails with fixed-width side gutters (prompt `›` +
   spinner on row 0), caps them with a clean rounded `╭─╮`/`╰─╯` outline, and
   left-pads every line by `leftMargin`. The status row is inside the box when
   there is no menu; autocomplete goes below the box without rails and hides
   the status row while open, so its row indices still match Pi's own mouse
   layout (first suggestion at `visibleContentRows + 2`).

Because the cursor is inline text (not a reported coordinate), left-padding the
box **and** the fixed prompt gutter shift it correctly — no cursor math needed.

## Key invariants (do not break)

- **Pure modules.** `frame.ts` / `format.ts` / `subagents.ts` / `width.ts` / `background.ts` / `avatar.ts`
  take data and return `string[]` / numbers — no `ctx`, no I/O, no timers, only
  type-only Pi imports. They test with just `tsx`; keep it that way. `editor.ts`
  and `index.ts` are the only modules with a runtime Pi import.
- **Width is measured with pi-tui's own ruler, never a copy of it.** `index.ts`
  installs pi-tui's `visibleWidth` / `truncateToWidth` through
  `useTerminalMetrics()` at module load, and every render module measures
  through the wrappers in `width.ts`. This is not a nicety: a row measured one
  column short pads past the terminal edge, wraps, and the differential renderer
  loses a row — which is how a stale piece of border survives a repaint (on a
  differential pass pi throws `Rendered line exceeds terminal width` outright).
  The hand-rolled implementation left in `width.ts` is only the dependency-free
  fallback the pure unit tests run on; a mirror of pi-tui's `graphemeWidth`
  (tab = 3 columns, terminal spacing marks take a cell, only `\p{RGI_Emoji}` is
  wide so ✓ ✗ ✦ stay 1 column, the BEL-terminated APC cursor marker measures 0).
  It drifted from pi-tui three times — do not let production depend on it again,
  and keep `useTerminalMetrics` wired at the top of `index.ts`. Where the mirror
  is unsure it must round *up*: over-measuring only shortens the right rail,
  under-measuring wraps the row. Two rules the seam exists to enforce:
  - **Only import helpers the published bundle actually exports.** pi-tui's
    export surface moves between versions — 0.83.0 ships no
    `stripTerminalSequences`, so importing it yielded `undefined` and took the
    TUI down on the first render (`metrics.stripAnsi is not a function`).
    `stripAnsi` therefore stays the built-in one: it is a pure string transform
    with no terminal state to get wrong. Verify against the bundle you run
    against, not against a `pi` checkout, which is usually ahead of it.
  - **`useTerminalMetrics` takes only function-valued members**, so a helper that
    has become `undefined` degrades to the mirror instead of erasing it.
  Installing the host's ruler also makes the frame correct across pi-tui versions
  that disagree with each other: 0.83.0 reads `का` as one column, current pi-tui
  as two, and the box is exact on both because it is laid out with the same
  ruler that paints it.
- **Render-only presentation with transparent cache invalidation.** `FramedEditor`
  extends `CustomEditor` and caches the base editor's raw layout across
  spinner-only redraws; its `invalidate`/input/text/padding overrides only drop
  that cache and forward to the base class. On the current host it forwards `handleMouse`,
  invalidating cursor/handled changes but not unhandled press/drag/release events
  owned by terminal text selection. Editing, autocomplete, history, and keybindings
  stay the base class's. Never swallow input. (The clean-copy feature stays out
  of the editor: it's a top-level `registerShortcut` reading `getText()`, not a
  key intercept.)
- **The border is clean; the chrome is inside.** The rounded outline carries no
  labels. What's kept — prompt sigil + spinner (row 0 gutters) and
  workspace+branch+session / usage+cost / agents+provider/model+persona
  (`shortCwd` anchors `~` on segment boundaries — case-insensitively on Windows —
  so a `HOME` with a trailing separator or a shell reporting `C:\users\me` while
  `USERPROFILE` says `C:\Users\me` still resolves to `~/…/x/y`)
  (a dedicated status row: left / center / right) — lives inside the box; the
  footer is empty. Don't re-add a footer line, don't cut labels back into the
  border, and don't add an extension-status row (tried; permanent statuses
  turned it into noise — third parties keep the chat log / widgets). The sigil
  reacts to bash mode (`isBashInput` — a leading `!` flips `›` to a
  `bashMode`-colored `$`); the usage color escalates with `usageLevel`
  (>70% warning, >90% error — the footer's thresholds); the model renders as a
  `provider/id` slug; the cost is always an API-equivalent **estimate**, marked
  `~$`, never an assertion of actual billing. Sum message, compaction,
  branch-summary and Pi `usage` entries plus pending persona usage; the current
  model's OAuth state cannot classify historical or child billing. The branch comes from `footerData.getGitBranch()` with an
  `onBranchChange` subscription (unsubscribed in `clear()`) so switches repaint
  promptly. Session name/context/cost are refreshed on session/model/turn events,
  never by the 90ms render path. All dynamic
  inline labels pass through the bounded linear terminal-control/bidi sanitizer
  before they enter the frame. Pi's two rules are dropped when the box is rebuilt, but they double
  as its scroll indicators — `scrollMarker` re-hangs `↑`/`↓` in the first/last
  content row's right gutter (the spinner wins row 0) so a buffer that continues
  above or below the visible rows stays visible.
- **Status colors follow the active theme.** Workspace, branch, session,
  provider/model/persona and separators use distinct semantic roles. Context
  retains the >70% warning / >90% error thresholds; the `~$` cost is independently
  muted. A five-cell usage gauge is optional decoration: show it only if the
  full metadata and numeric usage already fit, never at the expense of content.
- **The status row narrows semantically, never char-by-char.** The right
  segment is a `RowCandidate[]` degradation ladder resolved by
  `resolveSegment` (frame.ts, pure): long workspace/branch/session metadata yields
  space to the center and the narrowest useful right rung. When they cannot fit,
  the centered usage drops, then provider hidden → model trimmed with `…`
  (only the `flex` part trims; floor `MIN_FLEX`, the last rung trims below
  it) → persona alone when present, otherwise the model keeps trimming.
  Blind right-truncation was the old behavior — don't reintroduce it; the
  trailing truncation loops in `layoutRow` are extreme-width defense only.
- **Compact tool views are presentation-only.** `tool-view.ts` and
  `tool-adapter.ts` use type-only Pi imports; runtime constructors are injected
  from `index.ts`. `registerToolRenderer` changes standard tool rows and supplies
  a fallback for otherwise unrendered tools, never execution, schemas, prompts
  or results. Unknown tools with custom renderers keep them. Use semantic theme
  tokens, the shared width ruler, explicit collapsed errors and expandable
  output. Edit previews come from recorded result diffs; write previews are
  submitted content, not an inferred before/after diff. `PI_1337_POLISH=off`
  (config `polish:false`) leaves host rendering alone.
  The current host caches renderer descriptors and shell attachment per transcript row:
  conditional resolvers or changing `renderShell` do not restore existing rows.
  The stable self-shell adapter recomposes the original callbacks/default box on
  toggle-off. `apply()`/`clear()` invalidate the TUI before full redraw, while the
  handle is still present; `requestRender(true)` alone does not invalidate row
  caches. Adapter row keys stay stable per tool within an extension instance:
  HTML export resolves call and result descriptors separately, while the host's
  per-call state still owns each row and its isolated lanes. Generic fallbacks
  are built only when their lane is selected and cached until their inputs or
  presentation change; genuine hidden renderer hooks still receive every update
  and final callback for cleanup. Tool views cache one rendered width/padding
  combination and clear it on invalidation, so spinner redraws do not repeat
  wrapping and highlighting. The host still owns image rendering. Active-TUI
  HTML exports inherit these renderers because the public renderer context has
  no export-mode flag.
- **Pi's other channels are not ours to re-implement.** `notify()` renders into
  the chat log; retry/compaction/branch-summary indicators keep their own
  `statusContainer` kinds (`setWorkingVisible(false)` suppresses only
  `working`); widgets/dialogs/pending-message queue are independent containers.
  Never suppress or duplicate them.
- **Repair out-of-band stderr; never own it.** Some third-party extensions still
  write `console.warn`/`process.stderr.write` after Pi's differential TUI is live.
  While the 1337 chrome is active, `redraw-guard.ts` calls the original writer
  first with the exact receiver/arguments/return value, then schedules one
  coalesced 16ms repair per short write burst through public
  `tui.requestRender(true)` to clear stale cached rows/cursor. Never
  wrap stdout (pi-tui renders there), never rewrite/buffer the foreign message,
  and dispose ownership-safely: restore only if our wrapper is still installed.
  `apply()` also forces one full redraw to repair diagnostics emitted just before
  the guard bound; `clear()` disables the guard before dropping the TUI handle.
- **One source of motion.** The row-0 text spinner uses one `startSpinner`
  timer, driven by `agent_start`/`agent_settled`, gated on `chromeActive`
  (so non-tui modes never start it). `agent_end` is not settlement: retries,
  compaction and queued work can follow. Track prompts/compaction even while
  toggled off so `apply()` restores their state. Blocking `ui_prompt_start` pauses
  the timer and displays a static `?`; `ui_prompt_end` resumes only an active run.
  Manual compaction animates without inventing an agent run. Both
  `session_compact` and `session_compact_failed` clear compaction state; an abort
  is not an error. Clear the timer on settlement/disable/shutdown.
  Each `.pi1337` sidecar may set `spinner: {frames, intervalMs, color}`. The
  pure parser accepts legacy single-row strings or explicit one/two-row frames,
  rejects controls/bidi/newlines, blank or unequal geometry, more than 32 frames,
  widths outside 1–3 host-measured columns, invalid `#RRGGBB`, or intervals
  outside 60–500 ms. RGB overrides become typed color values; absent overrides
  use the active semantic accent. Invalid/missing profiles use the original
  90 ms braille default. A live theme switch resets the frame and restarts only
  active, unpaused motion; it never creates a second timer. Both Skynet profiles
  use the crimson `#d51f2a` pyramid with its fixed three-cell right gutter and four-cell status
  reservation; with autocomplete and only one content row, only its top triangle
  is shown so suggestion indices never shift. Other bundled profiles stay one-row.
- **Always reversible.** Everything `apply()` changes, `clear()` restores:
  `setEditorComponent(undefined)`, `setFooter(undefined)`, `setWorkingVisible(true)`,
  `setHiddenThinkingLabel()`, `setTheme(previous)` (only while the live theme is
  still the one we switched to — `appliedTheme` — so a manual theme switch made
  during the redesign survives toggle-off), and the optional OSC 11 background
  tint (`paintBackground` → `unpaintBackground` writes OSC 111 to reset the
  terminal's default). The tint is the one change that touches the *terminal*,
  not just Pi's cells, so it is opt-in (`PI_1337_BG`, off by default) and written
  through `activeTui.terminal.write` — the same out-of-band channel pi-tui uses to
  *query* OSC 11; the reset must fire in `clear()` **before** the tui handle is
  dropped, or the window stays tinted after exit. A background *image* has no
  portable app-level escape (kitty/iTerm image protocols draw inline content, not
  a backdrop), so it is intentionally out of scope — that stays terminal config.
  Background color/tint math lives in the pure `background.ts` (OSC build +
  `normalizeHex` + `resolveBackgroundHex` + `resolveBackground`), so index.ts only
  owns the write. Optional user-configured avatars (ASCII or image) use the
  same shape: a widget
  (`setWidget("pi1337-avatar", …, {placement:"belowEditor"})` by default) whose frames come
  from the pure `avatar.ts` (`parseAvatar`/`selectAvatar`), swapped on a small
  task-state machine (`avatarState`: idle → working on `agent_start`, confused on
  `session_before_compact`, error at `agent_settled` when a tool's `isError` fired
  that turn, else idle) and removed in `clear()` (`setWidget(key, undefined)`).
  It defaults to `belowEditor` (`pi1337.avatar.placement`): a kitty-image widget
  placed *above* the editor corrupts the input box's differential redraw beneath
  it (reserved image rows + cursor math) until a resize forces a full repaint;
  below the editor it renders after the box, and stays clear of the todos widget,
  which uses the default `aboveEditor` container. `align:"center"` pads via a
  widget factory that re-centers on each render width.
  Each state falls back toward `idle`, so a theme may ship one frame or four. Only
  present only when the active theme configures `pi1337.avatar`; bundled
  palettes ship no avatar configuration or image assets. A `working`-only avatar
  "appears when the AI responds". A frame is an image (`{ image }`) or **ASCII**
  (`{ lines }`): the PNG is drawn through pi-tui's terminal image protocol
  through pi-tui's own `Image` component (including Kitty `moveCursor:false`,
  iTerm2 row accounting, and live capability invalidation; files are capped at
  8 MiB), and on a terminal
  with no image support (`getCapabilities().images === null`) it falls back to the
  ASCII `lines`, or hides when there are none. Image paths resolve relative to the
  theme file (`dirname(sourcePath)`); frames are encoded once and cached by path.
  One widget factory lays the block out at the live render width: ASCII rows are
  clipped to the room the centering pad leaves (a widget row wider than the
  terminal wraps, and a wrapped row desynchronizes the renderer exactly like an
  over-wide frame row). Only actual Kitty/iTerm2 payloads use image-cell geometry
  and bypass text clipping; Image.render can return text even when a protocol is
  available. Measure/clip those fallbacks as text, never truncate protocol bytes.
  `layoutAvatarRows` in the pure avatar module owns this distinction.
  index.ts owns the image runtime imports (allowed alongside editor.ts); avatar.ts
  stays pure (parsing plus protocol-aware image-cell geometry). Kitty may reserve
  one fewer column than iTerm2 for a height-limited PNG; match pi-tui's size
  decision when centering, and test against its public `renderImage().columns`.
  Tint and optional user-configured avatar are read from a JSON sidecar named
  after the active theme
  (`1337-fallout.json` → `1337-fallout.pi1337`) via `ctx.ui.theme.sourcePath`.
  The non-`.json` extension prevents Pi's theme discovery from loading the
  sidecar as a palette, and keeps the theme JSON valid against the current host's strict
  published schema. A legacy root `pi1337` block remains a fallback only when
  no sidecar exists. Read in `apply()` into `themeConfig` +
  `themeDir`, and re-read on a live `/settings` switch: Pi fires no theme event, so
  the empty footer's `render` (run every UI pass) performs only a cheap
  `theme.sourcePath` compare. An actual change schedules one post-render
  microtask; only that task reloads the block, repaints the tint, swaps the
  avatar, and requests a full redraw. `clear()` invalidates a queued refresh.
- **Never stomp a persisted palette.** `applyTheme` targets
  `chooseStartupTheme(current)` (pure, in config.ts): an explicit `PI_1337_THEME`
  palette pin wins; otherwise Pi's current bundled palette (e.g. `1337-ice`
  picked via `/settings`) is kept. When Pi has no bundled choice, an unset env
  uses the config-file palette as a startup fallback, then default green; an
  explicit env `on` skips the file fallback. This preserves live Pi selections
  across `/reload` without treating the config-file theme as a permanent pin.
  `/pi-1337` and shutdown both route through `clear()`, which also resets
  `working`/`chromeActive` and clears the spinner timer so a re-enable never inherits
  a frozen frame.
- **Clean-copy shortcut.** `PI_1337_COPY_KEY` (default `alt+c`, empty = off)
  copies the editor's logical buffer via `copyToClipboard(getText())`. Native
  terminal selection grabs rendered cells (`│`, padding, per-row newlines) and
  cannot be fixed at the app layer; this is the clean escape hatch.
- **TUI-only side effects.** Guard with `ctx.hasUI` then `ctx.mode === "tui"`
  before all presentation changes, including the theme switch as well as the
  editor/footer/working row. RPC/JSON/print must not acquire chrome or timers.
- **Persona coupling is read-only.** The persona label comes from
  `footerData.getExtensionStatuses().get("persona")`, and the agent count prefers
  `…get("persona-agents")` (falling back to the delegate-derived count). Leftover
  background-leg cost (spend not yet on a `toolResult`) is `…get("persona-cost")`
  and is added to the session walk in `formatCost`. All three keys are captured
  in the empty-footer factory. This extension only reads these keys; pi-persona
  owns them.
- **Theme contract.** All twelve `themes/*.json` define the same 51 tokens;
  `theme.test.ts` enforces the set + valid color resolution for every palette,
  checks each file's `name` matches its filename, and applies the green
  phosphor/amber-role rule to the default `1337.json` only — the amber/ice/
  poison siblings are intentionally other-hued, Skynet uses a warm-white HUD, and
  Skynet Dark retains its red family. Also enforce
  `toolDiffContext` contrast ≥4.5:1 on `toolSuccessBg`, not only `dim` contrast.
- **Current host.** Develop and qualify only against the latest installed Pi
  release. Keep both Pi development packages pinned to that exact matched
  version and host-provided packages as wildcard peers; wildcard peers do not
  promise compatibility with older hosts. Tests locate the theme schema at the
  installed release's published `schemas/theme.schema.json`.

## Verify

```bash
npm run typecheck && npm test
npm run test:parity   # a pi checkout at ../pi; skips without one
PI_TUI="$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js" \
  npm run test:parity # …but prefer the bundle you actually run against
pi -e .   # manual: narrow/wide widths (frame centers, never overflows),
          # type while streaming (cursor + spinner), /pi-1337 restores default chrome
```

`test:parity` covers the one thing the unit tests structurally cannot: they
measure the frame with the same ruler that built it, so a mismeasure cancels out
and reads as correct. The parity sweep renders pi's **real** editor into the
frame and measures the result with **pi-tui's** `visibleWidth`, across scripts
terminals size differently (Indic/Burmese spacing marks, plane-2 ideographs,
vertical forms, emoji, tabs). It runs twice — once with pi-tui's ruler installed
(production; must be exact, non-zero fails) and once on the built-in mirror
(reports drift only; what matters is that `wider than the terminal` stays 0).
It also asserts up front that every helper `index.ts` imports is callable in that
bundle. Before the measurement seam existed, the sweep produced ~1800
mis-measured rows and ~780 rows wider than the terminal.
