# Configuration

pi-1337 reads extension settings from environment variables and an optional JSON file. A per-theme `.pi1337` sidecar holds spinner, background, and avatar settings that do not belong in Pi's theme schema.

## Extension settings

The default file is `~/.pi/agent/1337-theme/config.json`. Pi's `PI_CODING_AGENT_DIR` changes the base directory; `PI_1337_STATE_DIR` can set the config directory directly.

```json
{
  "theme": "cyber",
  "copyKey": "alt+c",
  "polish": true,
  "background": "off"
}
```

Missing or invalid files fall back to defaults. Unknown keys and values with the wrong type are ignored. Environment values take precedence over their matching file settings.

| Environment variable | File key | Default | Behavior |
| --- | --- | --- | --- |
| `PI_1337_DISABLE` | `disable` | off | Any non-empty value disables the extension. |
| `PI_1337_POLISH` | `polish` | on | Set `off` to keep Pi's standard tool renderers; `on` enables compact tool rows and previews. |
| `PI_1337_ACTIVITY` | `activity` | on | Set `off` to stop naming long-running tools in the status row and to hide the run clock (`Working… 45s`). Read when the extension loads. |
| `PI_1337_GROUPS` | `groups` | on | Set `off` to keep one transcript row per tool call; `on` folds runs of three or more settled read/search/list rows into one tally row. Needs `PI_1337_POLISH`; read when the extension loads. |
| `PI_1337_THEME` | `theme` | on | Select a palette, use `off` to keep the current Pi theme, or leave unset to respect Pi's bundled `/settings` choice. All bundled palettes are dark: on a light Pi theme the package keeps that theme unless a palette is set here or `PI_1337_THEME` is `on`. |
| `PI_1337_COPY_KEY` | `copyKey` | `alt+c` | Set the key chord used to copy the editor's logical buffer. An empty value disables it. |
| `PI_1337_MAX_WIDTH` | `maxWidth` | 100 | Widest framed editor box in columns; `0` or `full` removes the cap. Values below 40 are raised to 40 and invalid values are ignored. Read when the extension loads. |
| `PI_1337_SUMMARY` | `summary` | on | Appends one summary row when a run that used tools, was interrupted or failed settles; `off` writes none and hides existing ones. The row is a custom session entry: it never reaches the model and stays in the session file. Read when the extension loads. |
| `PI_1337_TITLE` | `title` | on | Shows the run state in the terminal title (`● Running npm test… — repo`) and restores Pi's own title at rest; `off` never touches the title. Read when the extension loads. |
| `PI_1337_QUOTA` | `quota` | on | Shows the subscription quota the current provider reports in the status row: `5h 43% · wk 12%`, `wk 85%`, or `limit`. `off` registers no response or stream handler and leaves the row as it is. Read when the extension loads. |
| `PI_1337_THINKING_LABEL` | `thinkingLabel` | `∴ thinking` | Set the collapsed thinking label. |
| `PI_1337_BG` | `background` | theme | Set `on`/`auto` to use the palette background, `off` to leave the terminal unchanged, or a hex color such as `#101820`. |
| `PI_1337_STATE_DIR` | — | `<agent-dir>/1337-theme` | Set the directory containing `config.json`. |

### Theme selection

All thirteen palettes are available in `/settings`, and Pi persists that selection. With `PI_1337_THEME` unset, pi-1337 respects Pi's current bundled palette; a `theme` value in `config.json` seeds startup only when no bundled palette is already selected. An explicit `PI_1337_THEME` palette alias or full name pins that palette. `on` uses the current bundled choice or the default green palette; `off` leaves the current Pi theme in place while the editor redesign remains active.

Aliases include `green`, `amber`, `ice`, `cyber`/`blue`, `cyberpunk-2077`, `cyberpunk-2077-edgerunner`, `neon`, `cosmos`, `poison`, `magma`, `fallout`, `skynet`, and `skynet-dark`. Full names such as `1337-cyberpunk-2077` also work.

## Activity label and tool grouping

