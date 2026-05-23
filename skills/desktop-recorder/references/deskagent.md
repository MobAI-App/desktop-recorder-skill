# `deskagent` - CLI surface

Native macOS recorder + deterministic input replayer + AX/OCR inspector.
ScreenCaptureKit captures occluded/minimized windows. macOS only.

| Subcommand | Purpose |
|---|---|
| `list` | Enumerate displays + windows (id, pid, x/y, title, onScreen). |
| `inspect <window>` | Discover clickable elements via AX + Vision OCR. Bbox + center in CG points. |
| `assert <window>` | Cheap yes/no probe for a label. Optimized for tight loops. |
| `screenshot <window>` | One-shot JPEG (or PNG via `--out *.png`). Sized for LLM context by default. |
| `record <out-dir>` | Record one ProRes 4444 .mov (alpha-preserving) per source + `recording.manifest.json` into the output directory. SIGINT-clean. |
| `control <script>` | Replay a deterministic JSON script. `--background` drives without focus shift. |
| `doctor` | Verify Screen Recording + Accessibility grants. `--request-accessibility` triggers the prompt. |
| `text-png` / `cursor-png` | Render typeset text / cursor sprite to a transparent PNG (for overlay tools). |

All commands accept `--json`. Exit codes: `0` ok, `1` assertion-failed (`assert` only), `2` runtime/permission, `64` usage.

## Permissions

| Need | TCC scope | Triggered by |
|---|---|---|
| Capture screens/windows | Screen Recording | first `record` or `list` |
| Synthesize input | Accessibility | first `control` |

`deskagent doctor` reports both. `--request-accessibility` surfaces the
prompt without making a control call.

## Discovery

### `deskagent list`

```bash
deskagent list --json
```

Emits `{ displays: [...], windows: [{id, pid, app, bundleID, title, x, y, width, height, onScreen}] }`.
**Window IDs are per-launch** - re-list before each `record`. Add
`--all` to surface occluded / minimized windows (`onScreen: false`).

Pick one:

```bash
INFO=$(deskagent list --all --json | jq -c '[.windows[] | select(.app=="Safari")] | first')
ID=$(echo "$INFO" | jq -r '.id')
PID=$(echo "$INFO" | jq -r '.pid')
ORIGIN=$(echo "$INFO" | jq -r '"\(.x),\(.y)"')
```

### `deskagent inspect`

```bash
deskagent inspect --window <id> \
    [--ax|--no-ax] [--ocr|--no-ocr] \
    [--label "Submit" ...] [--role AXButton ...] \
    [--json]
```

Two complementary sources, both on by default:

- `--ax` - native AppKit; one entry per AX element (`role`, `label`, `bbox`).
- `--ocr` - Vision text recognition; works on any pixels (Wails/Electron/Canvas).

Filters (repeatable): `--label` (case-insensitive substring), `--role`
(exact AX role). When `--label` matches AX, the OCR pass is skipped.

Single `inspect` is the most expensive op in this CLI (AX walk + Vision
OCR). Cache the result and `jq` it locally:

```bash
SNAPSHOT=$(deskagent inspect --window $ID --json)
echo "$SNAPSHOT" | jq -r '.ax[] | select(.label=="Submit") | .center | @sh'
```

For Wails/Electron, `--ax` usually returns only the window chrome.
Use `--ocr` for those, or rely on `--background`'s AXPress hit-test
which walks the WebKit-bridged AX tree at click time.

### `deskagent assert`

```bash
deskagent assert --window <id> \
    [--label "X" ...] [--label-any "A,B"] [--role AXButton ...] \
    [--absent] [--no-ocr] [--json]
```

Exit codes: `0` found · `1` absent · `2` error. `--absent` inverts.

`--label` is AND across flags; `--label-any` is OR across CSV entries.
JSON returns `{ found, source, label, role, center, bbox }` for the
first match - pipe straight into a click.

### `deskagent screenshot`

```bash
deskagent screenshot --window <id> \
    [--region x,y,w,h] [--annotate-bboxes] \
    [--quality 1-100] [--max-dim N] \
    [--out path.jpg] [--json]
```

