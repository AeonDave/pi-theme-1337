# Changelog

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
