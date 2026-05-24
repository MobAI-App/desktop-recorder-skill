# Editing & export

Inputs: the recording directory (containing `recording.manifest.json` and
per-source ProRes 4444 `.mov` clips) + `screenplay.json` + `timeline.json`.

Everything runs in **one ffmpeg invocation**. `scripts/export.js` collects a
filter fragment from each stage, assembles them into one `filter_complex`,
and runs ffmpeg once. The per-source clips are decoded once, the final
mp4 is encoded once - no intermediate files in the hot path, no
generation loss from per-stage re-encodes.

## Stage order

```
[compose] → [highlights] → [zoom] → [captions] → [speedups] → [final scale/pad] → encode
```

Each stage is a module in `scripts/stages/` exporting two functions:

```js
generate(ctx, { inputLabel }) -> {
  filters:     ["[in]...[out]", ...],       // ffmpeg filter strings, joined with ';'
  inputs:      ["[in]"],                    // upstream labels consumed
  outputs:     "[afterX]",                  // single label produced
  extraInputs: [{ argv: ["-i", "..."] }],   // additional ffmpeg `-i` blocks
  sidecars:    { captions?, timewarp? },    // out-of-band data
}

apply(ctx, inputMov, outputMov)             // debug runner; renders only this stage to a ProRes 4444 .mov
```

Stages reference their own extra inputs by `${capInput<N>}` placeholders;
the orchestrator substitutes absolute ffmpeg input indices after counting
prior stages' extra inputs.

## Orchestrator CLI

```bash
node scripts/export.js <recordingDir> <screenplay.json> <timeline.json> <out.mp4> [format] \
    [--quality standard|high|h264|pro]   default: high (HEVC ~200 Mbps via VideoToolbox)
    [--width N --height N]               explicit output dims (override format)
    [--skip <stage>]                     (repeatable; e.g. --skip captions)
    [--dry-run]                          print ffmpeg cmd without running
    [--debug]                            print the assembled filtergraph
```

`format` is **optional**. When omitted, the export sizes to the user's
main display's native pixel resolution (so QuickTime plays the result 1:1
on this machine).

Named formats:

