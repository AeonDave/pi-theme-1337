# Palette design

Twelve palette names are registered, and all twelve share Pi's strict 51-token contract. Eleven use vivid chromatic colors over deep, family-specific surfaces; the Terminator 2 HUD palette uses warm-white text on red-tinted black. Tool output remains legible body text, semantic status roles stay distinct, and no palette ships images.

## Palette anchors

| Theme | Void / panel / selection | Body / accent | Success / error / warning / highlight |
|---|---|---|---|
| `1337` | `#04140b` / `#0b2614` / `#123a22` | `#78ef74` / `#ffc35c` | `#4bd878` / `#ff9c78` / `#ffe55c` / `#c6ffd5` |
| `1337-amber` | `#171009` / `#281d11` / `#3b2d19` | `#ffbd68` / `#ffdda0` | `#a6df62` / `#ff765e` / `#ffeb3b` / `#fff0c5` |
| `1337-ice` | `#0b151d` / `#142630` / `#263b47` | `#9de4ff` / `#aff5ff` | `#71e8c0` / `#ff8c9c` / `#ffe36d` / `#d8f8ff` |
| `1337-cyber` | `#0b1022` / `#151c34` / `#202b43` | `#8baeff` / `#42e8ff` | `#75e6b6` / `#ff718f` / `#ffe36d` / `#dce4ff` |
| `1337-cyberpunk-2077` | `#000000` / `#111000` / `#211c00` | `#fcee0a` / `#52c9ff` | `#ffe56b` / `#ff5364` / `#ff8a00` / `#fff09a` |
| `1337-cyberpunk-2077-edgerunner` | `#100307` / `#1d0710` / `#2c0b18` | `#ff8995` / `#00e6e6` | `#ffd43b` / `#ff5368` / `#ff8c00` / `#ffe65a` |
| `1337-neon` | `#170f21` / `#291b39` / `#3d2c50` | `#e589ff` / `#ff62da` | `#6bdf9a` / `#ff759b` / `#ffe36d` / `#ffe0ff` |
| `1337-poison` | `#091610` / `#14271d` / `#302439` | `#69f29a` / `#e17bff` | `#59d98a` / `#ff718f` / `#ffe36d` / `#d5ffe2` |
| `1337-magma` | `#160d0b` / `#271711` / `#3a2319` | `#ff9876` / `#46e5df` | `#69df97` / `#ff677e` / `#ffd166` / `#ffe0c9` |
| `1337-fallout` | `#111608` / `#202a12` / `#303d1d` | `#c8f96c` / `#e7ff72` | `#90d83e` / `#ff9a4d` / `#ffdc35` / `#f2ffd0` |
| `1337-skynet` | `#0c0304` / `#25070a` / `#451016` | `#fff1ed` / `#ff5f6b` | `#ffb8b3` / `#ff8a9d` / `#ffe5df` / `#ffd3cf` |
| `1337-skynet-dark` | `#090103` / `#160406` / `#25080c` | `#ff817d` / `#ff5964` | `#ff9185` / `#ff69a4` / `#ffb5ad` / `#ffaba5` |

The default `1337` palette takes its visual direction from the green P39 phosphor and long-persistence monochrome displays of early IBM PCs. Its yellow-green body and deep green surfaces keep that CRT character; amber/gold UI accents are a deliberate design adaptation, not a claim that the original monochrome hardware displayed multiple colors. Poison remains more emerald, with orchid and cyan syntax; the identity test keeps their body and accent hues in separate families.

