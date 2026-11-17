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
│   ├── 1337-cosmos.json  # starlit mauve + star-gold accent on indigo-black│
│   ├── 1337-poison.json  # toxic green/orchid mix   │
│   ├── 1337-magma.json   # molten coral/orange + cyan│
│   ├── 1337-fallout.json # radioactive Pip-Boy lime │
│   ├── 1337-skynet.json  # Terminator 2 warm-white HUD on red-tinted black
│   ├── 1337-skynet-dark.json # red-on-near-black sibling                      ┘
│   └── *.pi1337        # per-palette spinner; both Cyberpunk variants, Fallout, and both Skynets opt into tint (not theme resources)
├── src/
│   ├── index.ts        # wiring: events, /theme-1337 command, copy shortcut, apply/clear, theme switch, spinner timer
│   ├── editor.ts       # FramedEditor (CustomEditor subclass) + setEditorComponent factory
│   ├── frame.ts        # pure: frameEditor / layoutRow / isRuleLine (drops Pi's rules, builds the rounded box, hangs the model label in its top edge)
│   ├── format.ts       # pure: sanitizers / shortCwd / cleanModel / costTotal / formatCost / formatRunDelta / formatContextWindow / parseBackgroundStatus
│   ├── tool-lexicon.ts # pure: the one vocabulary for built-in tools (row title, status verb, tally clause)
│   ├── tool-view.ts    # pure: compact tool rows, diff previews, the folded-run tally row, the flat row for third-party lines
│   ├── tool-adapter.ts # pure: switchable polished/baseline row adapter (self shell, fold decisions) + the flat shell for third-party renderers
│   ├── tool-groups.ts  # pure: runs of settled exploration calls → normal / hidden / summary
│   ├── tool-activity.ts # pure: tool events → the status row's "Running npm test…" label, and the run clock ("Working… 45s")
│   ├── run-summary.ts  # pure: per-run collector (files, lines, commands, outcome, model time, output tokens) + the end-of-run row
│   ├── terminal-title.ts # pure: run state → terminal title text, and Pi's default title rebuilt
│   ├── quota.ts        # pure: subscription quota from response headers, the Codex stream event and the usage-limit error → the status row's view
│   ├── diff-spans.ts   # pure: bounded changed-span comparison for replacement lines
│   ├── width.ts        # measurement seam: useTerminalMetrics + box geometry (+ pure fallback)
│   ├── background.ts   # pure: OSC 11 tint build/reset + hex normalize/resolve (opt-in terminal bg)
│   ├── avatar.ts       # pure: parse/select optional user-configured avatar frames
│   ├── spinner.ts      # pure: validated text-motion profiles and frame selection
│   ├── redraw-guard.ts # reversible stderr observer → coalesced full TUI redraw (never alters bytes)
│   └── config.ts       # env-driven config (PI_1337_*)
└── test/
    ├── width.test.ts     # width math (ANSI-aware, emoji = 2 cols)
    ├── format.test.ts    # path + model + context formatting, sanitizer grammar properties
    ├── frame.test.ts     # rule detection, border composition, framing + margins, status overlay
    ├── box.test.ts       # box geometry: margins, cap, narrow fallback
    ├── editor.test.ts    # framed editor: status roles, ladders, activity overlay, mouse mapping
    ├── tool-lexicon.test.ts  # vocabulary table, prototype-key safety, tally sentences
    ├── tool-view.test.ts     # row headings, receding metadata, previews, tally row
    ├── tool-adapter.test.ts  # lanes + folding through the host's real ToolExecutionComponent
    ├── tool-groups.test.ts   # run boundaries, fold rules, expand
    ├── tool-activity.test.ts # labels, grace period, parallel calls
    ├── run-summary.test.ts   # collector counts, outcomes, the row ladder, malformed entries
    ├── terminal-title.test.ts # title text per state, sanitizing, the rebuilt default
    ├── quota.test.ts         # header and event parsing, units, snapping, per-window merge and expiry, the limit marker, hostile and generated input
    ├── tool-wiring.test.ts   # resolver registration + event-fed folding through index.ts
    ├── diff-spans.test.ts    # changed-span comparison bounds
    ├── diff-host.test.ts     # edit previews against the host's recorded diff format
    ├── activity.test.ts      # run lifecycle through index.ts: spinner, avatar, prompts, compaction, label, quota events, a displaced editor
    ├── lifecycle.test.ts     # apply/clear reversibility, theme ownership, the shared editor slot, shutdown
    ├── config.test.ts    # env-over-file settings, toggles, copy shortcut
    ├── command.test.ts   # /theme-1337 command name
    ├── avatar.test.ts    # avatar parsing, state fallback, image-cell layout
    ├── background.test.ts # OSC 11 build/reset, hex resolution
    ├── spinner.test.ts   # sidecar motion profiles and frame selection
    ├── redraw-guard.test.ts # pass-through, coalescing, full-redraw, ownership-safe disposal
    ├── theme.test.ts     # 51-token contract + var resolution + monochrome guard
    ├── architecture.test.ts # source guards: footer render stays pure, quota stays pure and cached, avatar uses Pi's Image
    ├── host.test.ts      # the pinned Pi release loads the package and every palette
    ├── package.test.ts   # manifest and lockfile identity agree
    ├── parity.ts         # NOT in `npm test`: frames pi's real editor, measures with pi-tui
    └── preview.ts        # NOT in `npm test`: `npm run preview` paints a sample session in any palette
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

