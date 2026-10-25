# Changelog

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
