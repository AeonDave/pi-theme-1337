# Palette design

All eight names remain available because Pi settings may persist a selected theme. The shared 51-token contract is built around deep, family-specific surfaces and vivid phosphor/neon body colors—not desaturated comfort tones. Each family has a chromatic body tier, a more vivid accent, and darker/less prominent dim and muted tiers. Tool output remains legible body text; it does not inherit metadata dimness. Semantic warning, success, and error hues remain distinct. No palette ships images.

## Palette anchors

| Theme | Void / panel / selection | Body / accent | Success / error / warning / highlight |
|---|---|---|---|
| `1337` | `#04140b` / `#0b2614` / `#123a22` | `#73ec99` / `#a3ffc0` | `#4bd878` / `#ff9c78` / `#ffe55c` / `#c6ffd5` |
| `1337-amber` | `#171009` / `#281d11` / `#3b2d19` | `#ffbd68` / `#ffdda0` | `#a6df62` / `#ff765e` / `#ffeb3b` / `#fff0c5` |
| `1337-ice` | `#0b151d` / `#142630` / `#263b47` | `#9de4ff` / `#aff5ff` | `#71e8c0` / `#ff8c9c` / `#ffe36d` / `#d8f8ff` |
| `1337-cyber` | `#0b1022` / `#161e38` / `#263452` | `#9fbaff` / `#6ee7ff` | `#75e6b6` / `#ff718f` / `#ffe36d` / `#dce4ff` |
| `1337-neon` | `#170f21` / `#291b39` / `#3d2c50` | `#e5a2ff` / `#ff7ee7` | `#6bdf9a` / `#ff668f` / `#ffe36d` / `#ffe0ff` |
| `1337-split` | `#091610` / `#14271d` / `#283345` | `#80e2a4` / `#ee9cff` | `#5cdb83` / `#ff718f` / `#ffe36d` / `#d5ffe2` |
| `1337-fallout` | `#111608` / `#202a12` / `#303d1d` | `#c8f96c` / `#e7ff72` | `#90d83e` / `#ff9a4d` / `#ffdc35` / `#f2ffd0` |
| `1337-skynet` | `#0c0304` / `#241216` / `#3a2025` | `#ff9292` / `#ff5f75` | `#ffad61` / `#ffb3bd` / `#ffe36d` / `#ffd0d0` |

Secondary foregrounds retain hue while stepping down in prominence: for example,
the green flagship uses bright body `#73ec99`, dim `#55b874`, muted `#72d18f`, and
mint highlight `#c6ffd5`. Dark panels and selection surfaces support readable
foregrounds without turning body copy white. The palette families stay intentionally
distinct: ice is cyan rather than gray, cyber is blue-indigo/cyan/lavender, neon
is violet/pink, split combines green/orchid/cyan, and Fallout is yellow-lime
rather than emerald. Skynet keeps its near-black `#0c0304` void and separates
its vivid red active accent from a brighter rose error tier.

Syntax hues reinforce each identity rather than applying one rainbow mapping:
cyber uses lavender keywords, electric-cyan functions, and periwinkle/blue types;
neon uses violet/pink and cyan; split pairs orchid keywords and purple functions
with cyan types and green values. Fallout uses yellow-lime/olive with amber numeric caution, while
Skynet uses red/coral/rose syntax around the alarm role. Six or more syntax colors
are required; selected related roles may share a color.

## Contrast and hierarchy

`test/theme.test.ts` measures colors against intended dark surfaces. Required floors:
7:1 for body/tool output on void and pending/success/error tool panels, and for
user/custom message text on its associated background; 4.5:1 for dim/muted on
void, panel, selection, and all tool panels; 4.5:1 for every syntax role on void
and tool panels; 4.5:1 for diff roles on their relevant surfaces; and 4.5:1 for
status roles on dark panels. The test also checks text/secondary/status contrast
against representative untinted terminal `#1e1e1e`, separation of the accent/error,
accent/warning, success/error, and warning/error pairs by at least 8 OKLab ΔE × 100,
and luminance ordering
border < dim < muted < text with the existing tier gaps. A vividness guard requires
all eight body colors to have an RGB channel range of at least 85 and HSL saturation
of at least 60%. That guard captures this project's visual direction; it is not an
accessibility standard. Contrast measurements are local to tested surfaces, not a
blanket guarantee on arbitrary terminal backgrounds. On the current eight palettes,
observed minimums are 7.93:1 for body/tool output, 8.34:1 for user/custom message
text, 4.64:1 for dim/muted, 4.67:1 for syntax, 5.90:1 for diff roles, 4.51:1
for status roles, and 5.67:1 for text/secondary/status against `#1e1e1e`.

The default `1337` stays green-dominant except for its amber/caution semantic
roles. Fallout is deliberately yellow-lime/olive rather than a second emerald
palette. Skynet remains red-family while its accent/error separation stays above
the measured minimum. No palette is renamed or removed, preserving persisted
selections.

## Inspiration references

These are color-study references, not finished terminal palettes copied verbatim:

- [Color Hunt: charcoal, cyan, and light neutral](https://colorhunt.co/palette/222831393e4600adb5eeeeee) — dark neutral structure with a crisp cyan counterpoint.
- [Coolors: navy-to-cyan sequence](https://coolors.co/palette/0b132b-1c2541-3a506b-5bc0be-6fffe9) — dark blue/cyan harmony.
- [Coolors: muted green sequence](https://coolors.co/palette/cad2c5-84a98c-52796f-354f52-2f3e46) — a reference for layered dark green neutrals, not a target for foreground saturation.
- [MyColor.Space](https://mycolor.space/) — seed-driven complementary and shade exploration; no generated specific hex value is attributed to it.
