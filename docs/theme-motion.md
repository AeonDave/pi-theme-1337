# Theme-driven text motion

Bundled themes use text spinners, not PNG mascots. Glyphs and timing come from
the adjacent `.pi1337` sidecar; color defaults to the active palette's `accent`
token, with an optional validated RGB override. There is only one animation
timer.

| Theme | Motion | Interval | Reserved cells |
|---|---|---:|---:|
| `1337` | Braille rotation | 90 ms | 1 |
| `1337-amber` | ASCII baton | 120 ms | 1 |
| `1337-ice` | Quarter circles: `◴ ◷ ◶ ◵` | 150 ms | 1 |
| `1337-cyber` | Pulse: `· • ● •` | 140 ms | 1 |
| `1337-cyberpunk-2077` | Electric ladder bars: `▁▃▅` → `▃▅▇` → `▅▇▁` → `▇▁▃` → `▅▂▆` → `▃▅▇` | 140 ms | 3 |
| `1337-cyberpunk-2077-edgerunner` | Electric ladder bars: `▁▃▅` → `▃▅▇` → `▅▇▁` → `▇▁▃` → `▅▂▆` → `▃▅▇` | 140 ms | 3 |
| `1337-neon` | Diamonds: `◇ ◈ ◆ ◈` | 160 ms | 1 |
| `1337-poison` | Half circles: `◐ ◓ ◑ ◒` | 140 ms | 1 |
| `1337-magma` | Heat bars: `▁▃▆` | 120 ms | 3 |
| `1337-fallout` | Pixel rotation: `▖ ▘ ▝ ▗` | 150 ms | 1 |
| `1337-skynet` | Pyramid: one triangle above two | 180 ms | 3 |
| `1337-skynet-dark` | Pyramid: one triangle above two | 180 ms | 3 |

Both Skynet profiles activate one triangle at a time:

```text
 ▲       △       △
△ △     ▲ △     △ ▲
```

Both Skynet profiles use the crimson `#d51f2a` pyramid; all other profiles
retain their palette's semantic accent. Cyberpunk 2077 uses a cyan-blue accent
(`#52c9ff`), and Edgerunner uses a cyan accent (`#00e6e6`). The explicit color
override belongs only to the Skynet sidecars, not either theme palette.

## Configure a profile

For `my-theme.json`, put the profile in `my-theme.pi1337`:

```json
{
  "spinner": {
    "frames": [[" ▲ ", "△ △"], [" △ ", "▲ △"], [" △ ", "△ ▲"]],
    "intervalMs": 180,
    "color": "#d51f2a"
  }
}
```

Frames may be legacy single-row strings or explicit arrays of one or two row
strings, for example `[" ▲ ", "△ △"]`. Every frame must have the same height;
each row must have the same host-measured width of 1–3 columns. Controls, bidi
characters, tabs, blank rows/frames, and unequal geometry are rejected. Raw
newlines are never accepted. Each row is limited to 256 UTF-16 code units, with
1–32 frames total. `color`, when present, must be exactly `#RRGGBB`; invalid
profiles fall back to the standard braille spinner. The interval defaults to
90 ms and must be between 60 and 500 ms.

A two-row animation reserves its indicator width plus one cell on the status
row (four cells for both Skynet profiles), even when idle or waiting. This reduces the status
layout budget without changing the input
viewport. When there is one input row and no menu, the lower art occupies the
right side of the existing status row. With at least two content rows, it uses
the second content row. Autocomplete never gains a row or changes suggestion
indices: if only one content row is available while a menu is open, the compact
fallback displays only the top triangle. Waiting displays `?` on top and clears
the bottom row. The extra reserved gutter cell can carry a down-scroll marker
beside the lower triangle.

## Layout and lifecycle

The editor reserves the profile's indicator width even while idle or waiting.
Starting or stopping motion therefore does not shift the cursor, rewrap input,
or change the mouse viewport. At extremely narrow widths, the normal bare-editor
fallback remains available.

A blocking prompt pauses motion and shows a static `?`. Manual compaction uses
the same timer. Motion stops on settlement, disable and shutdown—not merely on
`agent_end`, because retries and queued work may follow. A live theme change
resets the frame and resumes only if work is active and no prompt is blocking.

Selecting another theme through `/settings` loads its profile. After editing a
sidecar in place, use `/reload`. RPC, JSON and print modes do not start the timer.

The visual references were [Skynet Hunter](https://github.com/paullaudeman/skynet-hunter)
and the [CLI/ASCII spinner collection](https://codepen.io/moritzjacobs/pen/WXBPxO).
These profiles are an original text implementation; no upstream renderer code,
CSS animation or image assets are bundled.
