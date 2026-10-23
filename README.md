# pi-1337

A **phosphor CRT** redesign for [Pi](https://github.com/earendil-works/pi-mono):
eight distinct dark palettes **plus** a real TUI redesign that re-houses the
editor in a centered rounded panel.

```
     ╭──────────────────────────────────────────────────────────────╮
     │ › refactor the auth module_                                ⠹ │
     │                                                              │
     │ ~/…/pi-1337 · main       12.3k · 6%       opus-4-8 · 🎯 1337 │
     ╰──────────────────────────────────────────────────────────────╯
```

The input field is **centered with side margins** (capped width on wide
terminals) and wrapped in a **continuous rounded frame**. The border is a clean
unbroken outline; the chrome lives *inside* it:

- **first row, left gutter** `›` — the prompt sigil; it flips to a gold `$`
  while the buffer starts Pi's bash mode (a leading `!`); **first row, right
  gutter** — the phosphor working spinner (the only motion), or a static `?`
  while Pi waits for your answer to an extension dialog;
- **status row** (just above the bottom edge) — the workspace **with the git
  branch and session name** (left, each omitted when absent), the token usage +
  cumulative **cost estimate** (center: used · % · ~$ — supervisor session plus sub-agent
  usage, including leftover background-leg cost from pi-persona's `persona-cost`
  status; the color escalates to warning above 70% and error above 90%,
  auto-compact territory). `~$` is an API-equivalent estimate, **not an invoice**:
  it includes subscription usage and stays visible across model/provider changes.
  Pi's separate usage entries, compaction, and branch-summary usage are included.
  The right side shows the live sub-agent count + the **provider/model
  slug** (`anthropic/opus-4-6` — never confuse a native model with the same id
  routed elsewhere) + active **persona** (right).

The status row follows the active palette: workspace/persona in readable text,
branch/model in accent, provider/separators dimmed, session/cost muted. A static
five-cell context gauge (`[▰▰▱▱▱]`) appears when the interior is at least 90 columns
and every full label still fits; it never takes room away from metadata. Filled
cells and numeric context turn warning above 70% and error above 90%, while the
`~$` estimate stays neutral. Unknown context has no gauge.

On a narrow terminal the status row **degrades gracefully** instead of clipping:
branch/session details yield first, followed by path ancestors; the repository
name stays identifiable before optional provider detail returns. `…` marks
truncation. When space is still too tight, the centered
usage drops, the provider prefix hides, then the model id trims with `…`;
at the tightest widths only the workspace path (left)
and the persona (right) remain — or, with no persona active, the model keeps
trimming. The frame never overflows or misaligns at any width.

Everything else the default chrome shows — footer token stats, the spinner
row — is gone, while Pi's own communication channels (notify toasts in the
chat log, retry countdowns, compaction indicators, extension widgets and
dialogs) render outside the footer and are untouched.

## Compact tool views

The redesign also gives the transcript a Claude Code-style presentation, with
compact `●` tool headers instead of large default boxes. Successful shell,
read and search/list calls collapse to a header with an expansion hint; other
unrendered tools get short output previews. Edit diffs use aligned line-number
and `+`/`−` gutters, theme-colored addition/removal bands, bold changed spans,
and Pi's theme-aware syntax highlighting for context lines. Errors remain
visible when collapsed; expand a tool to inspect its complete arguments and
available output. Edit previews use the tool's recorded diff, while write previews show the submitted
file content—not a fabricated before/after diff.