JPEG by default - PNG via `--out *.png`. Defaults: `quality=85`,
`max-dim=1568` (Claude's resize threshold), output
`$TMPDIR/deskagent/<window-id>-<ms>.jpg`. JSON emits `{path,
pixelSize, windowFrameCG, backingScale, format}`.

`--annotate-bboxes` overlays AX (cyan) + OCR (yellow) rectangles -
useful for visual verification of which element a label resolves to.

## Recording: `deskagent record`

`record` writes one ProRes 4444 `.mov` per source into an output
directory, plus `recording.manifest.json`. Per-pixel alpha is preserved
on every clip, so the editor can composite windows onto any background
without the OS's rounded corners or shadows showing through as black.

```bash
deskagent record /tmp/demo --window "$ID" \
    --fps 60 \
    --pid-file /tmp/rec.pid --quiet --json > /tmp/rec.json &
# … drive …
kill -INT "$(cat /tmp/rec.pid)"; wait
# /tmp/demo/ now contains window-<ID>.mov + recording.manifest.json
```

**Never `kill -9`** - the .mov's moov atom won't flush.

**Composition / quality / final-encode** are an editor concern; see
`editing.md`. `record` always captures BGRA → ProRes 4444 .mov. The
editor's `export.js` picks the final container, codec, and bitrate.

### Source flags

| Flag | Repeatable | Purpose |
|---|---|---|
| `--window ID` | yes | One clip per window. |
| `--display ID` | yes | One clip per display. |
| `--app NAME` | yes | One clip per matched window (name or bundle id; case-insensitive). |
| `--window-title S` | no | When `--app` is used, restrict to titles containing S. |

### Behavior flags

| Flag | Default | Notes |
|---|---|---|
| `--fps` | `60` | 10–120. Same fps applied to every clip. |
| `--supersample N` | `1` | Pixel-density multiplier on top of the display's backing scale (1..4). `1` = device pixels (what's on screen); `2` = 2× supersampled - SCK re-rasterizes AppKit content from vectors so text/UI stay crisp when the export scales clips up or QuickTime pixel-doubles on retina. Costs ~N² bandwidth and disk. |
| `--no-cursor` | (cursor visible) | Hide system cursor in every clip. The editor's highlights stage draws a synthetic cursor that follows clicks. |
| `--pid-file PATH` | – | Write the process pid for `kill -INT`. |
| `--quiet` / `--json` | – | Output mode. |

### Output

Each source writes to `<out-dir>/<kind>-<id>.mov` (e.g.
`window-12345.mov`, `display-1.mov`). `<out-dir>/recording.manifest.json`
is written after all clips finalize.

JSON stdout (`--json`):

```json
{
  "status": "ok",
  "directory": "/tmp/demo",
  "manifest": "/tmp/demo/recording.manifest.json",
  "durationSeconds": 12.3,
  "fps": 60,
  "clips": [
    { "path": "/tmp/demo/window-12345.mov",
      "source": "window:12345",
      "frames": 740, "dropped": 0,
      "startWallclockMs": 1716480000050 }
  ]
}
```

### Manifest sync anchors

Every clip in `recording.manifest.json` carries `startHostNs` and
`endHostNs`. The editor uses them to compute a shared time window:

- `t0   = max(clip.startHostNs)` - latest first-frame across clips.
- `tEnd = min(clip.endHostNs)`   - earliest last-frame.
- Per clip head-trim: `(t0 - clip.startHostNs) / 1e9` seconds.
- Composited duration: `(tEnd - t0) / 1e9` seconds.

### Alpha & color

Capture is BGRA via SCStream → ProRes 4444 (`yuva444p12le`) via
AVAssetWriter. Each clip's `alpha` channel reflects the window's real
shape - areas outside the window's content have `alpha=0`. Compositing
in the editor (`compose` stage) uses ffmpeg's `overlay`, which respects
the source alpha natively.

## Desktop control: `deskagent control`

