# Screenplay format

The screenplay is the single source of truth for a demo: scenes of
actions to execute, plus top-level editing directives (`zoom`, `speed`,
`trim`) and per-scene `caption`. `deskagent control` reads only
`scenes[].actions[]`; the editing scripts read everything.

See [`deskagent.md`](./deskagent.md) for the CLI,
[`timeline.md`](./timeline.md) for the execution-event schema,
[`editing.md`](./editing.md) for the editing pipeline.

## Top-level shape

```json
{
  "schema_version": 2,
  "name": "demo1",
  "coordinate_space": "window",
  "timeout_ms": 30000,
  "sample_mouse_ms": 16,

  "scenes": [ /* ... */ ],

  "composition": { /* canvas + per-clip placement; see below */ },

  "zoom":       [ /* directive entries; see below */ ],
  "speed":      [ /* directive entries; see below */ ],
  "captions":   [ /* directive entries; see below */ ],
  "highlights": { /* cursor + ripple overrides; see below */ },

  "trim": { "beforeScene": "<sceneId>", "afterScene": "<sceneId>" }
}
```

| Field | Required | Purpose |
|---|---|---|
| `schema_version` | yes | Currently `2`. Wrong value - hard error. |
| `coordinate_space` | no (`screen`) | `"window"` resolves x/y against the executor's window origin - recommended. |
| `timeout_ms` | no | Total budget for the run; override at CLI with `--timeout-ms`. |
| `sample_mouse_ms` | no | Mouse-path sampling cadence (HID-mode demos). |
| `scenes` | yes | Ordered execution units. May carry per-scene `windowId` to route action coords to the correct window in multi-window compositions. |
| `composition` | conditional | Required for multi-clip recordings. Drives `scripts/stages/compose.js` (canvas size, background, per-clip placement, optional auto-layout). Single-clip recordings may omit it. |
| `zoom` | no | Array of zoom directive entries. Each entry's `fromAction`/`toAction` is a global ref - ranges may cross scenes. |
| `speed` | no | Array of speed directive entries. Same global-ref shape; ranges may cross scenes but not overlap each other. |
| `captions` | no | Array of caption directive entries, drawn at the bottom of the canvas in a single strip. Same global-ref shape; entries may not overlap in time. |
| `highlights` | no | Override block for cursor sprites + click-ripple. Without it, defaults apply (macOS system cursor sprites + procedural soft expanding ring). |
| `trim` | no | Scene IDs that bound the final video. Defaults: first scene, last scene + 600 ms pad. |

### Action IDs are global

Every action gets a global ID `<sceneId>/<actionIndex>` in the timeline.
The directives reference these IDs directly - they're not scoped to any
scene. `"open_settings/0"` works just as well from a `zoom` entry as
from a `speed` entry, and a single entry can span from one scene's
action to a later scene's action.

## Scenes

```jsonc
{
  "id": "open_settings",            // unique within the screenplay
  "caption": "Open Settings",       // viewer-facing; spans the whole scene
  "note":    "verify panel state",  // author/debug only; never rendered

  "actions": [
    { "action": "click", "x": 244.5, "y": 54.5 },
    { "action": "wait",  "ms": 600 }
  ]
}
```

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Canonical scene reference. Used in `actionId = "<sceneId>/<index>"` and `trim.*Scene`. |
| `windowId` | no | When set, action coords in this scene are mapped to this window's placement on the canvas (compose's `pointToCanvasPixel`). Required if the recording has multiple windows. |
| `note` | no | Skipped by every consumer. |
| `actions` | yes | One or more `Action` records executed in order. |

(`caption` on scenes is **no longer consumed** - captions are a top-level
directive array, see below.)

Scenes no longer carry `zoom` or `speed` fields. Camera and tempo are
timeline-wide concerns and live at the top level.

## Actions (execution-only)

