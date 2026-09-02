# pi-1337 — architecture

A Pi **package**: a bundled theme + an advanced-redesign extension. The theme is
pure color; the extension reframes the editor and hides the rest of the chrome.
Keep the pure render logic separate from the Pi wiring.

## Layout

```
pi-1337/
├── package.json        # pi.extensions + pi.themes
├── themes/
│   ├── 1337.json       # default green ramp (51 tokens, AA-tuned, syntax de-collided)
│   ├── 1337-amber.json   # amber CRT sibling      ┐
│   ├── 1337-ice.json     # cool blue-white         │
│   ├── 1337-cyber.json   # modern indigo-blue      ├ same 51-token contract, other hues
│   ├── 1337-neon.json    # synthwave violet        │
│   ├── 1337-split.json   # green + magenta gun     │
│   ├── 1337-fallout.json # radioactive Pip-Boy lime │
│   └── 1337-skynet.json  # Terminator red-on-black ┘
├── src/
│   ├── index.ts        # wiring: events, /pi-1337 command, copy shortcut, apply/clear, theme switch, spinner timer
│   ├── editor.ts       # FramedEditor (CustomEditor subclass) + setEditorComponent factory
│   ├── frame.ts        # pure: frameEditor / layoutRow / isRuleLine (drops Pi's rules, builds the rounded box)
│   ├── format.ts       # pure: shortCwd / cleanModel / formatContext
│   ├── subagents.ts    # pure: countSubagentsFromInput / countSubagentsFromResult (live agent count)
│   ├── width.ts        # measurement seam: useTerminalMetrics + box geometry (+ pure fallback)
│   ├── background.ts   # pure: OSC 11 tint build/reset + hex normalize/resolve (opt-in terminal bg)
│   ├── avatar.ts       # pure: parse/select the theme's avatar frames — PNG or ASCII (pi1337.avatar)
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
2. calls `super.render(boxWidth − 2·GUTTER − 2)` to get the real editor at the
   inner width (the rounded box spends two columns per side on chrome gutters
   plus the rails);
3. hands the raw lines to `frameEditor` (pure), which drops the two rules, wraps
   each remaining line in `│` rails with fixed-width side gutters (prompt `›` +
   spinner on row 0), appends a status row, caps it with a clean rounded
   `╭─╮`/`╰─╯` outline, and left-pads every line by `leftMargin`.

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
- **Only override `render`.** `FramedEditor` extends `CustomEditor` and changes
  nothing else — editing, autocomplete, history, and keybindings stay the base
  class's. Never swallow input. (The clean-copy feature stays out of the editor:
  it's a top-level `registerShortcut` reading `getText()`, not a key intercept.)
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
  `provider/id` slug; the cost is hidden when `isUsingOAuth` (a subscription's
  figure is a nominal API-equivalent — a visible cost must always mean real
  spend); the branch comes from `footerData.getGitBranch()` with an
  `onBranchChange` subscription (unsubscribed in `clear()`) so switches repaint
  promptly. Session name/context/cost are refreshed on session/model/turn events,
  never by the 90ms render path; OAuth skips the cost walk entirely. All dynamic
  inline labels pass through the bounded linear terminal-control/bidi sanitizer
  before they enter the frame. Pi's two rules are dropped when the box is rebuilt, but they double
  as its scroll indicators — `scrollMarker` re-hangs `↑`/`↓` in the first/last
  content row's right gutter (the spinner wins row 0) so a buffer that continues
  above or below the visible rows stays visible.
- **The status row narrows semantically, never char-by-char.** The right
  segment is a `RowCandidate[]` degradation ladder resolved by
  `resolveSegment` (frame.ts, pure): the centered usage drops first
  (layoutRow's gap rule), then provider hidden → model trimmed with `…`
  (only the `flex` part trims; floor `MIN_FLEX`, the last rung trims below
  it) → persona alone when present, otherwise the model keeps trimming.
  Blind right-truncation was the old behavior — don't reintroduce it; the
  trailing truncation loops in `layoutRow` are extreme-width defense only.
- **Pi's other channels are not ours to re-implement.** `notify()` renders into
  the chat log; retry/compaction/branch-summary indicators keep their own
  `statusContainer` kinds (`setWorkingVisible(false)` suppresses only
  `working`); widgets/dialogs/pending-message queue are independent containers.
  Never suppress or duplicate them.
- **Repair out-of-band stderr; never own it.** Some third-party extensions still
  write `console.warn`/`process.stderr.write` after Pi's differential TUI is live.
  While the 1337 chrome is active, `redraw-guard.ts` calls the original writer
  first with the exact receiver/arguments/return value, then schedules one
  microtask repair per synchronous write burst through public
  `tui.requestRender(true)` to clear stale cached rows/cursor. Never
  wrap stdout (pi-tui renders there), never rewrite/buffer the foreign message,
  and dispose ownership-safely: restore only if our wrapper is still installed.
  `apply()` also forces one full redraw to repair diagnostics emitted just before
  the guard bound; `clear()` disables the guard before dropping the TUI handle.
- **One source of motion.** The row-0 braille spinner — a single `startSpinner`
  helper (`90ms` timer) driven by `agent_start`/`agent_end`, gated on `chromeActive`
  (so non-tui modes never start it) and re-derived in `apply()` so toggling on
  mid-turn revives motion; cleared on `agent_end`/shutdown.
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
  owns the write. The theme-driven **ASCII avatar** is the same shape: a widget
  (`setWidget("pi1337-avatar", …, {placement:"belowEditor"})` by default) whose frames come
  from the pure `avatar.ts` (`parseAvatar`/`selectAvatar`), swapped on a small
  task-state machine (`avatarState`: idle → working on `agent_start`, confused on
  `session_before_compact`, error at `agent_end` when a tool's `isError` fired
  that turn, else idle) and removed in `clear()` (`setWidget(key, undefined)`).
  It defaults to `belowEditor` (`pi1337.avatar.placement`): a kitty-image widget
  placed *above* the editor corrupts the input box's differential redraw beneath
  it (reserved image rows + cursor math) until a resize forces a full repaint;
  below the editor it renders after the box, and stays clear of the todos widget,
  which uses the default `aboveEditor` container. `align:"center"` pads via a
  widget factory that re-centers on each render width.
  Each state falls back toward `idle`, so a theme may ship one frame or four. Only
  present when the active theme ships `pi1337.avatar`; a `working`-only avatar
  "appears when the AI responds". A frame is a **PNG** (`{ image }`) or **ASCII**
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
  over-wide frame row), while an image row is a single escape sequence drawn at
  the cursor column and is padded but never clipped.
  index.ts owns the image runtime imports (allowed alongside editor.ts); avatar.ts
  stays pure (string parsing only). Both the tint and the avatar are read from a
  `pi1337` block in the theme JSON (`background`, `avatar`) via `ctx.ui.theme.
  sourcePath` — Pi tolerates the extra key (its TypeBox schema isn't strict; our
  files already carry `$schema`), and these palettes are themes *for* pi-1337, so
  carrying our config there is intended. Read in `apply()` into `themeConfig` +
  `themeDir`, and re-read on a live `/settings` switch: Pi fires no theme event, so
  the empty footer's `render` (run every UI pass) performs only a cheap
  `theme.sourcePath` compare. An actual change schedules one post-render
  microtask; only that task reloads the block, repaints the tint, swaps the
  avatar, and requests a full redraw. `clear()` invalidates a queued refresh.
- **Never stomp a persisted palette.** `applyTheme` targets
  `chooseStartupTheme(current)` (pure, in config.ts): an explicit `PI_1337_THEME`
  pin wins; otherwise a bundled palette Pi restored from the user's settings
  (e.g. `1337-ice` picked via `/settings`) is kept; only a foreign theme is
  replaced by the default green. Forcing the default over a sibling palette
  would also overwrite the user's persisted choice in Pi's settings.
  `/pi-1337` and shutdown both route through `clear()`, which also resets
  `working`/`chromeActive` and clears the spinner timer so a re-enable never inherits
  a frozen frame.
- **Clean-copy shortcut.** `PI_1337_COPY_KEY` (default `alt+c`, empty = off)
  copies the editor's logical buffer via `copyToClipboard(getText())`. Native
  terminal selection grabs rendered cells (`│`, padding, per-row newlines) and
  cannot be fixed at the app layer; this is the clean escape hatch.
- **TUI-only side effects.** Guard with `ctx.hasUI` then `ctx.mode === "tui"`
  before the editor/footer/working row. The theme switch is fine outside
  tui; the chrome is not.
- **Persona coupling is read-only.** The persona label comes from
  `footerData.getExtensionStatuses().get("persona")`, and the agent count prefers
  `…get("persona-agents")` (falling back to the delegate-derived count). Leftover
  background-leg cost (spend not yet on a `toolResult`) is `…get("persona-cost")`
  and is added to the session walk in `formatCost`. All three keys are captured
  in the empty-footer factory. This extension only reads these keys; pi-persona
  owns them.
- **Theme contract.** All eight `themes/*.json` define the same 51 tokens;
  `theme.test.ts` enforces the set + valid color resolution for every palette,
  checks each file's `name` matches its filename, and applies the green
  monochrome rule (amber family the only exception) to the default `1337.json`
  only — the amber/ice/split siblings are intentionally other-hued.

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