- **Pure modules.** `frame.ts` / `format.ts` / `width.ts` / `background.ts` / `avatar.ts` /
  `tool-lexicon.ts` / `tool-view.ts` / `tool-adapter.ts` / `tool-groups.ts` / `tool-activity.ts` /
  `run-summary.ts` / `terminal-title.ts` / `quota.ts`
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
- **The border carries exactly one label: the model identity, top-right.**
  `frameEditor` takes a `borderLabel` ladder (`RowCandidate[]`, widest first).
  The top row is corner, at least two rule cells, a space, the label, a space,
  exactly two rule cells, corner — `╭─… provider/model · level ──╮` — and is
  always exactly the box width by the shared ruler. The editor supplies
  `provider/model · level` (whole) → `model · level` → `model` (the model is
  the flex part). Provider and slash are `dim`, the model `accent`, the
  separator `dim`, the level in its `thinking*` token. The level (`ctx.thinkingLevel`,
  cached on refresh and on `thinking_level_select`) shows only for a reasoning
  model and only for Pi's whitelisted lowercase names, never `off`. When no
  rung fits, only a lone `…` would, or the label has nothing visible (a model
  id that sanitizes to nothing offers no rung at all, so there is never a bare
  `provider/`), the border is the plain rule, byte-identical to an unlabelled
  one. Nothing else enters the border and the
  bottom border stays plain: the model identity rarely changes, so it earns a
  fixed place and frees the status row for what does change. Don't add a second
  label, don't re-add a footer line, and don't add an extension-status row
  (tried; permanent statuses turned it into noise — third parties keep the chat
  log / widgets). Inside the box: the prompt sigil + spinner (row 0 gutters) and
  the status row; the footer is empty. The sigil reacts to bash mode through
  one predicate, `bashInputMode` (none / context / excluded), which trims
  leading whitespace as the host does: a leading `!` flips `›` to a
  `bashMode`-colored `$`, and `!!` — the host runs it and keeps its output out
  of the model's context, painting the block `dim` — to a `dim` `$`. The sigil
  is the whole signal: no text label joins it.
  `shortCwd` anchors `~` on segment boundaries — case-insensitively on Windows —
  and treats `~` as an anchor, not a segment (`~/src/project` stays whole; the
  ellipsis appears only when segments are omitted), so a `HOME` with a trailing
  separator or a shell reporting `C:\users\me` while `USERPROFILE` says
  `C:\Users\me` still resolves to `~/…/x/y`. The branch comes from
  `footerData.getGitBranch()` with an `onBranchChange` subscription
  (unsubscribed in `clear()`) so switches repaint promptly. Session name,
  context and cost are refreshed on session/model/turn events, never by the
  90ms render path. One refresh more keeps them current inside a turn: an
  assistant `message_end` sets a flag (nothing is read there — Pi appends the
  message to the session after its listeners return), and the first top-level
  `tool_execution_start` that finds it set, with the redesign on and the
  chrome active, clears it and refreshes. One session walk per response,
  however many calls it launched; no `requestRender` (the spinner repaints);
  the run baseline is untouched, so the delta simply includes the new spend. All dynamic
  inline labels pass through the bounded linear terminal-control/bidi sanitizer
  before they enter the frame. The escape grammar (`skipTerminalSequence`) and
  the unsafe code-point predicates live once, in `format.ts`: the inline and
  art sanitizers and tool-view's `safeOutput`/`safeExpandedText` share them and
  differ only in whitespace, limit and escaping policy — never fork the grammar.
  They read code points through `codePointAtIndex`, never `String.prototype.codePointAt`:
  on Node 26.3 V8's Maglev tier answers that call, for a sliced string ending on
  a high surrogate, with the pair's astral code point, which let a raw half
  surrogate (measured 0 columns, painted 1) through. Pi's two rules are dropped
  when the box is rebuilt, but they double as its scroll indicators —
  `scrollMarker` re-hangs `↑`/`↓` in the first/last content row's right gutter
  (the spinner wins row 0) so a buffer that continues above or below the
  visible rows stays visible.