While Pi works, a tool call that has been running for half a second is named in the status row, in the workspace segment's place: `Running npm test…`, `Reading stats.py…`, after three seconds with the elapsed time (`Running npm test… 14s`), and with ` +2` when other calls run beside it. The right group (usage, cost, persona) never moves for it, fast calls never flash, and the workspace returns when the call ends. The label comes only from Pi's tool events and adds no timer. When no tool is named and the run has lasted three seconds, the same place shows the run clock, `Working… 45s`; it counts from the run's start, and is hidden during prompts and compaction and for a run that began while the redesign was toggled off. `PI_1337_ACTIVITY=off` (config `activity: false`) hides both.

Three or more consecutive `read`, `grep`, `find`, or `ls` rows fold into one tally row — `● Read 3 files, searched 2 patterns (ctrl+o to expand)` — as soon as the third one settles. The tally stays in place and counts up while the run goes on; a call still running keeps its own row. Anything that paints a row ends a run: `bash`, `edit`, `write`, custom tools (their rows never fold, including those drawn in the flat frame), a message, or a thinking row. Failed calls and results with image attachments always keep their own rows. The tally names its files when the whole row fits (`Read width.ts, frame.ts · searched 2 patterns`) and counts them otherwise; it counts distinct files and patterns, so paging one file three times reads `Read 1 file`. Left-clicking the tally brings that run back; the host's expand key (Ctrl+O) shows every row; history rebuilt on resume, tree navigation, or compaction stays unfolded. `PI_1337_GROUPS=off` (config `groups: false`) disables folding; it also needs `PI_1337_POLISH`, which owns the tool rows.

## Subscription quota

When the current provider reports subscription usage, the status row shows it between the cost and the persona as percent used: `5h 43% · wk 12%` (five-hour and weekly windows), `wk 85%` when only one window is known, or `limit` once the provider says the usage limit is reached. Above 70% the percentage takes the warning color and above 90% the error color; a figure not confirmed for thirty minutes turns dim while it is calm.

It is read only from what the provider already sends with a response, so it appears after the first response, never before, and the extension makes no request of its own. Seen on live accounts: Anthropic's subscription headers (the weekly window) and OpenAI's usage-limit error on a ChatGPT login. Implemented from the published Codex client format but not yet seen live: the Codex rate-limit headers and stream event, and Anthropic's five-hour window. Providers that report nothing — z.ai, OpenRouter and other pay-per-use routes — show nothing, and a generic rate-limit error is not treated as a subscription limit. The plan, the absolute limit and the time a `limit` lifts are not known.

Set `PI_1337_QUOTA=off` (or `"quota": false`) to turn it off; the row is then exactly as it is without the feature.

## Theme sidecars

For a theme file named `my-theme.json`, place optional extension settings in `my-theme.pi1337` beside it. The sidecar is JSON but uses a non-`.json` extension so Pi does not load it as another palette.

```json
{
  "spinner": {
    "frames": ["·", "•", "●", "•"],
    "intervalMs": 120
  },
  "background": "on",
  "avatar": {
    "working": ["[ thinking ]"]
  }
}
```

Every bundled palette has a spinner profile. Cyberpunk 2077, Edgerunner, Fallout, Skynet, and Skynet Dark also opt into tinting the terminal background. Bundled palettes do not configure avatars.

Selecting a different palette in `/settings` loads its sidecar. After editing a sidecar in place, use `/reload`.

### Background tint

Tint is off unless enabled by a config value or the active theme sidecar. `PI_1337_BG` or the `background` setting overrides the sidecar: `on`/`auto` uses the palette's `void` color, a valid `#rgb` or `#rrggbb` sets an explicit tint, and `off` disables tinting. The extension resets the tint when its redesign is turned off or Pi shuts down.

### Optional avatar

Avatars are user-configured widgets; none are included in the bundled palettes. Use ASCII lines or an image path in `avatar` frames. For example, the `working` frame above appears while the model is working and falls back to `idle` if configured. Paths are resolved relative to the theme file.

Avatar objects accept optional `align` (`left` or `center`) and `placement` (`belowEditor` or `aboveEditor`) settings. The default placement is below the editor. Image display depends on terminal image support; configure ASCII lines as a fallback when needed.

See [theme motion profiles](theme-motion.md) for accepted spinner frame shapes, geometry limits, and timing.
