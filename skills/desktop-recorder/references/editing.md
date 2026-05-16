# Editing & export

Inputs: `demo.raw.mp4` + `screenplay.json` + `timeline.json` +
`demo.raw.mp4.meta.json`. Every edit reads all three (see
[`timeline.md`](./timeline.md) for the anchoring rule).

Each stage takes the same four positional args:

```
<input.mp4>  <screenplay.json>  <timeline.json>  <output.mp4>
```

Plus `--target-window <id>` whenever the meta sidecar has multiple
windows. Stages **auto-propagate** the meta + captions sidecars so the
next stage finds them without a manual `cp`.

## Pipeline

```bash
node scripts/add_highlights.js demo.raw.mp4   screenplay.json timeline.json demo.hl.mp4     [--target-window $ID]
node scripts/add_zoom.js       demo.hl.mp4    screenplay.json timeline.json demo.hlz.mp4    [--target-window $ID]
node scripts/add_captions.js   demo.hlz.mp4   screenplay.json timeline.json demo.hlzc.mp4   [--target-window $ID]
node scripts/add_speedups.js   demo.hlzc.mp4  screenplay.json timeline.json demo.hlzcs.mp4  [--target-window $ID]
node scripts/export_video.js   demo.hlzcs.mp4 screenplay.json timeline.json demo.final.mp4 horizontal_16_9 [--target-window $ID]
```

Ordering matters:

1. **highlights** burns ripples + cursor sprite onto source-time frames,
   and emits the captions sidecar (not burned).
2. **zoom** transforms the framed canvas uniformly — ripples + cursor
   come along for free.
3. **captions** burns captions in OUTPUT-frame coords (viewport
   pixels), AFTER zoom — so the zoom transformation never crops them.
4. **speedups** re-times frames; remaps the captions sidecar through
   the warp and emits `<out>.timewarp.json`.
5. **export** trims by `screenplay.trim` (scene IDs); if a
   `<input>.timewarp.json` exists, source-time trim points are mapped
   through the warp.

Skip any stage by skipping its call and pointing the next stage at the
previous output.

## `add_highlights.js`

Reads click positions from the timeline (`action == "click"` events).
Burns soft ripples at click coords + a synthetic cursor sprite (arrow
during motion, pointing-hand on click). Also writes
`<out>.captions.json` from `screenplay.scenes[].caption` — captions are
NOT burned here (see `add_captions.js`).

| Flag | Effect |
|---|---|
| `--target-window <id>` | REQUIRED for multi-window composites. |
| `--no-cursor-sprite` | Skip cursor rendering (use for HID-mode recordings). |
| `--cursor-color RRGGBB` | Tint. Default black. |
| `--cursor-size N` | Sprite longest edge in px. Default `max(64, videoHeight * 0.07)`. |
| `--ripple-color r:g:b:a` | Ripple peak. Default `255:255:255:180`. |

## `add_zoom.js`

**Opt-in.** Only scenes with a `zoom` directive zoom. See
[`desktop.md`](./desktop.md#zoom-scene-level) for the directive shape.

| Flag | Effect |
|---|---|
| `--target-window <id>` | REQUIRED for multi-window composites. |
| `--ramp S` | Ease-in / ease-out seconds at the segment edges. Default `0.2`. |
| `--deadzone F` | Cursor may roam this fraction of the zoomed view before the camera pans. Default `0.10`. |
| `--follow-smoothing F` | EMA alpha for camera catch-up (0..1). Default `0.5`. |
| `--debug` | Print the ffmpeg filtergraph on stderr. |

Implementation notes:

- Uses ffmpeg's `zoompan` filter (not `crop`, whose `w`/`h` are
  init-only) so all zoom geometry is re-evaluated every frame.
- Hard-errors when meta is missing or multi-window without `--target-window`.

### HID-mode (real cursor in the recording)

When `deskagent record` ran WITHOUT `--no-cursor`, the captured window
already contains a real cursor. Pass `--no-cursor-sprite` to
`add_highlights.js` (so you don't double up) and the cursor-follow zoom
falls back to interpolating click positions, same as BG mode. If you
want the camera to follow the recorded HID cursor track instead,
provide `<input>.mouse-path.json` (written by `deskagent control
--mouse-path`) — currently the script reads only clicks from the
timeline, so a future flag will pull mouse-path samples directly.

## `add_captions.js`

Burns captions at fixed OUTPUT-frame coords (centered horizontally, at
configurable Y) so the zoom transformation upstream doesn't crop them.
Reads `<input>.captions.json` (propagated from highlights); falls back
to deriving captions from `screenplay.scenes[].caption` if the sidecar
is missing.

| Flag | Effect |
|---|---|
| `--target-window <id>` | Only required if the meta sidecar has multiple windows. |
| `--caption-y FRACTION` | 0 = top, 1 = bottom. Default `0.85`. |
| `--caption-font-size N` | Default `max(28, videoHeight * 0.04)`. |
| `--no-captions` | Passthrough (sidecar carried forward unchanged). |

Hand-edit `<input>.captions.json` between zoom and captions to tweak
text or timing without re-running highlights.

## `add_speedups.js`

**Opt-in.** Only scenes with a `speed` directive re-time. See
[`desktop.md`](./desktop.md#speed-scene-level) for the directive shape.

Writes two sidecars beside the output:

- **`<out>.timewarp.json`** — piecewise map of src↔dst seconds + factor
  per segment. Consumed by `export_video.js` for trim math, and
  available to any downstream consumer that lives in source time.
- **`<out>.captions.json`** — input captions remapped through the warp
  (start/end remapped per segment).

| Flag | Effect |
|---|---|
| `--target-window <id>` | REQUIRED for multi-window composites. |
| `--debug` | Print the ffmpeg filtergraph on stderr. |

Burned-in pixels (ripples, cursor, captions) come along for free —
ffmpeg just re-times the rendered frames.

## `export_video.js`

```bash
node scripts/export_video.js <in.mp4> <screenplay.json> <timeline.json> <out.mp4> <format> [--target-window <id>]
```

| Format | Dims |
|---|---|
| `horizontal_16_9` | 1920 × 1080 |
| `square_1_1` | 1080 × 1080 |
| `vertical_9_16` | 1080 × 1920 |

Trim window comes from `screenplay.trim`:

```
head = scene[ trim.beforeScene ].tStart            (defaults to first scene)
tail = scene[ trim.afterScene  ].tEnd + 600 ms     (defaults to last scene)
```

Both are resolved against the timeline. If a `<input>.timewarp.json`
sits next to the input, the source-time bounds are mapped through it so
the cut lands on the right frames in the sped-up output.

## Captions sidecar shape

```json
[
  { "startMs": 500,  "endMs": 850,  "text": "Switch to Automation" },
  { "startMs": 2050, "endMs": 2150, "text": "Back to Testing" }
]
```

After `add_speedups.js`, the same file beside the sped-up mp4 has
`startMs`/`endMs` rewritten through the warp.

## Window sizing matters more than crop

A 1440 × 900 window on a 3456 × 2234 retina display means the export
downscales mostly empty pixels. Size the demo window to fill the
capture region; crop only menu bar / taskbar in post.

## `copy.md` generation

`node scripts/generate_copy.js timeline.json prompt.txt copy.md` —
reads scene captions / intents from the timeline and produces title /
short post / Shorts title / thumbnail text. Hand-rewrite as needed.