- **The status row is two groups.** LEFT = where you are: workspace · branch ·
  session (full → workspace only → `…/basename`). RIGHT = the session's state,
  right-aligned, one `RowCandidate[]` ladder:
  `[gauge] tokens/window · % · ~$cost +$delta · <quota> · persona`. There is
  no centered segment, no agent count and no model on the row, so it reads the
  same with and without pi-persona (the persona simply is or is not the last
  item). `<quota>` is the subscription quota of the current provider (its own
  rule, below): `5h 43% · wk 12%`, `wk 85%`, or `limit`; with none known the
  row is byte-identical to a row without the feature (`editor.test.ts` pins
  that against digests recorded before it existed).
  Colors follow the active theme through semantic roles; context keeps the
  >70% warning / >90% error colors, judged on the whole percent the row prints.
  A quota label is `dim` and its percentage `muted`, `warning` above 70 and
  `error` above 90 by the same `usageLevel`; `limit` is `error`; a calm
  percentage whose figure has aged is `dim` at the same width, a warning or
  critical one never dims.
  The row narrows semantically, never char-by-char. Surrender order:
  1. Ornaments never cost content. They go in this order — the run delta,
     the window denominator, the second quota window, the gauge (which needs
     only a known percentage), then the binding quota window while it is
     calm — and each is shown only while the FULL left group and everything
     that outranks it still fit. So with a calm quota known, the gauge needs
     room for the binding window too, and nothing ever reappears as the row
     narrows. The editor decides this before layout, because `layoutRow` lets
     any right rung outrank left detail.
  2. Then the left gives up detail (session, branch, the path down to
     `…/basename`) while the core right stays. It gives up WHOLE details: the
     left ladder's rungs are `cwd · branch · session` → `cwd · branch` → `cwd`
     → `…/basename`, and none of them puts the branch in a `flex` part. A
     branch is an identifier, shown whole or not at all — `…/proj · m…` was
     the bug. Only the session name, free text, may shorten, and only down to
     `SESSION_MIN_COLUMNS` (nine characters and `…`); a shorter name is whole
     or absent. A rung states such a floor with `RowCandidate.minFlex`, which
     holds for the last rung too: `fitSegment` skips it below its floor and
     `resolveSegment` then returns nothing instead of hard-truncating it. Only
     a last rung without `minFlex` is hard-truncated.
  3. Then the right narrows: the cost goes, then the token count, then the
     persona trims and goes, then a HOT quota — the binding window above 70%,
     or `limit` — which is content and therefore stays while the left gives
     up detail, and the context percentage stands last — shown whole or not at
     all: a clipped `11…` would read as another number. A quota text is never
     clipped either; a ladder that carries one ends in the empty rung.
  `tokens: null` reads a dim `ctx —`; no usage, no cost and no persona leave
  the right group empty. Blind right-truncation was the old behavior — don't
  reintroduce it; the trailing truncation loops in `layoutRow` are
  extreme-width defense only. The box cap is `PI_1337_MAX_WIDTH` / `maxWidth`
  (default 100; `0`/`full` uncapped; never below 40), read at load.
  While Pi works, a call that has been running for half a second is named in
  the left group's place (`Running npm test…`, ` +2` for parallel siblings).
  `tool-activity.ts` tracks top-level `tool_execution_start`/`end` (nested
  `parentToolCallId` calls are skipped — the host never renders them as rows)
  against injected time. The label is the oldest running call, so a parallel
  batch does not make it jump, and the grace period keeps fast calls and
  pi-persona's background `delegate` launches from flashing. It is drawn as a
  `layoutRow` overlay: the row is laid out from its two groups first and only
  the left group's cells are repainted, so the right group is byte-identical
  idle and working and nothing reflows. Once the named call has run three
  seconds the label carries a dim, rounded-down elapsed time before the
  sibling count (`Running npm test… 14s +2`); the count yields first, then the
  time, and the label trims last, to no fewer than `ACTIVITY_MIN_COLUMNS`
  (`Running…`); with fewer cells the workspace keeps its place. It starts no timer — the spinner's repaint
  reveals it — and the raw-render cache is untouched. Compaction is not
  labelled; Pi's own indicator owns that.
  When no call is named, the same slot carries the run clock: once the run has
  lasted three seconds (`RUN_CLOCK_GRACE_MS`) it reads `Working… 45s`, the
  label in `text` and the time in `dim`, rounded down by the tool label's own
  `formatElapsed`. It counts from the run's first `agent_start` after a settle,
  so a retry, a mid-run compaction and a drained follow-up never restart it,
  and time spent in a prompt or a compaction is part of the count. Its rungs
  have no flex part and are shown whole or not at all: `Working… 45s` →
  `Working…` → the workspace row as it was; it is never trimmed. A named call
  takes the slot once it has outlived its own half-second grace, and a call
  still inside that grace does not blank the clock (`currentActivity`); the
  clock returns with the run's whole age when no call is named. It is not
  shown during a blocking prompt, during compaction (manual compaction with
  no run included), after `agent_settled`, for a run that began while the
  redesign was toggled off, or in a session that started mid-run —
  `session_start` stops it. A run that began with the redesign on keeps its
  clock across a toggle off and on. It is the tool label's overlay, so the
  right group stays byte-identical, it starts no timer (the spinner's repaint
  advances it) and the raw-render cache is untouched. It never enters the
  terminal title, which stays `● Working — …`. `PI_1337_ACTIVITY=off` (config
  `activity:false`) hides the label and the clock.