A **deterministic replayer**. No screen observation, no retry. Author a
screenplay, dry-run, replay.

### Screenplay schema

Full reference: [`desktop.md`](./desktop.md). Minimal shape:

```json
{
  "schema_version": 2,
  "coordinate_space": "window",
  "scenes": [
    {
      "id": "open_settings",
      "caption": "Open Settings",
      "actions": [
        { "action": "click", "x": 320, "y": 180 },
        { "action": "wait",  "ms": 600 }
      ]
    }
  ]
}
```

Action kinds:

| Action | Required | Optional |
|---|---|---|
| `wait` | `ms` | - |
| `move` | `x`, `y` | `duration_ms` (interpolate if > 0) |
| `click` | `x`, `y` | `button` (`left`/`right`) |
| `double_click` | `x`, `y` | `button` |
| `drag` | `x`, `y`, `to_x`, `to_y` | `duration_ms` (default 400) |
| `type` | `text` | `cpm` (chars/minute; overrides default cadence - ~7500 cpm HID, ~3750 cpm per-pid; posts Unicode via `keyboardSetUnicodeString`) |
| `key` | `combo` | - (`cmd+s`, `shift+tab`, `escape`, …) |
| `scroll` | - | `dx`, `dy` (line-based wheel deltas) |

`coordinate_space: "window"` is the agent default - pair with
`deskagent inspect`'s window-relative coords for portability.

`deskagent control` ignores screenplay's editing-only fields
(`zoom`, `speed`, `trim`, `setup`, `preflight`, ...). Editing scripts
read them directly.

### Invocation

```bash
deskagent control screenplay.json \
    [--target-window ID | --target-pid PID --window-frame "x,y"] \
    [--background] [--no-activate] \
    [--timeout-ms N] [--prompt-permission] \
    [--timeline /tmp/timeline.json] [--mouse-path /tmp/mp.json] [--json]
```

| Flag | Purpose |
|---|---|
| `--target-window ID` | Resolve origin via `CGWindowListCopyWindowInfo` (and auto-raise unless `--no-activate`). **Forbidden during an active recording** - see Rule 4. |
| `--target-pid` + `--window-frame` | Explicit; makes no WindowServer call. **Preferred during recording.** |
| `--background` | Drive without focus shift. AXPress for clicks, `CGEventPostToPid` for keys/scroll. |
| `--no-activate` | Skip auto-raising the target app. |
| `--timeline` | Write the execution event array (see [`timeline.md`](./timeline.md)). |
| `--mouse-path` | Write sampled cursor positions (cadence from `sample_mouse_ms`). |

### HID vs `--background`

|  | HID (default) | `--background` |
|---|---|---|
| User cursor | Moves to each step | Doesn't move |
| Frontmost app | Switches to target | Stays put |
| Clicks | `CGEvent.post(.cghidEventTap)` | `AXUIElementPerformAction(.AXPress)` |
| Keys / scroll | Global HID tap | `CGEventPostToPid(pid, event)` |
| Works on Wails/Electron | Yes (target frontmost) | Yes (WebKit AX bridge) |
| Works on no-AX apps | Yes | Filtered (no-op) |
| `cmd+X` shortcuts | Reliable | Often dropped (AppKit reads flags from global tap) |

HID is the safe default. `--background` is for "user keeps working in
another app" demos.

`--background` caveats:

- **Modifier shortcuts** can drop - briefly activate the target for
  essential ones, or use a menu/osascript equivalent.
- **Apps with no AX exposure** won't accept `--background` clicks. Validate
  with `deskagent inspect --window <id> --ax`.
- **Inter-character pacing**: per-PID `type` adds 8 ms per char (target
  drains slower than the global tap). HID has zero delay.
- **Wails-occluded repaint lag**: when the captured window is fully
  occluded, the backing layer can lag the actual UI state by several
  frames. Clicks still register in app state, but the captured pixels
  may show stale content. Bring the window forward if pixel-accuracy
  matters.

### Timeline output

