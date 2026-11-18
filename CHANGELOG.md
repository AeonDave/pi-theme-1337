# Changelog

## [0.5.1] - 2026-11-18

- Publish to npm as `@aeondave/pi-theme-1337`: install with
  `pi install npm:@aeondave/pi-theme-1337`. The Git source keeps working.
- Replace the banner with real Pi sessions in three palettes above a strip of all thirteen, and add
  an animation that shows one session in every palette. The README opens with install and a short
  summary; the full feature list is one click away.
- `npm run test:parity` measures against the installed development `pi-tui` by default instead of
  needing a `../pi` checkout, which failed outright when that checkout had no dependencies.
- Run typecheck, tests, the parity sweep and the dependency audit in CI on Linux, macOS and
  Windows, with Dependabot keeping the two Pi development packages aligned.

## [0.5.0] - 2026-11-17

- Add Cosmos (`1337-cosmos`, alias `cosmos`): starlit mauve text and pastel
  syntax on indigo-black with a star-gold accent and a twinkling-star spinner,
  bringing the collection to thirteen palettes. Its colors come from
  pi-starline's Catppuccin Mocha swatches.
- Name a long-running tool in the status row: once a call has run for half a
  second, `Running npm test…` takes the workspace segment's place (` +2` when
  other calls run beside it) and leaves when the call ends. After three seconds
  it also carries the elapsed time (`Running npm test… 14s`). The right group
  never moves for it, and fast calls never flash.
  `PI_1337_ACTIVITY=off` (config `activity:false`) hides it.
- Fold settled exploration: three or more consecutive `read`/`grep`/`find`/`ls`
  rows become one tally row (`● Read 3 files, searched 2 patterns (ctrl+o to
  expand)`) as soon as the third one settles; the tally stays in place and counts
  up while the run goes on. It counts distinct files and patterns, not calls.
  Click the tally to bring
  that run back, or press the expand key to show every row. Failed calls,
  results with images, `bash`, `edit`, `write` and custom tools always keep
  their own rows, and a thinking row ends a run, so only rows that were truly
  adjacent fold. `PI_1337_GROUPS=off` (config `groups:false`) keeps one row per
  call.
- Quieter tool rows: the title leads while the duration and expand hint recede;
  durations read `4.2s` and are omitted under one second; running output drops
  its `Running:` prefix; short errors lose the lone hint line; write previews
  read `Wrote N lines` with the same number gutter as edits.
- Running and failed commands preview their newest lines instead of their
  first ones, so a long test run visibly progresses and a failure shows the
  error and exit status; earlier output is announced above them. `npm run`
  output no longer spends a preview row on its leading blank line.
- Tool rows cost what Pi's own rows cost: the row shell and its clipped lines
  are reused across frames. A 500-row session rendered a frame in 17 ms with the
  theme on and 89 ms with it toggled off; both are now about 1 ms.
- Keep Pi's theme when it is light: every bundled palette is dark, so the
  package now applies only the framed editor, status row and tool rows there.
  `PI_1337_THEME=<palette>` (or `on`) still forces a palette.
- Replace unpaired UTF-16 surrogates in labels and tool output with `U+FFFD`
  before measuring: they measured zero columns but painted one, so a row could
  run past the terminal edge.
- Qualify development dependencies and test fixtures against Pi 1.5.2, and drop
  the root `undici` override: 1.5.2 already depends on 8.12.3, which the
  override would have downgraded.
- Quiet tool rows say what they found: `· 6 matches`, `· no matches`,
  `· 12 entries`, `· 40 lines`. Read rows show their line range, multi-line
  bash commands show their first line, and a folded run names its files when
  they fit (`Read width.ts, frame.ts · searched 2 patterns`).
- Move the model identity into the top border, top-right: `provider/model ·
  level`, with a reasoning model's thinking level in the palette's thinking
  color, narrowing to `model · level` and then `model`. The bottom border stays
  plain.