- **The cost is an estimate, and it is the same sum Pi's footer makes.**
  `costTotal` adds the entries the stock footer counts — message, compaction,
  branch-summary and Pi `usage` entries, over the whole session file — plus
  pi-persona's `persona-cost`; a recomputation over 30 real sessions matched
  the footer in every one. It is always marked `~$`: these are list-price,
  API-equivalent figures, never an assertion of billing, and there is no
  subscription marker on it because the current model's auth state cannot
  classify historical or child spend. The subscription signal is the quota
  item beside it, which shows only what the provider itself reported; the two
  are never combined. `formatCost` picks its decimals from the rounded
  value (three below $1, two from $1) and prints `~<$0.001` for a positive
  total that rounds to zero. The session-entry sum is cached on agent, turn
  and session events; the empty footer's render compares the raw
  `persona-cost` string and, on a change, recomputes from the cached sum and
  requests one repaint — render never walks the session. The run delta is the
  current total minus the total when the run began: it shows as `+$x.xx` once
  a cent prints, stays after settlement until the next run, and resets on
  every `session_start`. A run begins at the first `agent_start` after a
  settle and ends at `agent_settled`: Pi emits `agent_start` again inside one
  run for an auto-retry, a mid-run compaction and each drained steering or
  follow-up message (pi-persona's wakes included), and those must keep the
  baseline, the summary collector and the title state. A run that begins
  while the redesign is toggled off has no baseline — never the previous
  run's.
- **The quota is what the provider said, and nothing we asked for.** The row's
  `<quota>` item shows the subscription's rate windows as percent USED, from
  three things Pi already hands extensions; the package makes no request of
  its own, reads no credential and starts no timer for it. `quota.ts` is pure
  (injected time, no Pi import) and total: no exported function throws on any
  input. What is known is kept per provider — never without one — so a model
  switch away and back finds its figures, at most eight providers.
  - *Families, by api AND prefix.* `after_provider_response` carries
    `{ status, headers }` with no provider or model, so inside a turn the
    response is credited to the model that turn started with (recorded at
    `turn_start`, dropped at `turn_end` — a model switched to while the
    request is in flight must not receive another account's figures) and
    outside one to the current model (`ctx.model`). Its api picks the vocabulary and only
    exact, lowercase header names of that vocabulary are read:
    `anthropic-messages` → `anthropic-ratelimit-unified-{5h,7d}-utilization`
    / `-reset` (a closed set of two account-wide windows);
    `openai-responses` and `openai-codex-responses` →
    `x-codex-{primary,secondary}-used-percent`, `-window-minutes`,
    `-reset-at`, `-reset-after-seconds`. Any other api reads nothing.
  - *Units.* Anthropic utilization is a FRACTION (`0.81` is 81%) and can pass
    1; Codex used-percent is a PERCENT already (`0.73` is under 1%). Both
    clamp to 100 up to ten times the limit and are rejected beyond. Resets
    are epoch SECONDS, exactly ten digits (a 13-digit millisecond value is
    not one), or for Codex seconds from now as the fallback. Header values
    must match anchored, bounded decimal/integer patterns; stream fields must
    be `typeof === "number"`. Nothing read from a header, an event or an
    error message is ever printed: labels are generated from a canonical
    duration (`5h`, `wk`, `30d`) and digits from parsed numbers.
  - *Durations.* A Codex slot says nothing about its length, so each declares
    `window-minutes`; servers report 299 and 10079 for the five-hour and
    weekly windows, so a declared length snaps to the whole hour (under a
    day) or whole day it lies within 5% of, and the canonical minutes are
    what is stored and labelled. A length that is neither is dropped.
  - *Per-window merge and expiry.* A response carries a subset of windows
    (the observed Anthropic responses carried only the weekly one), so
    windows are kept per canonical duration within one provider and family,
    each with the time it was last seen; at most two, the most recently seen.
    A window leaves when its reset passes, or — with no believable reset (a
    missing one, or one further away than the window is long plus a day) —
    thirty minutes after it was last seen. Past thirty minutes, or dated
    after now, a figure is `aged`. Valid family headers update the figure
    whatever the status (a 429 at 100% is the most useful one there is).
  - *Two misses clear.* Two consecutive 2xx responses from a provider with no
    header of its family (`anthropic-ratelimit-unified-*`,
    `x-codex-primary-*` / `x-codex-secondary-*`) mean the account or its auth
    changed and drop everything known about that provider. Non-2xx responses
    do not count, and family headers that are present but unusable are not a
    miss.
  - *The stream event.* On its default WebSocket transport the Codex adapter
    fires no `after_provider_response`, but every raw stream event of every
    provider passes through `provider_stream_event`. That handler returns
    after two comparisons unless `api === "openai-codex-responses"` and
    `data.type === "codex.rate_limits"`; then `rate_limits.primary` /
    `.secondary` (`used_percent`, `window_minutes`, `reset_at`,
    `reset_after_seconds`) are read with the header bounds. The shape is the
    one Pi's own `packages/ai/test/openai-codex-stream.test.ts` replays.
  - *The limit marker.* On OpenAI's ChatGPT login the only signal is the
    error: a 200 without quota headers, then an assistant `message_end` with
    `stopReason: "error"`. `isUsageLimitMessage` matches the phrase
    `usage limit`, any case, in the first 512 characters of `errorMessage` —
    nothing else, so the generic "rate limit" errors of pay-per-use APIs do
    not match. The provider is then `limited`: the row shows `limit` in place
    of the windows until that provider's next assistant message that is an
    answer (an error or an interrupted attempt says nothing about the account
    and leaves it), or the two-misses rule. Each such error restarts the
    miss count, so the mark holds across retries.
  - *Events, not timers.* Handlers are synchronous, constant-time, wrapped so
    they cannot throw (pi-ai awaits `after_provider_response` before it reads
    the stream) and do nothing outside the TUI. They keep recording while the
    redesign is toggled off, like prompt and compaction state. The view for
    the current model is rebuilt on those events, on `model_select`,
    `session_start`, `session_tree` and on run/turn events — that is where an
    expired window is noticed — and cached; the 90 ms render path reads only
    the cached view. Nothing about quota enters the summary row or the title.
  - *What was observed, and what was not.* Observed on a live account:
    Anthropic's unified headers (weekly window only), and the OpenAI
    usage-limit error. Implemented from the official client's format and
    Pi's own fixture, not yet seen live here: the Codex headers and stream
    event, and Anthropic's five-hour headers. Providers that report nothing
    (`openai-completions` routes such as z.ai, OpenRouter) show nothing.
    Unknown by construction: the plan, the absolute limit, what a percent is
    of, other windows (model-scoped weekly, overage), and when a `limit`
    will lift.
  `PI_1337_QUOTA=off` (config `quota:false`), read at load, registers neither
  handler and leaves the row as it is.
- **Compact tool views are presentation-only.** `tool-view.ts` and
  `tool-adapter.ts` use type-only Pi imports; runtime constructors are injected
  from `index.ts`. `registerToolRenderer` changes standard tool rows and supplies
  a fallback for otherwise unrendered tools, never execution, schemas, prompts
  or results. Unknown tools with custom renderers keep their content; while the
  redesign is active their frame is ours. A non-built-in tool whose descriptor
  has both `renderCall` and `renderResult` and does not declare
  `renderShell: "self"` goes through `createFlatToolView`: one status dot, then
  the renderer's call lines; its result lines under `└`; later lines of each
  slot aligned two columns in; no background fill and no box pad rows. Side
  padding is `outputPad` and yields before content; the renderer is given
  `width − 2·pad − 2` columns, never below 1. The dot and connector take our
  rows' roles (`statusRole`, `resultRole`). The lines are the renderer's own:
  never rewritten, wrapped or sanitized (they are already-styled output,
  painted as the host would paint them). A line wider than the inner width is
  clipped without an ellipsis, and only the fully blank rows a slot opens or
  closes with are dropped — they are its padding. A result with no call line
  above it takes the dot; a row whose slots render nothing takes no lines.
  Toggled off, the same components sit in the host's box, recomposed by the
  baseline lane, and existing rows return to it exactly.
  One exception, by decision: a row whose slots render no line at all takes
  none in either state, and active that includes slots of nothing but blank
  lines. Off, the host's default shell would still print its separator row
  above the empty box, and that single row is out of reach: the host gives a
  `renderShell: "self"` row its separator only together with at least one
  line of the row's own, so such a row is zero rows tall or two and more,
  never one. An empty row is therefore one blank row short of the host while
  toggled off; blank-only slots and a slot beside an empty one equal it
  exactly. Don't pad the row to "fix" this — that is two blank rows.
  Left to the host: a descriptor with `renderShell: "self"` or one missing
  either hook is returned unchanged (the host's fallback formatter for the
  missing slot is private and cannot be recomposed byte for byte); a row whose
  current result has image content keeps the host box while that result is
  current; a row whose renderer emitted a Kitty/iTerm2 image-protocol line
  keeps the host box for the rest of its life — the payload is never prefixed
  or clipped. So does a row whose renderer returned a line that is not a
  string (`[undefined, "x"]`): the host's Box paints it as the text it
  coerces to, and no string method of ours may ever meet it — a render must
  not throw where the host does not. A self-framed lane has no Box, so its
  non-string lines are handed on untouched, as the host hands them on.
  State, single call, performance: such a row has ONE lane. Its hooks run once
  per host display update, in either state, never per frame, with the host's
  own `context.state` object (our row lives on it under a per-tool symbol key)
  and their own previous component as `lastComponent`; a toggle never forks or
  resets that state. A hook that throws gets the adapter's generic text for
  that slot inside the same frame. The flat shell keeps one memo per slot,
  reused while the width, `outputPad`, the theme object, both mark roles and
  every line (`===`, against a copy — a component may rewrite its own array)
  are last frame's; the children still render every frame, the marks are
  painted only when the row is recomposed, and `invalidate()` drops the memo.
  A repeat frame measures nothing. These rows never fold and never consult or
  feed the run registry: they stay out of `adapterTools`, and their
  `tool_execution_start` closes the open exploration run. A click on the
  renderer's cells is offered to its component in that component's
  coordinates; the dot, connector and padding columns are the host's, which
  expands the row. An HTML export made while toggled off gets the baseline
  lane's box for these rows, as built-in rows do; only `PI_1337_POLISH=off`,
  which registers no resolver, is stock. Use semantic theme
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
  wrapping and highlighting. The adapter must cost what a host row costs: each
  row keeps one shell (Box or Container) per slot across frames and rebuilds it
  only when the lane, shell kind or child components change, so pi-tui's own
  Box cache keeps hitting — never call `addChild`/`clear`/`setPaddingX` on an
  unchanged frame. The shell still renders every frame, because a child may
  change its lines without telling anyone; only the clip is memoized, reused
  when the width matches and every line is `===` last frame's. `invalidate()`
  drops both shells and both memos. Before this, 500 rows cost 25× the host's
  frame with the theme on and far more with it toggled off.
  Collapsed running and failed results preview their END — the last two
  (running) or three (failed) non-blank lines of a bounded suffix that starts
  at a line boundary — because that is where progress and the actual error
  are; earlier output is announced above them (`└ … earlier output (hint)`).
  A carriage return rewrites its line, so a progress meter shows its newest
  value, and a single line longer than the window is cut from the left.
  Settled successful previews keep the head and skip leading blank lines.
  Settled successful quiet headers end with what the call found (`· 6 matches`,
  `· no results`, `· 12 entries`, `· 40 lines`), counted once per result from the
  host's own result contract (its zero-result texts, `*LimitReached` shown as
  `N+`, `truncation.totalLines`) and handed from `renderResult` to the header
  through the row's shared `context.state`; error, partial and expanded rows
  show none, and grep with context lines shows only zero or the limit — never
  print a number that cannot be derived. Read titles carry stock Pi's
  `:start-end` range; a bash title is the command's first non-blank line plus
  ` …` when more follow. A folded tally names its files by basename when the
  whole row fits (`Read width.ts, frame.ts · searched 2 patterns`) and counts
  them otherwise; it never shows a partial or ambiguous list.
  The host still owns image rendering. Active-TUI
  HTML exports inherit these renderers because the public renderer context has
  no export-mode flag.
  Row headers lead with the title; the duration (shown from one second up) and
  the expand hint recede in `dim` and yield in whole rungs — the hint first,
  then the duration — before the title truncates; neither is ever clipped.
  A bash row that is still running (pending or partial) carries stock Pi's
  ` (timeout 30s)` as one more dim rung after the title, the first to yield
  and gone with the final result. The value is the model's: only a finite,
  positive number of seconds within the host shell's own ceiling
  (2147483.647 s) is shown, spelled by `timeoutRung` to the millisecond —
  never the raw argument, and never in the status row.
  Tool words live once in `tool-lexicon.ts` (row title, status verb, tally
  clause) behind a Map — tool names are model-controlled, so never look one up
  on a plain object.
  Folding settled exploration is also presentation of the transcript itself.
  `tool-groups.ts` keeps runs of consecutive `read`/`grep`/`find`/`ls` calls
  whose rows our adapter renders. `tool_execution_start` adds a call; the row
  itself settles it when it shows its final result (`GroupControl.settle` from
  `renderResult`) — Pi tells extensions a tool ended before it updates the row,
  so a registry settled by `tool_execution_end` hid a run's rows while the row
  meant to carry the tally still rendered as running. A painted row closes the run wherever Pi
  announces it: another tool (`bash`, `edit`, `write`, custom tools), a user or
  custom message, assistant text, an assistant error line, a non-blank thinking
  block (this extension always sets a hidden-thinking label, so thinking is a
  visible row) and compaction. A streaming assistant message is empty at
  `message_start`; `message_update` closes the run when its first thinking or
  text appears. Known limit: `notify()` output and the host's own cache/thinking
  notices reach no extension event, so a run can span one of those rows. A run
  with at least three settled, successful, image-free calls folds, open or
  closed: the last of them renders one tally row (`● Read 3 files, searched 2
  patterns (ctrl+o to expand)`) and the others render zero lines. Hidden rows
  take no lines, so while a run is open the tally stays put and counts up as
  each later call settles into it; a row is hidden only while another row of its
  run renders the tally, and a call still running keeps its own row. Failed calls and calls with image payloads keep their own
  rows and are not counted (the host paints images outside our shell — hiding
  the row would orphan them). The tally counts distinct paths and patterns, not
  calls: paging one file three times reads `Read 1 file`. A left click on the
  tally, or on any row of a run, unfolds that run for good — the host expands
  only the clicked row, and a row the user opened must never strand its siblings
  behind a tally nothing renders. Ctrl+O (`context.expanded`) renders every row.
  A row without a final result never folds, which also keeps HTML export whole:
  the exporter renders the call slot as partial and the result slot on its own.
  Whenever the host rebuilds the chat (resume, tree navigation, compaction) the
  registry resets — on session_start, session_tree, session_compact and
  clear — because rebuilt rows replay no events and a branch may end inside a
  run, without its tally row. `PI_1337_GROUPS=off` (config
  `groups:false`) disables folding, and `PI_1337_POLISH=off` implies it. Both
  toggles, like `PI_1337_ACTIVITY`, are read when the extension loads.
- **Pi's other channels are not ours to re-implement.** `notify()` renders into
  the chat log; retry/compaction/branch-summary indicators keep their own
  `statusContainer` kinds (`setWorkingVisible(false)` suppresses only
  `working`); widgets/dialogs/pending-message queue are independent containers.
  Never suppress or duplicate them. Folding settled exploration rows into a
  tally is presentation of the chat log itself, not suppression of a channel:
  the calls stay in the session and the model's context, return on click or
  Ctrl+O, and `PI_1337_GROUPS=off` restores
  one row per call.
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
  active, unpaused motion; it never creates a second timer. The activity label
  and the fold registry start no timers: tool and message events feed them, and
  the label's grace period is checked during the spinner's own repaint.
  Both Skynet profiles
  use the crimson `#d51f2a` pyramid with its fixed three-cell right gutter and four-cell status
  reservation; with autocomplete and only one content row, only its top triangle
  is shown so suggestion indices never shift. Other bundled profiles stay one-row.
- **Always reversible.** Everything `apply()` changes, `clear()` restores:
  the editor slot (its own rule, below), `setFooter(undefined)`, `setWorkingVisible(true)`,
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
  The activity tracker and the fold registry install no chrome of their
  own — reversibility for them is the reset in `clear()`: the label vanishes, every
  run decision returns to `normal`, and the baseline lane (or host renderers
  under `PI_1337_POLISH=off`) renders the transcript untouched.
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
- **The editor slot is shared; only our own factory is ours to remove.** The
  host has one editor factory (`setEditorComponent` / `getEditorComponent`) and
  any extension may set it. `apply()` keeps the factory it installs in
  `ourEditorFactory` and remembers what held the slot before in
  `previousEditorFactory` — unless that is a factory of ours (a second
  `apply()` without a `clear()`, or a stale one handed back by someone else),
  which is never stored as "previous". `clear()` touches the slot ONLY while
  `getEditorComponent() === ourEditorFactory`: an editor another extension
  installed after us stays where it is. Then `/theme-1337` off calls
  `setEditorComponent(previousEditorFactory)` inside try/catch, falling back
  to `undefined` when that factory throws, and `session_shutdown` always calls
  `setEditorComponent(undefined)` — never instantiate another extension's
  editor while the session is being torn down (the host resets the slot itself
  on reload and session switch). Both variables are dropped in `clear()`. A
  host or test double without `getEditorComponent` cannot answer the ownership
  question and keeps the old unconditional reset.
  While the redesign is on, an editor installed AFTER ours (or a slot emptied
  by someone else) leaves our frame unmounted with the footer emptied and
  Pi's working row hidden — no cwd, model, context, cost or spinner anywhere.
  No event announces it, so the empty footer's render does one identity
  compare per UI pass (`getEditorComponent() !== ourEditorFactory`) and, from
  a microtask, never from render, the chrome is handed back:
  `setFooter(undefined)`, `setWorkingVisible(true)`, our spinner timer
  stopped, `displaced = true`. Tool rows, the theme, the title and the
  summary stay (they hang on `chromeActive`, which stays true); with the
  footer gone its per-pass checks stop too, so a live theme switch, the
  activity label in the title and an idle `persona-cost` change are picked up
  only at the next event. The frame is never retaken by itself: only the next
  `apply()` — `/theme-1337` or `session_start` — installs it again, over
  whatever holds the slot then. `clear()` cancels a queued check.
- **Never stomp a persisted palette.** `applyTheme` targets
  `chooseStartupTheme(current, appearance)` (pure, in config.ts): an explicit
  `PI_1337_THEME` palette pin wins; otherwise Pi's current bundled palette (e.g.
  `1337-ice` picked via `/settings`) is kept. When Pi has no bundled choice, an
  unset env uses the config-file palette as a startup fallback; failing that, a
  current theme whose `appearance` is light is kept — every bundled palette is
  dark, and a dark palette on a light terminal is unreadable — and only then
  default green. An explicit env `on` skips the file fallback and applies green
  even on a light theme: the user asked for it. This preserves live Pi selections
  across `/reload` without treating the config-file theme as a permanent pin.
  `/theme-1337` and shutdown both route through `clear()`, which also resets
  `working`/`chromeActive` and clears the spinner timer so a re-enable never inherits
  a frozen frame.