Cyber uses periwinkle text, electric-cyan accents, lavender keywords, and blue-indigo surfaces. The screenshots in the [Cyberpunk 2077 inspired theme post on r/S24Ultra](https://www.reddit.com/r/S24Ultra/comments/1g2krv1/cyberpunk_2077_inspired_theme/) use black fields, dominant bright yellow, and cyan-blue accents. This palette adapts that visual hierarchy with a neon-yellow body, a cyan-blue accent, and contrast-adjusted semantic roles; it is a terminal interpretation, not an exact game or phone theme reproduction.

The Edgerunner variant takes visual direction from the Blender theme [Cyberpunk2077 by mamane-kabirou](https://extensions.blender.org/themes/cyberpunk2077/). The reference screenshots combine dark burgundy-red surfaces and muted red interface text with yellow labels and cyan highlights. The terminal palette interprets those color relationships with a muted red body (`#ff8995`), yellow titles (`#ffe65a`), cyan accent (`#00e6e6`), and burgundy-black surfaces; it does not reuse the Blender theme's XML.

Neon combines violet and hot pink with cyan syntax; Fallout stays yellow-lime rather than emerald. Magma pairs molten coral-orange with cyan accents on warm charcoal. Skynet follows the Terminator 2 diagnostic view: warm-white HUD text over red-tinted black footage, with crimson accents. Skynet Dark retains a red body on near-black surfaces as a separate palette. These are color interpretations of the references, not exact scene or hardware reproductions.

## Contrast and hierarchy

`test/theme.test.ts` measures colors against intended dark surfaces. Required floors are 7:1 for body/tool output on void and pending/success/error tool panels and for user/custom message text on its associated background; 4.5:1 for dim/muted on void, panel, selection, and tool panels; 4.5:1 for syntax, diff, and status roles on their defined surfaces. The tests also enforce text/secondary/status contrast against representative untinted terminal `#1e1e1e`, separation of semantic pairs by at least 8 OKLab ΔE × 100, and luminance ordering `border < dim < muted < text` with existing tier gaps.

The eleven chromatic palettes keep an RGB channel range of at least 85 and HSL saturation of at least 60%. Skynet's warm-white body has its own HUD color checks; Skynet Dark remains covered by the red-body vividness guard. These are project identity and contrast checks, not an accessibility claim for arbitrary terminal backgrounds.

Across the twelve current palettes, the observed minimums are 7.14:1 for body/tool output (Neon), 7.14:1 for user/custom message text (Neon), 4.64:1 for dim/muted (Fallout), 5.25:1 for syntax (Edgerunner), 5.92:1 for diff roles (Cyberpunk 2077), 4.78:1 for status roles (Neon), and 4.68:1 for secondary text against untinted `#1e1e1e` (Edgerunner). Cyberpunk 2077 measures 15.19:1 for body/tool output, 16.56:1 / 15.38:1 for user/custom message text, 5.26:1 / 9.78:1 for dim/muted, 5.66:1 for syntax, 5.92:1 for diff roles, 5.42:1 for status roles, and 5.14:1 for dim text against untinted `#1e1e1e`. Edgerunner measures 8.24:1 for body/tool output, 5.05:1 / 6.58:1 for dim/muted, 5.25:1 for syntax, 5.73:1 for status roles, and 4.68:1 for dim text against untinted `#1e1e1e`. Every palette exceeds the corresponding test floor.

## Inspiration references

The palette combinations are original, informed by the references below.

- [IBM 5150 Technical Reference (August 1981), monochrome display section](https://www.minuszerodegrees.net/manuals/IBM_5150_Technical_Reference_6025005_AUG81.pdf) and the [Centre for Computing History's IBM 5151 display entry](https://www.computinghistory.org.uk/det/39463/IBM-5151-Personal-Computer-Display/) describe the period's persistent green monochrome CRT direction behind the default palette.
- The [Cyberpunk 2077 inspired theme post on r/S24Ultra](https://www.reddit.com/r/S24Ultra/comments/1g2krv1/cyberpunk_2077_inspired_theme/) is the visual reference for black fields, dominant yellow, and cyan-blue accents. This is a community phone-theme interpretation, not an official Cyberpunk 2077 color specification.
- The [Cyberpunk2077 theme for Blender by mamane-kabirou](https://extensions.blender.org/themes/cyberpunk2077/) informs the Edgerunner variant's burgundy-red, yellow, and cyan hierarchy; only the visual direction is reused, not its XML theme code.
- The Skynet HUD interpretation references a [Terminator 2 still and discussion of the T-800 HUD](https://scifi.stackexchange.com/questions/68511/why-does-the-terminator-t-800-have-a-hud) and a [production-effects account of the film's black/white/red image process](https://www.sideshow.com/blog/how-terminator-2-achieved-iconic-special-effects). These guide the warm-white diagnostic text and red-tinted-black surfaces; no specific scene is reproduced exactly.
- [Color Hunt's neon black/purple palettes](https://colorhunt.co/palettes/neon-black-purple) and [SchemeColor's dark cyan/orange palette](https://www.schemecolor.com/dark-cyan-and-orange.php) informed Neon and Magma color studies.
- [Color Hunt: charcoal, cyan, and light neutral](https://colorhunt.co/palette/222831393e4600adb5eeeeee) and [Coolors: navy-to-cyan sequence](https://coolors.co/palette/0b132b-1c2541-3a506b-5bc0be-6fffe9) are harmony references for dark structure with crisp cyan counterpoints.
- [Coolors: muted green sequence](https://coolors.co/palette/cad2c5-84a98c-52796f-354f52-2f3e46) informs layered green surfaces, not foreground saturation; [MyColor.Space](https://mycolor.space/) is a seed-driven complementary/shade exploration tool.