```jsonc
{ "action": "wait",         "ms": 500 }
{ "action": "move",         "x": 1, "y": 2, "duration_ms": 250 }
{ "action": "click",        "x": 10, "y": 20, "button": "left" }   // button: left | right | middle
{ "action": "double_click", "x": 30, "y": 40 }
{ "action": "drag",         "x": 0, "y": 0, "to_x": 100, "to_y": 200, "button": "left" }  // button optional, default left
{ "action": "type",         "text": "hello", "cpm": 300 }
{ "action": "key",          "combo": "cmd+s" }                      // keys incl. f1-f12, home, end, pageup, pagedown, arrows
{ "action": "scroll",       "dx": 0, "dy": -3 }

// Trajectory move + pointer primitives (draw shapes / compose gestures):
{ "action": "move", "path": [ {"x":110,"y":130}, {"x":400,"y":130} ], "duration_ms": 600 }   // glide along a polyline
{ "action": "pointer_down", "x": 110, "y": 130 }                    // press + hold (button optional, default left)
{ "action": "pointer_move", "path": [ ... ], "duration_ms": 800 }   // move while held = a drawn stroke
{ "action": "pointer_up" }                                          // release (defaults to current position)
```

`move` glides over `duration_ms`; with a `path` it traces that polyline
(constant speed). `pointer_down` → `pointer_move(path)` → `pointer_up` is one
continuous stroke - use it to draw lines/circles/bezier (sample the curve into
a `path`). `drag` is the straight-line shorthand. `click`/`double_click`/`drag`
take `button`: `left`/`right`/`middle`.

These run identically in native `deskagent control` (CGEvent) and the **web
driver** (`scripts/drive-web.js`, CDP). The web driver adds page-only actions
(`navigate`, `wait_for`, `scroll_to`, `scroll_page`, selector/`text` targets,
`shape` sugar) - see [`web-driver.md`](./web-driver.md).

No `intent` / `caption` / `zoom` fields on actions - those live higher
up. Action records are pure execution.

`coordinate_space` is screenplay-wide (`"window"` or `"screen"`); the
executor adds the resolved window origin at runtime for `"window"`.

## Composition

`composition` drives `scripts/stages/compose.js` - the first editing stage. It maps each
clip in `recording.manifest.json` to a rect on a shared canvas. Required
when the recording has 2+ clips; optional for single-clip recordings (the
clip then fills its native pixel size).