- **Clean-copy shortcut.** `PI_1337_COPY_KEY` (default `alt+c`, empty = off)
  copies the editor's logical buffer via `copyToClipboard(getText())`. Native
  terminal selection grabs rendered cells (`│`, padding, per-row newlines) and
  cannot be fixed at the app layer; this is the clean escape hatch.
- **TUI-only side effects.** Guard with `ctx.hasUI` then `ctx.mode === "tui"`
  before all presentation changes, including the theme switch as well as the
  editor/footer/working row. RPC/JSON/print must not acquire chrome or timers.
- **One deliberate session-file write: the end-of-run summary.** When a run
  that called a tool, was interrupted or failed settles, `index.ts` calls
  `pi.appendEntry("pi1337-run-summary", data)` once, synchronously in
  `agent_settled`, never from a timer; a chat-only reply gets none. `data` is
  versioned plain JSON with raw numbers, collected by the pure `run-summary.ts`
  from live events (nested script calls count, and their results are not
  persisted, so nothing is recomputed on resume). It is the only thing this
  package writes into a session, and it is safe because custom entries never
  become model input — not in compaction, not in branch summaries — touch no
  message queue (pi-persona's follow-ups are undisturbed) and are skipped by
  HTML export. The row reads `● Done in 2m 14s · edited 3 files +42 −7 · wrote
  1 file · 6 commands, 1 failed · ~$1.24` and narrows as a ladder of whole
  forms; when it has files to list, its widest form ends with the dim expand
  hint tool rows use, the first thing dropped; expanded it lists one row per
  file. The entry may carry four optional fields; its version stays `1`, an
  entry without them renders byte-identically to before, and a malformed one
  is ignored on its own while the rest of the row still renders. `waiting`
  (`{ agents, monitors, timers, scripts }`) is a snapshot of pi-persona's
  background work taken at `agent_settled`, stored only when a count is
  positive; it changes what the row says, never whether one is written. A
  `done` run with `waiting` has not finished the job: its dot is `muted`, its
  word is `Turn ended`, and the clause comes last in `muted` — `● Turn ended
  in 9.0s · 7 tool calls · ~$0.08 · waiting on 3 agents, 1 monitor, 1 timer,
  1 script`. Interrupted and failed rows keep their dot and word and carry
  the same clause. The ladder drops, in order: the expand hint; the per-kind
  breakdown, for one count (`waiting on 6 background tasks`) only where that
  is shorter; the command or tool-call total, keeping the failures; the cost;
  `wrote …`; the `+/−` counts; the failures; `edited …`; the waiting clause;
  the duration; the word, leaving `●`. Once the total is gone the failure
  count carries its noun — `1 command failed` when only commands failed,
  otherwise `1 call failed` — because `· 1 failed` after `edited 1 file` reads
  as a failed file; a row with no commands says `N call(s) failed` in its
  widest form too, while `6 commands, 1 failed`, `5 commands · 3 other failed`
  and `3 tool calls, 2 failed` stand. `modelMs` is the sum over the run's
  turns of `turn_start` → that turn's assistant `message_end`, absent when no
  turn was measured and never above `durationMs`; `outputTokens` is the sum of
  `usage.output` over the run's assistant messages, absent when any of them
  lacked a usable value, so it is never a partial sum. They feed one `dim`
  line on the expanded row only, under the headline and above the files:
  `model 1m 32s · tools 42s · 48 tok/s`. `tools` is `durationMs − modelMs`
  (shown from one second), so it is everything that was not waiting on the
  model — retry back-off, compaction and prompt waits included — and must not
  be read as tool execution time alone. `tok/s` is output tokens ÷ model
  seconds, rounded, shown only when model time is at least a second and the
  rate rounds to at least 1. `thinkingMs` is the sum of `thinking_start` →
  `thinking_end` from `message_update`'s `assistantMessageEvent`, on the
  injected clock; a block the stream left open is closed at that assistant
  message's `message_end` and dropped at the next `turn_start`. It is stored
  and read only from one second up, only beside a `modelMs`, and never above
  it. Thinking is a SUBSET of model time, so it is subordinate, never an
  addend: `model 1m 32s (40s thinking) · tools 42s · 48 tok/s` — the line's
  terms still add up to the run. The line drops `tok/s`, then the
  parenthesis, then `tools`, and is
  omitted when `modelMs` is unknown. It is whole or absent: its ladder ends in
  an empty rung, so a row too narrow for `model 1m 32s` shows a blank line,
  never a number cut by `…`. The collapsed row and its hint rule are
  unchanged. Line counts are exact (from the edit tool's patch hunks); the wording
  is "edited"/"wrote", never "changed", because edits made by shell commands
  are invisible. The cost is the status row's own run delta, so a run begun
  while toggled off records none. The renderer is registered at load — on a session switch
  Pi paints history before `session_start`, and a row that renders nothing then
  is never added — and returns `undefined` while the redesign is toggled off;
  `apply()`/`clear()` already invalidate the transcript, so rows on screen
  vanish and return with the toggle. A row Pi rebuilds while the redesign is
  off (tree navigation, compaction) has no content then and is not added to
  the chat, so it comes back only at the next rebuild — returning an empty
  component instead would leave a blank line per summary while off.
  Malformed or foreign data renders nothing.
  `PI_1337_SUMMARY=off` (config `summary:false`) writes none; entries already
  in session files stay there, inert.
- **The terminal title says what Pi is doing, and is Pi's own at rest.** While
  a run is active the title is `● Running npm test… — <session or folder>` (or
  `● Working — …`), `? Waiting for you — …` during a blocking prompt, then
  `✓ Done — …` / `✗ Failed — …` until the next message; an interrupted run and
  idle show Pi's default. While the after-run phase is `done` and pi-persona's
  `persona-background` status parses, the title is `◌ Waiting on 3 agents — …`
  instead: one kind is named, several read `Waiting on 5 background tasks`. It
  follows the status — the footer render compares the raw string and the write
  happens in the same microtask as the activity label's, with no timer — so it
  becomes `✓ Done — …` when the status clears or stops parsing, and work that
  appears while still in that phase is waited on too. A chat-only clean run
  shows it as well; `✗ Failed` never does. It is decided on events and written only when its
  string changes — except that the events that define a phase (run start, run
  end, prompt start and end) re-assert it even unchanged, because on Windows
  Pi's own startup refresh can overwrite a run title; the activity label, which appears after its grace period, is
  detected in the footer render by a string comparison and written from a
  microtask — the render path never calls `setTitle`. Pi rewrites its own
  title before extensions see `session_info_changed`, so ours is re-applied
  there. The default is rebuilt as `π - <session> - <folder>` because the host
  does not export its title constant; `clear()` restores it once, before the
  TUI handle is dropped, if ours is showing. `PI_1337_TITLE=off` (config
  `title:false`) never calls `setTitle`.
- **Persona coupling is read-only.** The persona label comes from
  `footerData.getExtensionStatuses().get("persona")` and leftover
  background-leg cost (spend not yet on a `toolResult`) from
  `…get("persona-cost")`. Both are read through the empty-footer factory; this
  extension only reads them, pi-persona owns them. Background work is
  deliberately not shown on the row: pi-persona's own widget and messages
  carry it, and a partial count beside the cost read as part of the cost.
  `…get("persona-background")` is read too, for the end-of-run summary (once,
  at `agent_settled`) and the terminal title (in the `done` phase) only —
  still nothing on the status row. `parseBackgroundStatus` (`format.ts`)
  accepts only `kind=count` pairs separated by exactly one space, the keys
  `agents monitors timers scripts` each at most once and in that order, counts
  1–9999 with no leading zero, sign or decimal, and rejects input over 64
  characters unscanned. Anything else means no background work, and only the
  parsed numbers are ever displayed, never the status text. No status, or one
  that does not parse, gives the behaviour without pi-persona.
  Nothing here may depend on pi-persona being installed.
- **Theme contract.** All thirteen `themes/*.json` define the same 51 tokens;
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
npm run preview -- --all   # eyeball tool rows, a folded run and the status row in every palette
pi -e .   # manual: narrow/wide widths (frame centers, never overflows),
          # type while streaming (cursor + spinner), /theme-1337 restores default chrome
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
