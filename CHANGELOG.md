# Changelog

Notable changes to the desktop-recorder skill (editor pipeline + drivers).
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] - 2026-05-24

### Added
- **Web driver** (`scripts/drive-web.js`): drive Chrome page content over the
  DevTools Protocol (zero dependencies, Node's built-in `WebSocket`). Focus-free
  and selector-targeted; emits the same `timeline.json` as `deskagent control`,
  so record and export are unchanged. Actions: `navigate`, `wait`, `wait_for`,
  `scroll_to`, `scroll`, `scroll_page`, `click`, `move`, `pointer_down` /
  `pointer_move` / `pointer_up`, `key`, `type`; CSS-`selector` or `text` targets;
  `path` / `shape` (`circle` / `line`) trajectories. See
  `references/web-driver.md`.
- **`cursor` directive** (`hide` / `show` action ranges) to gate the synthetic
  cursor - e.g. hide it during a scroll, reveal it before the next click.
- **Trajectory cursor**: `move` / `pointer_move` with a `path` traces a polyline;
  shapes compile to a polyline (the timeline only carries points).

### Changed
- Cursor sprite and `zoom.follow_cursor` now follow a **unified pointer track**
  (clicks + moves + pointer events), not clicks alone. Per-waypoint glide: a
  click uses auto pre-arrival easing (ripple lands on a still cursor); a `move`
  glides over its `duration_ms`; a `path` interpolates linearly (constant speed).
  Ripple and pointer-hand remain click-only.
- `highlights` cursor visibility now honors `cursor.hide` / `cursor.show` on top
  of the existing pan-range hiding.

## [Prior]

- Single-pass `export.js` orchestrator over filter-fragment stages
  (`compose` / `highlights` / `zoom` / `captions` / `speedups`), background
  image/gradient + inset placement, follow-cursor and pan camera, top-level
  captions, supersample-aware sizing.
- Window-space `zoom` / `pan` centers require an explicit `windowId` in
  multi-window compositions; clarified `pan.afterMs` is video time.