This is an original implementation inspired by the visual direction of
[pi-polish](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-polish)
and [pi-context-bar](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-context-bar),
adapted to 1337's palettes and inside-frame status row. It does not install those
packages, change tool execution or prompts, or patch Pi's prototypes. Tools with
their own custom renderer (such as pi-persona's delegation tools) keep it; standard
file/shell tools and otherwise unrendered tools get the compact presentation.

Tool views follow `/pi-1337`. To keep the editor redesign but use the host tool
views, set `PI_1337_POLISH=off` or `"polish": false` in the config file, then
`/reload`. Pi caches each transcript row's renderer, so toggling uses a stable
adapter that recomposes the original renderers and their box rather than
unregistering them. HTML exports also use the selected presentation for tools
routed through extension renderers; some built-ins use Pi's separate HTML
templates. Pi exposes no separate export-mode flag to tool renderers.

## The look

Eight distinct dark palettes share the same 51-token contract and vivid phosphor/neon identities. Saturated body colors remain clearly chromatic; dim and muted text form lower, distinct tiers, while tool output stays readable as content rather than receding like metadata. Warning, error, and success use separate semantic hues, with dark panels preserving contrast rather than whitening foregrounds.

| Theme | Palette identity and visual hierarchy |
|-------|----------------------------------------|
| `1337` *(default)* | True green phosphor (`#73ec99`) on preserved void `#04140b`, with vivid mint accent and amber warning. |
| `1337-amber` | Bright amber phosphor (`#ffbd68`) with cream-gold accent, yellow warning, green success, and coral error. |
| `1337-ice` | Icy cyan-blue (`#9de4ff`) with a brighter cyan accent—not gray-blue. |
| `1337-cyber` | Indigo surfaces, periwinkle body (`#9fbaff`), electric-cyan accent, and lavender keywords. |
| `1337-neon` | Vivid synthwave violet (`#e5a2ff`) with hot-pink accent, cyan syntax, and plum surfaces. |
| `1337-split` | Green phosphor (`#80e2a4`) with orchid accent, purple functions, and cyan types. |
| `1337-fallout` | Bright yellow-lime (`#c8f96c`) with a distinct highlighter-lime accent, not another emerald. |
| `1337-skynet` | Vivid red body (`#ff9292`) on preserved void `#0c0304`; hot-rose palette accent, crimson `#d51f2a` pyramid loader, and distinct pale-red error. |

Theme tests enforce minimum 7:1 for body/tool output and user/custom message text
on their corresponding content surfaces, and 4.5:1 for secondary, syntax, status,
and diff roles on their intended dark panels. These are measured against palette
surfaces, not a claim that every role is accessible on every terminal background.
The syntax contract requires six or more distinct colors and explicit separation
between keywords/types, functions/variables, and strings/comments; a few related
roles may intentionally share a color. See [palette design and measurements](docs/palette-design.md)
for rationale, reference links, and test thresholds.

### Theme-driven extras (`.pi1337` sidecar)

Pi's published theme schema allows only color/theme fields at the JSON
root. Keep extra configuration next to the palette instead. All eight bundled
`.pi1337` sidecars define text spinner profiles; Skynet uses an explicitly crimson
loader color, while other profiles use their active palette accent. Fallout and
Skynet additionally opt into the optional background tint. Bundled sidecars
configure no avatars. See [theme motion](docs/theme-motion.md) for row geometry,
color validation, and the compact autocomplete fallback.
A user-owned sidecar can opt into an avatar (JSON content, non-`.json` extension
so Pi does not discover it as another theme):

```jsonc
{
  "background": "on", // tint the terminal window to the palette's void (env PI_1337_BG overrides)
  "avatar": {          // optional, user-owned ASCII frames; omitted by bundled palettes
    "idle": ["[ ready ]"],
    "working": ["[ thinking ]"]
  }
}
```

Avatar rendering is opt-in through a user's own theme sidecar or legacy theme
configuration; bundled palettes ship no mascot images or avatar frames. Custom
image paths (where supported) resolve relative to the **theme file's directory**.
Older custom themes with a root `pi1337` block continue to work when no sidecar
is present, but their editor may flag that legacy key under Pi's current strict
published schema. Switching themes in `/settings` reloads the matching sidecar;
after editing a sidecar in place, use `/reload` (Pi does not emit a theme-change
event for sidecar edits).

A configured avatar is a widget below the editor by default that swaps frame with the **task state**:
`idle` (startup / at rest) → `working` (model generating) → `confused` (context
compaction) → `error` (a tool or compaction failed, shown once work settles).
During an agent run the spinner stays active through automatic retries and continuations, stopping
only when Pi emits `agent_settled`. Blocking dialogs pause it and show `?`;
cancelled or failed compactions cannot leave the avatar stuck in `confused`.
Every state is optional and falls back toward `idle` (`working`→`idle`,
`confused`→`working`→`idle`, `error`→`idle`), so one frame is enough; a bare
value (`"avatar": "x.png"`) pins the same frame everywhere.

Each custom frame can be an **image** (drawn via a supported terminal image protocol) or **ASCII** (`"idle": ["line", …]`). On terminals without image support, configured ASCII lines are used or the avatar is hidden if none are provided. If Pi's image renderer itself returns a text fallback, that text is measured and clipped before centering, so it cannot overflow the terminal. Image paths are absolute or relative to the theme file. Add `"align":
"center"` to the avatar object to center it over the terminal width (default
left), and `"placement": "aboveEditor"` to move it above the input (default
`belowEditor`). It sits **below** the editor by default because a kitty-image
widget placed above the input disturbs the box's redraw beneath it (reserved
image rows + cursor math) — below the editor it renders after the box, clear of
the todos widget (which defaults above the editor). Bundled `fallout` and
`skynet` sidecars enable only background tint; they do not configure avatars.
Any configured custom widget and background tint are fully removed on `/pi-1337`
off and shutdown.

## Install & use

```bash
pi install git:github.com/AeonDave/pi-theme-1337
pi install .      # from a local clone
pi list
```

- The default green theme is applied and the editor is reframed on start.
- `/pi-1337` — toggle the whole redesign off/on (restores the default theme,
  editor, footer, and working row). The toggle is per session instance: starting,
  resuming, forking, or reloading a session returns to the default-on redesign.
- `alt+c` (configurable) — copy the input buffer as clean text: the logical
  buffer only, without the frame's `│`, margins, or per-row newlines that a raw
  terminal selection would drag along.
- **Switch palettes** any time via `/settings` — all eight are registered
  (`1337`, `1337-amber`, `1337-ice`, `1337-cyber`, `1337-neon`, `1337-split`,
  `1337-fallout`, `1337-skynet`),
  and your pick **persists across restarts** (a bundled palette found at startup
  is respected, never reset to the default). `PI_1337_THEME=amber` (or `ice` /
  `cyber` / `neon` / `split` / `green`) pins a palette explicitly and wins over
  the persisted choice; the reframe stays the same either way.

> [!TIP]
> **Load pi-1337 early.** Extensions' `session_start` handlers run sequentially in
> load order. If a slow extension is bound first (e.g. one connecting several MCP
> servers), the redesign only applies once that handler finishes — so you briefly
> see the default chrome on startup. Ordering pi-1337 **ahead of** slow extensions
> makes the framed UI appear immediately.

## With pi-persona

The frame reads the `persona` status published by **pi-persona** — so when you
switch supervisor persona (`f8` / `/persona`), its label appears on the status
row next to the model, with **no extra wiring**. The live sub-agent count on the
status row prefers pi-persona's published `persona-agents` status when present
(its numeric running-agent count, which also covers strategy/council cores), and
otherwise falls back to a live count derived from pi-persona's `delegate` tool.
Neither extension requires the other; if no persona is active, that slot is simply omitted.

## Configuration

Settings resolve **env var → `<agent-dir>/1337-theme/config.json` → built-in default**. The env var always wins, so a shell export overrides the file for one run while the file persists your standing choice.

`config.json` lives at `~/.pi/agent/1337-theme/config.json` (honoring `PI_CODING_AGENT_DIR`), namespaced like every other Pi extension's state (`claude-native/`, `persona/`, `skill-optimizer/`). Use the same lowercase key as the env var:

```json
{
  "theme": "cyber",
  "copyKey": "alt+c"
}
```

A missing, malformed, or wrongly-typed `config.json` is ignored and the defaults apply — a broken file never stops Pi from starting. `PI_1337_STATE_DIR` overrides the directory.

| Env var | Config key | Default | Purpose |
|---------|-----------|---------|---------|
| `PI_1337_DISABLE` | `disable` | _(off)_ | Any non-empty value disables the extension entirely. |
| `PI_1337_POLISH` | `polish` | `on` / `true` | Compact tool rows and diff previews. Env `off` or config `false` keeps the host views; env `on` explicitly enables them. |
| `PI_1337_THEME` | `theme` | `on` | `off` keeps your current theme (redesign only); `green`/`amber`/`ice`/`cyber` (or `blue`)/`neon`/`split`/`fallout`/`skynet` (or a full id like `1337-ice`) pins a palette at startup, overriding the persisted `/settings` pick. Unset/`on`: a persisted bundled palette is kept, any other theme is replaced by the default green. |
| `PI_1337_THINKING_LABEL` | `thinkingLabel` | `∴ thinking` | Label for the collapsed thinking row. |
| `PI_1337_COPY_KEY` | `copyKey` | `alt+c` | Shortcut that copies the input buffer as clean text. Set empty to disable. |
| `PI_1337_BG` | `background` | _(theme)_ | Tint the **terminal window** background (not just Pi's cells) so the empty margins around the frame match the palette. `on`/`auto` uses the active palette's `void`; a `#rrggbb`/`#rgb` value forces that color; `off` leaves the terminal untouched. **Unset defers to the theme sidecar** (`background` — `fallout`/`skynet` opt in); a set value overrides it. Applied via OSC 11, reset (OSC 111) on `/pi-1337` off or shutdown. A background **image** isn't settable from the app — that stays your terminal emulator's config. |
| `PI_1337_STATE_DIR` | — | `<agent-dir>/1337-theme` | Overrides the directory holding `config.json`. |

## How it works

All on documented Pi primitives — it's a theme **and** an advanced redesign
extension (see [Pi themes](https://pi.dev/docs/latest/themes) and the
[Pi TUI design notes](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)):

| Concern | Mechanism |
|---------|-----------|
| Phosphor palettes | `themes/*.json` (all eight registered via `pi.themes`), applied with `ctx.ui.setTheme(...)` — the default resolved from `PI_1337_THEME`; [spinner motion profiles](docs/theme-motion.md) are documented separately |
| Framed, centered editor | `ctx.ui.setEditorComponent` → a `CustomEditor` subclass that renders the real editor at a reduced width, then wraps it in a rounded panel with margins; spinner-only redraws and unhandled mouse drags reuse the base editor layout until editing, a handled mouse event, resize, or autocomplete changes it |
| Status on the frame | lifecycle events snapshot `ctx.getContextUsage()` plus session name/cost outside the render path; the editor combines those snapshots with `ctx.cwd`, `ctx.model`, the live subagent count, `footerData.getGitBranch()` (re-rendered via `onBranchChange`), and the published persona status. All foreign inline labels are terminal-control/bidi sanitized before framing. |
| Compact tools and diffs | `pi.registerToolRenderer` with a stable self-rendered adapter; original callbacks are recomposed on disable, and existing rows are invalidated on toggles. Execution, arguments, results and custom third-party renderers stay unchanged. |
| Clean-copy shortcut | `ctx.ui` `registerShortcut` + `copyToClipboard(editor.getText())` — copies the logical buffer, bypassing the rendered frame glyphs |
| Hide the footer & spinner row | `ctx.ui.setFooter(() => emptyComponent)` + `ctx.ui.setWorkingVisible(false)` — activity moves into the frame spinner |
| Out-of-band stderr resilience | while the frame is active, a reversible pass-through guard observes raw stderr writes from other extensions, leaves their bytes untouched, and schedules one `tui.requestRender(true)` per short (16 ms) burst so Pi resynchronizes its cached rows/cursor without a repaint storm |
| Restore everything | `/pi-1337` off / shutdown → every primitive set back to default |

The editor subclass only changes presentation: all editing, autocomplete, and
keybindings stay the base `CustomEditor`'s, while transparent cache-invalidation
hooks forward input/text/padding (and mouse events) to that base. Autocomplete
appears below the box at the base editor's original mouse row indices; the
status row temporarily hides while suggestions are open. Because Pi draws the cursor *inline*
(as text, not a coordinate), shifting every row by the same left margin **and**
fixed-width prompt gutter keeps it correct. TUI-only: in `rpc`/`json`/`print`
modes it is a no-op.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test          # render, lifecycle-contract, palette, and Pi-component tests
```

`frame.ts`, `format.ts`, `subagents.ts`, `avatar.ts`, `background.ts`,
`redraw-guard.ts`, `tool-view.ts`, `tool-adapter.ts`, and `width.ts` are dependency-free, so they unit-test with nothing but
`tsx`; `editor.ts` / `index.ts` are the thin Pi wiring. Column measurement is the
one thing not reimplemented: `index.ts` installs pi-tui's own `visibleWidth` /
`truncateToWidth` via `useTerminalMetrics()`, so the frame is laid out with
exactly the ruler the renderer paints with — on whichever pi-tui version you are
running (`width.ts` keeps a mirror only as the fallback the tests use).
`npm run test:parity` proves it end to end; point `PI_TUI` at your installed
bundle. See [AGENTS.md](AGENTS.md).

Targets the **latest installed Pi release** and **Node >=22.19.0**; development
pins for `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` stay
matched to that installed release. The Pi core peer ranges remain `"*"`, as
required by Pi's package contract (they do not promise compatibility with older
hosts). Tests cover lifecycle state, long status labels, mouse-cache reuse,
cost accounting, image fallbacks, and palette contrast. The separate parity
sweep checks the frame against the installed host renderer.

## License

MIT