| Format | Size |
|---|---|
| `display` *(default when omitted)* | NSScreen.mainScreen × backingScale (e.g., 3456×2234 on a 16" MBP) |
| `horizontal_16_9` | 1920 × 1080 |
| `square_1_1` | 1080 × 1080 |
| `vertical_9_16` | 1080 × 1920 |
| `hd_720` | 1280 × 720 |
| `uhd_4k` | 3840 × 2160 |

`--width N --height N` overrides any format choice with exact pixel dims.

Quality presets:

| `--quality` | Codec | Notes |
|---|---|---|
| `standard` | `hevc_videotoolbox` -b:v 50M | Smaller, content-aware encoder may go well below the cap |
| `high` *(default)* | `hevc_videotoolbox` -b:v 200M | Same encoder, much higher ceiling |
| `h264` | `libx264 crf=18 veryfast` | Wider-compat fallback; soft on sub-pixel UI |
| `pro` | `prores_ks` profile 3 (422 HQ) | Master / further-editing output; huge files |

Composition canvas (from `screenplay.composition.canvas`) is letterboxed
into the requested output size with `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black`.

## Per-stage debug CLI

Every stage exposes the same shape:

```bash
# Print the stage's filter fragment as JSON (no ffmpeg run).
node scripts/stages/<stage>.js generate <recDir> <screenplay> <timeline>

# Render only this stage's effect to a ProRes 4444 .mov, taking <in.mov> as
# its upstream input. Useful to verify what just one stage does.
node scripts/stages/<stage>.js generate <recDir> <screenplay> <timeline> \
    --apply <in.mov> <out.mov>
```

For `compose`, `--apply` takes only `<out.mov>` - the inputs are the
per-source clips in the recording dir, not a single video.

## Stage descriptions

### `compose`

Reads `composition` from the screenplay, opens each per-source clip as a
separate ffmpeg input, trims the head of each by `shared.headTrimsByPath`
(so every clip's t=0 maps to the shared timeline start), aspect-fits
inside its placement rect, overlays them onto the canvas background with
alpha preserved.

**Never upscales by default.** When a clip's source pixels fit inside its
slot in both axes, it sits at native pixel size centered in the slot
(no scaling, sharp). Only scales down when source > slot. Opt-in via
`composition.upscale: true` (or per-element `upscale: true`) to force
fit-to-slot.

Layout helpers (`composition.layout`):

| Mode | Slots |
|---|---|
| `auto` | 1 clip = full canvas (no padding). 2 = `side-by-side`. 3+ = `grid`. |
| `side-by-side` | A row of N slots; element `weight` controls column widths. |
| `stack` | A column of N slots; element `weight` controls row heights. |
| `grid` | 2-column grid, `ceil(N/2)` rows. |

Output label: `[afterCompose]` (carries alpha).

### `highlights`

Two synthetic overlays on top of the composed canvas:

1. **Cursor sprite.** An arrow (via `deskagent cursor-png --type arrow`)
   drawn along the **pointer track** - the unified timeline of every
   positional action (`click`, `move`, `drag`, `pointer_*`), via
   `cursorWaypointsInCanvasSeconds`. Segment easing depends on the waypoint:
   - **click** → auto pre-arrival glide (cubic ease, ≤0.55 s at ~1400 px/s),
     arriving exactly at the click so the ripple lands on a still cursor;
   - **move** → glides over the action's own `duration_ms` (author-controlled
     speed) - so `move` is the "point the viewer's eye at X" beat;
   - **`move`/`pointer_move` with a `path`** → the polyline is spread across
     the duration and interpolated **linearly** (constant speed), so shapes/
     trajectories trace smoothly. The sprite trace is downsampled to ≤24 points
     per path (the cursor overlay's x/y is one ffmpeg expression term per
     waypoint, which has a practical size ceiling); the underlying draw/driver
     still used the full-resolution path.
   The cursor path is a flat-sum expression (one ramped term per segment), not
   nested - so density doesn't blow the parser. A pointing-hand sprite
   (`--type pointing`) replaces the arrow for ~220 ms around each **click**
   (moves/pointer events don't swap or ripple).
2. **Click ripple.** A procedural soft expanding-ring sprite (alpha .mov
   generated once via `ffmpeg ... geq`) overlay'd at each click position
   with `-itsoffset <click.t>` so each click plays its own copy. Clicks only.

User overrides on `screenplay.highlights`:

```jsonc
"highlights": {
  "ripple": {
    "sprite":     "/path/to/anim.mov",   // optional override; alpha .mov / APNG / transparent webm
    "color":      "FFFFFF",              // procedural ring color RRGGBB; default white
    "size":       160,                   // procedural sprite longest edge in canvas px; default 160
    "durationMs": 520                    // procedural sprite duration; default 520
  },
  "cursor": {
    "arrow":    "/path/to/arrow.png",    // optional; default = deskagent cursor-png --type arrow
    "pointing": "/path/to/pointing.png", // optional; default = --type pointing
    "size":     64                       // longest edge in canvas px; default 64
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `ripple.sprite` | no | Custom animated sprite with alpha. When set, `color`/`size`/`durationMs` are ignored. Each click plays one copy starting from PTS 0 via `-itsoffset`. |
| `ripple.color` | no | Procedural ring fill color (RRGGBB). Default `FFFFFF`. |
| `ripple.size` | no | Procedural sprite dimensions in canvas pixels. Default `160`. |
| `ripple.durationMs` | no | Procedural sprite length. Default `520`. |
| `cursor.arrow` | no | Path to a PNG with alpha. |
| `cursor.pointing` | no | Path to a PNG with alpha; shown for ~220 ms around each click, replacing the arrow so the cursor visibly "presses". |
| `cursor.size` | no | Longest edge in canvas pixels (when rendering defaults via `deskagent cursor-png`). Default `64`. |
| `cursor.hotspotArrow` | no | `[x, y]` in sprite pixels - the pixel that should land EXACTLY on the click point. Default `[0, 0]` (matches the default arrow whose tip is top-left). Required for custom PNGs whose tip isn't at the corner. |
| `cursor.hotspotPointing` | no | Same idea for the pointing sprite. Defaults to `hotspotArrow`. |

**Cursor visibility** - `screenplay.cursor` gates the sprite:

- `cursor.hide: [ {fromAction,toAction,startDelayMs?,endDelayMs?}, … ]` - cursor
  invisible inside these ranges (e.g. hide it during a scroll).
- `cursor.show: [ … ]` - whitelist; if present the cursor is visible ONLY in
  these ranges.

Both compose with the automatic pan-range hiding. End a `hide` range a beat
before the next click and the cursor reappears mid-glide toward it.

Implementation notes:

- Arrow's `enable=` is `not(click windows) * not(pan ranges) * visibility
  gates`; pointing's is `(click windows) * gates`. Same path expression for
  both, so the swap is seamless.
- The pointer track is shared with `zoom`'s `follow_cursor: true` via
  `lib/cursor-path.js` - the camera centers on the sprite's actual position
  (clicks **and** moves), no desync during glides.
- Procedural ripple sprite is cached to
  `~/.cache/deskagent-skill/ripple-{size}-{durSec}-{color}.mov`; only
  the first export of a given configuration pays the geq render cost.
- Pre-record: pass `--no-cursor` to `deskagent record` so the real OS
  cursor doesn't fight the synthetic one.

Output label: `[afterHighlights]`.

### `zoom`

Reads `screenplay.zoom[]`. Each entry creates one segment whose center
comes from one of three sources (mutually exclusive):

- **Static center** - `x`/`y` on the entry, or the first action with
  coords in range.
- **Follow cursor** - `follow_cursor: true`. Camera centers on the
  synthetic-cursor pointer track (clicks **and** moves) in range - shared with
  the highlights stage, so camera and sprite never desync. Needs ≥1 click or
  move in the range.
- **Pan waypoints** - `pan: [...]`. Explicit list of waypoints
  `{ afterMs, x, y, ease? }`. Camera holds at the segment's start center
  (the entry's `x`/`y` or first action with coords in range), then eases
  through each waypoint, then holds at the last waypoint until the
  segment ends.

Use `follow_cursor` for click-driven ranges and `pan` for no-click
cinematic ranges - don't mix. The highlights stage **hides the cursor
sprite inside any pan range** (a no-click section has no cursor to show;
a parked sprite off the panned view just distracts).

**Window for window-space centers.** When a zoom/pan center is in
`coordinate_space: "window"` (entry-level `coordinate_space`, or the
screenplay default) and the composition has more than one window, the
entry **must** set `windowId` to name the target window. The whole entry
- the static/start center *and* every pan waypoint - resolves in that
  one window's coordinate space; to travel a pan across windows, use
  `coordinate_space: "screen"` instead. The directive's `windowId` is the
  only lever here: unlike action coordinates, a directive is not bound to
  a scene, so the scene's `windowId` is **not** consulted. Omitting it in
  a multi-window comp is a hard error naming the entry. (Single-window
  comps resolve automatically.) `follow_cursor` and the
  first-action-in-range fallback are exempt - they resolve real recorded
  actions, which already carry their own window.

**`afterMs` is video time, relative to the segment start.** A waypoint's
`afterMs` is added to the segment's `tStart`, where `tStart` is the
anchor action's start **as it appears in `timeline.json`** (canvas/video
seconds). It is *not* relative to `deskagent control`'s own per-event
`ms`, which start at 0 inside the script and are offset from video time
by the recorder + control startup lead-in (~1.4 s). Compute `afterMs`
from `timeline.json` event times (or as a plain delta after the anchor
action begins), never from the control script's internal clock.

The per-frame `scale` filter (`eval=frame`) scales the whole canvas by
the piecewise zoom factor, then bounded `crop` re-centers back to canvas
dims. Linear ease at each segment's edges (`RAMP_SEC = 0.2`, clamped to
half the segment length so short zooms still get both ramps).

Pan easing modes (per waypoint, default `in_out`):

| `ease` | curve on u ∈ [0,1] |
|---|---|
| `linear` | u |
| `in` | u² (ease in only) |
| `out` | 1 − (1 − u)² (ease out only) |
| `in_out` | cubic ease-in/out |

Output label: `[afterZoom]`.

### `captions`

Reads `screenplay.captions[]` (top-level directive array - see
[`desktop.md`](./desktop.md#captions)). Each entry's text is rendered to a
transparent PNG via `deskagent text-png` and overlay'd with
`enable=between(t, ...)` at its position: `y` (canvas-height fraction, default
0.88 = bottom), `align` (`center`/`left`/`right`) or an explicit `x` center
fraction.

Two captions may overlap in time only if they sit at **different** positions
(e.g. a top label over a bottom subtitle); a same-position time-overlap is a
hard error.

Output label: `[afterCaptions]`.

### `speedups`

Reads `screenplay.speed[]`. Builds a piecewise `setpts` expression that
compresses or expands each range by `factor`. Emits a `sidecars.timewarp`
that `export.js` uses to size the final output `-t` correctly (it caps at
`last.dstEnd + (sourceDuration - last.srcEnd)` so any post-warp tail
plays at 1× and contributes to duration).

Output label: `[afterSpeedups]`.

## Skipping stages

`--skip compose` is rejected - compose is the source of inputs. Any other
stage can be skipped; its output label short-circuits to the previous
stage's output.

## Sidecars

The orchestrator passes `ctx` (loaded once via `lib/screenplay.js`) and
collects each stage's `sidecars` for cross-stage data (e.g., speedups'
`timewarp` consumed by export's duration math). No on-disk intermediate
sidecars in the hot path.

## What changed vs. the older five-script pipeline

- Five `add_*.js` CLIs + `export_video.js` collapsed into one `export.js`
  + five `stages/*.js` library modules.
- No intermediate mp4s between stages; one decode → one filter graph →
  one encode.
- Per-stage `--apply` provides the same "look at one stage's output"
  affordance the old chain gave for free.
- Quality / final container is a flag on `export.js` rather than the
  fixed `libx264 crf=18` the old pipeline re-encoded between every
  stage.
- Default output size auto-detects the user's display so QuickTime plays
  the result 1:1 on this machine.
- Captions moved from per-scene `caption` to a top-level
  `screenplay.captions[]` directive array, matching zoom/speed's shape.
