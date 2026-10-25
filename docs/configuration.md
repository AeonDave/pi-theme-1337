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
| `PI_1337_THEME` | `theme` | on | Select a palette, use `off` to keep the current Pi theme, or leave unset to respect Pi's bundled `/settings` choice. |
| `PI_1337_COPY_KEY` | `copyKey` | `alt+c` | Set the key chord used to copy the editor's logical buffer. An empty value disables it. |
| `PI_1337_THINKING_LABEL` | `thinkingLabel` | `∴ thinking` | Set the collapsed thinking label. |
| `PI_1337_BG` | `background` | theme | Set `on`/`auto` to use the palette background, `off` to leave the terminal unchanged, or a hex color such as `#101820`. |
| `PI_1337_STATE_DIR` | — | `<agent-dir>/1337-theme` | Set the directory containing `config.json`. |

### Theme selection

All twelve palettes are available in `/settings`, and Pi persists that selection. With `PI_1337_THEME` unset, pi-1337 respects Pi's current bundled palette; a `theme` value in `config.json` seeds startup only when no bundled palette is already selected. An explicit `PI_1337_THEME` palette alias or full name pins that palette. `on` uses the current bundled choice or the default green palette; `off` leaves the current Pi theme in place while the editor redesign remains active.

Aliases include `green`, `amber`, `ice`, `cyber`/`blue`, `cyberpunk-2077`, `cyberpunk-2077-edgerunner`, `neon`, `poison`, `magma`, `fallout`, `skynet`, and `skynet-dark`. Full names such as `1337-cyberpunk-2077` also work.

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