```jsonc
"composition": {
  "canvas":     [1920, 1080],          // [W, H] in pixels; required for 2+ clips
  "background": "color:1a1a2e",        // optional; "none" | "dark" | "light" | "color:RRGGBB" | "image:/path/to/bg.png"
  "layout":     "side-by-side",        // optional; auto-computes slot rects (see below)
  "padding":    60,                    // optional; canvas-pixel gap when layout is set
  "elements": [
    { "windowId":  12345 },                              // auto rect from layout
    { "windowId":  67890, "weight": 2 },                 // wider slot in side-by-side / taller in stack
    { "displayId": 1,     "rect": [0, 0, 1920, 1080] }   // explicit rect overrides layout
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `canvas` | conditional | Required when `composition` is present and there are 2+ clips. `[W, H]` in pixels. |
| `background` | no (default `none` = black) | `none` (opaque black) · `dark` / `light` (subtle vertical gradients, cached to `~/.cache/deskagent-skill/`) · `color:RRGGBB` (solid hex fill) · `image:/path/to/bg.png` (scale-and-crop to cover the canvas). |
| `layout` | no | When set, slot rects are auto-computed and you can omit `rect` per element. See layout modes below. |
| `padding` | no (default `60`) | Canvas-pixel gap around and between slots. Only used when `layout` is set. |
| `upscale` | no (default `false`) | When `false`, a clip smaller than its slot sits at native pixel size centered in the slot (no scaling). When `true`, clips are aspect-fit to fill the slot (may upscale, can look soft). |
| `elements` | yes | Array of clip placements. Each entry references a clip via `windowId` or `displayId` (matched against the manifest). An explicit `rect` always wins over the layout-computed slot. Order matters - slots are filled in element order. |
| `elements[i].rect` | conditional | `[x, y, w, h]` in canvas pixels. Required if `layout` is omitted; otherwise optional override. |
| `elements[i].weight` | no (default `1`) | Proportional slot size; honored by `side-by-side` (column widths) and `stack` (row heights). |
| `elements[i].upscale` | no | Per-element override of `composition.upscale`. |

Inside whichever slot it lands in, the clip is **aspect-fitted** (letter-/pillarboxed, centered) - never stretched.

### Layout modes

| `layout` | Slots |
|---|---|
| `auto` | 1 clip = full canvas (no padding). 2 = `side-by-side`. 3+ = `grid`. |
| `side-by-side` | A row of N slots; element `weight` controls column widths. |
| `stack` | A column of N slots; element `weight` controls row heights. |
| `grid` | 2-column grid, `ceil(N/2)` rows. (3 clips → 2×2 with one empty cell.) |

Mixed mode is fine: set `layout: "side-by-side"`, give one element an explicit `rect`, and the rest fill the auto-computed slots in element order.

## Editing directives

### Half-open ranges

Every directive entry takes a `fromAction` / `toAction` pair. The range
is **half-open**: it starts at `fromAction.tStart` and ends at
`toAction.tStart` (toAction is excluded). To extend a range "through"
some action, point `toAction` at the next action after it.

### `zoom`

```jsonc
"zoom": [
  {
    "scale":         2.0,                  // > 1; required
    "follow_cursor": false,                // optional; default false
    "x": 244.5, "y": 54.5,                 // optional center; also the implicit "afterMs=0" waypoint for pan
    "coordinate_space": "window",          // optional; defaults to top-level
    "windowId":     12345,                 // required for window-space centers in multi-window comps

    "fromAction":   "open_settings/0",     // required, global ref
    "toAction":     "save/0",              // required, half-open
    "startDelayMs": 0,                     // optional; offsets fromAction time
    "endDelayMs":   0,                     // optional; offsets toAction time

    "pan": [                               // optional; mutually exclusive with follow_cursor
      { "afterMs": 1200, "x": 800, "y": 400, "ease": "in_out" },
      { "afterMs": 4000, "x": 200, "y": 150 }
    ]
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `scale` | yes | Numeric zoom factor, must be `> 1`. |
| `fromAction` | yes | Action ID `"sceneId/index"`. Resolves globally - need not be in the same scene as `toAction`. |
| `toAction` | yes | Action ID. Excluded from the range. |
| `follow_cursor` | no | If `true`, camera centers on the **synthetic cursor's piecewise-eased path** (the same expression the highlights stage uses for the sprite - no desync). Requires at least one click event inside the range. Mutually exclusive with `pan`. |
| `x`, `y` | no | Static center. Also serves as the implicit "afterMs=0" waypoint when `pan` is used. Without it, the first action with `x`/`y` inside the range is used. Pure-`wait` ranges need an explicit `x`/`y` (or `follow_cursor: true`). |
| `coordinate_space` | no | `"window"` or `"screen"`. Defaults to the top-level setting. |
| `windowId` | conditional | Names the window a window-space center resolves against. **Required** when the center is window-space and the comp has >1 window; the whole entry (static/start center *and* every pan waypoint) resolves in that window's space. A directive is not scene-bound, so the scene's `windowId` is **not** consulted - this is the only lever. Omitting it in a multi-window comp is a hard error. `follow_cursor` and the first-action-in-range fallback are exempt (they resolve real actions). To pan across windows, use `coordinate_space: "screen"`. |
| `startDelayMs` / `endDelayMs` | no | Signed ms offsets on the start/end. Default `0`. |
| `pan` | no | Array of waypoints `{ afterMs, x, y, ease? }`. See below. |

Implementation: per-frame `scale=...:eval=frame` then bounded `crop` on
the canvas. Linear ramp-in / ramp-out at segment edges (RAMP = 0.2 s,
auto-clamped to half the segment length so short segments still get
both ramps).

#### `pan` waypoints

`pan` lets the camera move within a single zoom segment. Each waypoint
moves the camera to a new center, easing from the previous position.

| Field | Required | Notes |
|---|---|---|
| `afterMs` | yes | Time from the zoom's effective start (`fromAction.tStart + startDelayMs`), where `tStart` is the action's time **as recorded in `timeline.json`** (canvas/video seconds). Absolute, not cumulative. *Not* relative to `deskagent control`'s per-event `ms`, which start at 0 inside the script and are offset from video time by the recorder + control startup lead-in (~1.4 s). Compute it from `timeline.json` event times, never the control clock. |
| `x`, `y` | yes | Target center coordinates in the entry's `coordinate_space`. All waypoints share the entry's `windowId` (window-space pans stay in one window). |
| `ease` | no (default `in_out`) | `linear` / `in` / `out` / `in_out`. Easing curve into this waypoint. |

**`pan` vs `follow_cursor` - use the right one:**

- `follow_cursor` is for ranges where **clicks happen**: the camera tracks
  the synthetic cursor as it moves between click targets.
- `pan` is for ranges where **no clicks happen**: a cinematic "look here,
  then there" sweep over static UI. The cursor sprite is **hidden** inside
  pan ranges (a parked cursor would otherwise sit off the panned view and
  distract).

Don't author a `pan` over a range that contains click actions - use
`follow_cursor` for those. The two are mutually exclusive within one
entry, and overlapping a pan range with clicks just hides the cursor for
those clicks.

Semantics: from t=segment_start until `pan[0].afterMs`, the camera
holds at the entry's `x`/`y` (the implicit "start waypoint"). Between
waypoints, the camera eases from the previous position to the current
one using the destination's `ease`. After the last waypoint, the
camera holds at that position until the zoom segment ends.

Validation: every `afterMs` must be `>= 0` and strictly less than the
range's duration (after offsets). Waypoints must be in strictly
increasing `afterMs` order. `pan` + `follow_cursor: true` is a hard
error.

#### Continuity across scenes

Two zoom entries that touch in time (one's `toAction` is the next
one's `fromAction`) both ramp at the join - A ramps out, B ramps in.
For ~`2 × RAMP` (about 400 ms) the combined zoom amount drops, so the
camera visibly unzooms and re-zooms.

To keep one continuous camera across multiple scenes, write **one**
zoom entry whose `fromAction` and `toAction` span all of them. Use
`pan` waypoints inside that single entry to change focus, or
`follow_cursor: true` to glide between clicks.

### `speed`

```jsonc
"speed": [
  {
    "factor":       2.5,                  // > 0 and != 1; required
    "fromAction":   "fill_list/0",        // required, global ref
    "toAction":     "fill_list/2",        // required, half-open
    "startDelayMs": 0,                    // optional
    "endDelayMs":   0                     // optional
  }
]
```

Factor `> 1` plays faster, `< 1` slower, `1` is rejected. Entries
beyond the speed range play at factor 1. `scripts/stages/speedups.js` builds a
piecewise warp; the resulting `timewarp.json` is consumed by
`scripts/export.js` for trim math.

Validation: speed segments may **not** overlap (evaluated on the
post-offset envelope). Overlapping entries are a hard error.

### `captions`

```jsonc
"captions": [
  { "text":         "Press 7",
    "fromAction":   "press7/0",
    "startDelayMs": 0,                // optional, signed
    "toAction":     "plus/0",         // EITHER toAction (+ optional endDelayMs)
    "endDelayMs":   -100 },
  { "text":         "Then plus",
    "fromAction":   "plus/0",
    "durationMs":   800 }             // OR durationMs (mutually exclusive with toAction)
]
```

Captions are drawn at the bottom of the canvas in a single centered
strip, rendered via `deskagent text-png` (CoreText, sidesteps the missing
`drawtext` in some ffmpeg builds). One caption visible at a time.

| Field | Required | Notes |
|---|---|---|
| `text` | yes | The caption string. |
| `fromAction` | yes | Action ID `"sceneId/index"` that anchors the start. |
| `startDelayMs` | no | Signed offset on the start, in ms. Default `0`. |
| `toAction` | conditional | Action ID that anchors the end. Mutually exclusive with `durationMs`. |
| `endDelayMs` | no | Signed offset on the end (only with `toAction`). Default `0`. |
| `durationMs` | conditional | Duration from the start. Mutually exclusive with `toAction`. |

Validation: caption entries may **not** overlap in time (single shared
strip). Overlapping entries are a hard error - author shortens the first
with `endDelayMs`/`durationMs` or pushes the second with `startDelayMs`.

### `highlights`

Optional override block for the editor's cursor sprite and click-ripple.
Not used by `deskagent control` - purely a render-time concern. Full
field reference: [`editing.md`](./editing.md#highlights).

```jsonc
"highlights": {
  "ripple": { /* see editing.md#highlights */ },
  "cursor": { /* see editing.md#highlights */ }
}
```

### `cursor` (visibility)

Controls when the synthetic cursor is drawn. By default the cursor follows the
pointer track (clicks + moves + pointer events) across the whole video. Use
`hide`/`show` (action ranges, same `startDelayMs`/`endDelayMs` offsets as other
directives) to gate it - e.g. hide it during a scroll, then let it reappear
before the next click.

```jsonc
"cursor": {
  "hide": [ { "fromAction": "tour/0", "toAction": "outro/0", "endDelayMs": 1400 } ],
  "show": [ /* whitelist: if present, cursor is visible ONLY in these ranges */ ]
}
```

End a `hide` range a beat before the next click and the cursor reappears
already gliding toward it (the path is continuous; `hide` only gates
visibility). Composes with the automatic pan-range hiding. Render-time only -
not read by `deskagent control`. See [`editing.md`](./editing.md#highlights).

### `trim` (top-level)

```jsonc
"trim": { "beforeScene": "intro", "afterScene": "outro" }
```

Head trim = `beforeScene`'s `tStart`. Tail trim = `afterScene`'s
`tEnd + 600 ms`. Both fields default to first/last scene.

## Validation (Swift, on load)

- `schema_version == 2`. v1 is rejected with a migration hint.
- Scene IDs unique.
- All actions have a valid `action` kind (the eight above).

Editing scripts additionally validate:

- Every `zoom`/`speed`/`captions` entry has `fromAction` AND (for zoom/speed) `toAction`.
- Every referenced action ID resolves.
- Every referenced scene id resolves.
- `zoom`: `follow_cursor: true` requires at least one click event in the range.
- `zoom`: `pan: [...]` waypoints must be in strictly increasing `afterMs` order and within the range.
- `zoom`: `pan` and `follow_cursor: true` are mutually exclusive.
- `zoom`: a window-space center (static or pan) in a multi-window comp must set the entry's `windowId` (scenes' `windowId` is not consulted for directives).
- `speed`: factor `> 0` and `!= 1`.
- `speed`: no overlapping post-offset envelopes.
- `captions`: entries don't overlap in time (single shared bottom strip).
- `captions`: each entry has either `toAction` (+ optional `endDelayMs`) OR `durationMs`.
- Multi-window composition needs per-scene `windowId` so click coords resolve to the correct window slot.

## `setup` / `preflight` / `validate` (informational)

Authors may add free-form `setup`, `preflight`, `validate` arrays at the
top level for their own bookkeeping (open-app shell commands,
`deskagent assert` probes, post-demo verifications). Neither
`deskagent control` nor the editing scripts read them - they're notes
the agent re-executes manually outside the screenplay.

```json
"setup": [
  { "action": "shell", "cmd": "open -a 'Notes'" },
  { "action": "wait",  "ms": 1500 }
],
"preflight": [
  { "assert": "label", "value": "New Note" }
]
```

Don't put setup actions inside a scene unless they're meant on camera.

## Window size vs. format

| Format | Recommended window |
|---|---|
| `horizontal_16_9` (1920x1080) | 1440x900 @ 1x retina |
| `square_1_1` (1080x1080) | 1080x1080 centered crop |
| `vertical_9_16` (1080x1920) | 540x960 |

Pick the window size BEFORE exploration so click coords stay valid.

Worked examples:
- [`assets/examples/notes-demo.json`](../assets/examples/notes-demo.json) - basic scene-bound zoom and speed.
- [`assets/examples/continuous-zoom-demo.json`](../assets/examples/continuous-zoom-demo.json) - cross-scene zoom range with `pan` waypoints.