- Rebuild the status row as two groups: where you are on the left, the
  session's state on the right (`[▰▱▱▱▱] 136.9k/1M · 13% · ~$48.89 +$1.24 ·
  persona`). Decorations go first (the run's spend, then the window, then the
  gauge, which no longer needs a 90-column row), then path detail, then cost
  and tokens; the
  context percentage stays to the end. It reads the same without pi-persona.
- Show the context window as a denominator (`/200k`, `/1M`) and the current
  run's spend (`+$1.24`), kept after the run settles until the next one.
- Cost fixes: `0.9996` reads `~$1.00`, a tiny positive total reads `~<$0.001`,
  and a background agent's spend that lands while Pi is idle now updates the
  row. The total itself was verified against Pi's own footer sum.
- Remove the agent count from the status row: it counted agents only, also
  queued ones, and repeated pi-persona's own widget.
- Add an end-of-run summary row: duration, files edited with exact +/− lines,
  files written, commands and failures, and the run's estimated cost. Expanded,
  it lists each file. It is stored once as a custom session entry that never
  reaches the model. `PI_1337_SUMMARY=off` (config `summary:false`) turns it off.
- Show what Pi is doing in the terminal title (a named call, working, waiting
  for you, done, failed) and return to Pi's own title at rest, on toggle-off
  and on exit. `PI_1337_TITLE=off` (config `title:false`) leaves it alone.
- Draw other extensions' tool rows in the flat frame: a tool with its own
  `renderCall` and `renderResult` now shows one status dot before its call
  lines and its result under `└`, with no background box. The lines are the
  renderer's own — never rewritten, wrapped or sanitized; one too wide is
  clipped — and its hooks still run once per update with Pi's own row state.
  `/theme-1337` off returns existing rows to Pi's box. Renderers that declare
  `renderShell: "self"` or define only one of the two hooks, results with
  images and image-protocol output stay in Pi's box, and these rows never
  fold. So does a row whose renderer returned a line that is not a string
  (`[undefined, "x"]`): Pi's box paints it as Pi always did.
- Show a running command's timeout as stock Pi does: `● $ npm test (timeout
  30s)` while the command is pending or running, as one dim rung that is the
  first to go on a narrow row and leaves with the final result. Only a
  finite, positive number of seconds Pi's shell would accept is printed.
- An empty third-party row (no line in either slot) takes no line, with the
  redesign on or off. Off, that is one blank row less than stock Pi, which
  prints a separator above its empty box; rows with blank lines or one empty
  slot match Pi exactly.
- Show a run clock in the status row: when no tool is named and the run has
  lasted three seconds, `Working… 45s` takes the workspace segment's place. It
  counts from the run's start across retries and follow-ups, hides during
  prompts and compaction, moves nothing on the right and adds no timer.
  `PI_1337_ACTIVITY=off` hides it with the tool label.
- Say when background work is still running: if pi-persona reports agents,
  monitors, timers or scripts when a run settles, the summary row reads
  `● Turn ended in 9.0s · 7 tool calls · ~$0.08 · waiting on 3 agents, 1
  monitor` with a muted dot instead of `Done`, narrowing to `waiting on 4
  background tasks`, and the terminal title reads `◌ Waiting on 3 agents — …`
  until the work ends, then `✓ Done`. Nothing about it enters the status row.
- Show where a run's time went on the expanded summary row: `model 1m 32s ·
  tools 42s · 48 tok/s`. `tools` is the run's time not spent waiting on the
  model, so it includes retry back-off, compaction and prompts. The line is
  shown whole or not at all: on a row too narrow for `model 1m 32s` it takes
  no line. Summary rows written earlier are unchanged.
- Show thinking time on the same line, as part of the model time: `model 1m
  32s (40s thinking) · tools 42s · 48 tok/s`. It is measured from the stream's
  own thinking events, shown from one second up, and goes after the rate and
  before the tools time when the row narrows.
- Fix the status row clipping the branch to a stub (`…/proj · m…`,
  `/…/src/pi-1337 · fe…`). The left group now gives up whole details: the
  session name, then the branch, then the path down to its last folder. A
  branch is shown whole or not at all; a long session name may shorten, to no
  fewer than nine characters and `…`. The activity label likewise shortens to
  no fewer than seven characters and `…`, and below that the workspace stays.
- Keep context and cost current inside a turn: when a tool call starts, the
  row shows the tokens and spend of the response that launched it instead of
  the figures from before it.
- Follow `!!` in the editor: the prompt marker stays `$` and turns dim, as Pi
  paints a command whose output is kept out of the model's context.
- Share the editor slot with other extensions: `/theme-1337` off restores an
  editor another extension had installed before this one, and leaves in place
  one installed after it. It used to reset the slot to Pi's own editor either
  way. When another extension installs its editor over the frame while the
  redesign is on, Pi's footer and working row come back, so the workspace,
  model, context, cost and spinner stay visible; the frame returns at the next
  `/theme-1337` or session start.
- Show subscription quota in the status row, between the cost and the
  persona: `5h 43% · wk 12%` (percent used of the five-hour and weekly
  windows), `wk 85%` when one window is known, `limit` once the usage limit is
  reached. The percentage warns above 70% and turns to the error color above
  90%; above 70% it stays while the row narrows, and a calm one is a
  decoration that goes after the gauge. It is read only from what the
  provider sends with a response — no request is made for it — so it appears
  after the first response and shows nothing for providers that report
  nothing. Seen on live accounts: Anthropic's subscription headers (weekly
  window) and OpenAI's usage-limit error on a ChatGPT login. Implemented from
  the published Codex client format, not yet seen live: the Codex headers and
  stream event, and Anthropic's five-hour window. `PI_1337_QUOTA=off` (config
  `quota:false`) turns it off.
- Fix a crash when expanding a built-in tool row whose arguments cannot be
  serialized (a BigInt or a circular value): the row now shows `[unavailable
  arguments]`.
- A summary row's failure count names what failed once the total is dropped
  (`1 command failed`, `2 calls failed`); a row with no commands reads
  `wrote 2 files · 1 call failed`.
- Add `PI_1337_MAX_WIDTH` (config `maxWidth`): the framed box's width cap,
  default 100, `0` or `full` for none.
- Fix workspace labels directly under home (`~/src/project`, not
  `~/…/src/project`) and reword the toggle notice to `pi-theme-1337 on/off`.
- Ship `CHANGELOG.md` in the package so Pi can show update notes.
- Add `npm run preview`, which renders a sample session and the framed editor in
  any bundled palette without launching Pi.

## [0.4.2] - 2026-11-12

- Rename the package to `pi-theme-1337` and the command to `/theme-1337`;
  remove the old `/pi-1337` command.

## [0.4.1] - 2026-11-12

- Qualify development dependencies and test fixtures against Pi 1.5.1.
- Describe the full variety of palettes in the README.
- Emphasize separate changed spans in recorded edit diffs while preserving common
  text between edits, Unicode graphemes, semantic colors and narrow-width layout.
- Pair replacements within contiguous change groups after line-number shifts;
  keep uneven, clipped or over-budget groups as full-line colored previews.

## [0.4.0] - 2026-10-25

### Themes

- Add Cyberpunk 2077: dominant neon yellow on black with azure accents.
- Add Cyberpunk 2077 Edgerunner: burgundy-black surfaces, reddish text,
  yellow titles, and cyan accents.
- Add Magma and Skynet Dark, bringing the collection to twelve palettes.
- Rename Split to Poison. Update an explicit `split` / `1337-split` setting to
  `poison` / `1337-poison`.
- Refine the default palette toward 1985 green phosphor with amber accents;
  distinguish Poison's emerald and orchid, and strengthen Cyber and Neon.
- Rework Skynet around Terminator 2's warm-white diagnostic HUD and crimson
  accents; Skynet Dark keeps the red-on-near-black direction.

### Fixes

- Preserve a bundled palette chosen through `/settings` across `/reload`, even
  when `config.json` contains an older startup theme. An explicit
  `PI_1337_THEME` palette still takes precedence.

### Documentation

- Refresh the README with a palette banner, faster setup, and a concise theme
  catalog; move configuration and architecture details into dedicated docs.
- Document palette references, contrast measurements, and motion profiles.

### Development

- Override Pi 1.4.0's Undici dependency to patched 8.12.2 in the repository's
  development install. Pi package pins stay matched at 1.4.0; this does not
  update the user's installed Pi host.

## [0.3.0] - 2026-10-23

- Target Pi 1.4.0 with compact tool views, expandable output, and theme-aware
  diff previews that preserve execution and custom renderers.
- Add distinct status-row color roles, a space-aware context gauge, and
  API-equivalent cost estimates.
- Refresh eight palettes and add validated per-theme text spinner profiles,
  including Skynet's two-row crimson pyramid.
- Remove bundled PNG avatars while retaining optional user-configured avatars.
- Improve renderer caching, toggle restoration, and HTML-export state handling.

## [0.2.0] - 2026-10-20

- Update to Pi 1.3 and improve narrow status rows, activity settlement,
  compaction recovery, usage accounting, and mouse-cache behavior.
- Correct avatar fallback geometry and raise unchanged diff-text contrast.
- Keep RPC, JSON, and print modes free of presentation side effects.

## [0.1.2] - 2026-10-02

- Update to Pi 1.0, correct autocomplete and mouse positioning, and improve
  Kitty avatar centering.
- Move theme options into `.pi1337` sidecars and add optional config-file
  settings with environment overrides.

## [0.1.1] - 2026-09-16

### Performance

- Cache unchanged editor layout during spinner-only redraws while preserving
  invalidation for input, text, padding, resize, autocomplete, and mouse input.
- Coalesce out-of-band stderr repair redraws into a bounded 16 ms frame window,
  including asynchronous write bursts.

### Documentation and tests

- Document the editor cache and redraw guard behavior.
- Add regression coverage for editor layout reuse, coordinate translation, and
  asynchronous redraw coalescing.