Full schema: [`timeline.md`](./timeline.md). Each scene produces
`scene_start` / `action` (one per executed action) / `scene_end`
events, each tagged with `scene_id` / `scene_index`, and (for actions)
canonical `action_id = "<scene_id>/<action_index>"`. Editing scripts
join screenplay directives against these IDs.

For overlay alignment use the `*WallclockMs` fields together with the
recording's `firstFrameWallclockMs`. The `startedAtMs` field is
process-local and not anchored to the video.

```ts
type MousePathSample = { tMs: number, x: number, y: number }
```

## Recording manifest

`deskagent record <out-dir>` writes `<out-dir>/recording.manifest.json`
after every clip finalizes (current schema `version: 1`):

```json
{
  "version": 1,
  "createdAtWallclockMs": 1778883093800,
  "fps": 60,
  "anchorHostNs": 123456789012345,
  "durationSeconds": 18.4,
  "clips": [
    {
      "path": "window-245663.mov",
      "kind": "window",
      "id": 245663, "pid": 40115,
      "app": "MobAI", "bundleID": "run.mobai.app",
      "title": "MobAI - Untitled",
      "frameCG": [538, 90, 1190, 831],
      "pixelSize": [2380, 1662],
      "backingScale": 2.0,
      "firstFramePtsNs": 0,
      "lastFramePtsNs": 18400000000,
      "frameCount": 1104,
      "droppedFrames": 0,
      "startHostNs": 123456789012345,
      "endHostNs":   123475189012345,
      "startWallclockMs": 1778883093850,
      "endWallclockMs":   1778883112250
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `clips[].path` | Relative to the manifest's directory. Always `.mov` (ProRes 4444). |
| `clips[].kind` | `"window"` or `"display"`. |
| `clips[].pixelSize` | Encoded video pixel dimensions of this clip. |
| `clips[].firstFramePtsNs` / `lastFramePtsNs` | File-time PTS of first/last frame (first is always 0). |
| `clips[].startHostNs` / `endHostNs` | Host-time anchors. Use to compute the shared time window across clips (`t0 = max(startHostNs)`, `tEnd = min(endHostNs)`). |
| `clips[].startWallclockMs` / `endWallclockMs` | Wallclock anchors (also human-readable). |
| `anchorHostNs` | `max(clips[].startHostNs)` - the composited timeline's t=0 in host time. |
| `createdAtWallclockMs` | Wallclock when `start` completed; human label. |

`scripts/export.js` reads the manifest, applies the screenplay's
`composition` block via the `compose` stage, then chains the other
editing stages in one ffmpeg pass.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `record` writes 0-byte file | `kill -9` | Always SIGINT/SIGTERM; the file finalizes in `finishWriting`. |
| `cannot enumerate sources` | TCC blocks | `deskagent doctor`; grant Screen Recording. |
| `Accessibility permission required` | TCC blocks input | `deskagent doctor --request-accessibility`. |
| `window id <N> not found` | IDs rotate per launch | Re-`list` before `record`. |
| Wrong window captured | Multiple windows match `--app` | Add `--window-title <substring>` or explicit `--window ID`. |
| Click off on retina | Coords in logical pixels not CG points | Use the values `inspect` returns directly; don't multiply. |
| `--quality pro` rejected | ProRes is .mov-only | Use `.mov`. |
| `cmd+X` no-op under `--background` | AppKit reads flag state from global tap | Activate briefly, or use a menu / osascript path. |
| `--background` click no-op | App has no AX exposure for that element | Drop `--background` for that step, or osascript the action. |
| `type`'d text never appears in video | `type` finished too close to SIGINT; WebView didn't redraw | Add a 1–2 s `wait` after the last `type`, and `sleep 1` between control completion and the SIGINT. |
| Overlays land at the wrong time in the video | Meta sidecar from `scripts/stages/compose.js` missing `firstFrameWallclockMs` | Re-run `scripts/stages/compose.js`; it derives the value from the manifest's host-time anchors. |
| Editing script errors on multi-window meta | Omitted `--target-window` | Pass `--target-window <id>` on every editing stage. |
