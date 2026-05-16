# `deskagent` — CLI surface

Native macOS recorder + deterministic input replayer + AX/OCR inspector.
ScreenCaptureKit captures occluded/minimized windows. macOS only.

| Subcommand | Purpose |
|---|---|
| `list` | Enumerate displays + windows (id, pid, x/y, title, onScreen). |
| `inspect <window>` | Discover clickable elements via AX + Vision OCR. Bbox + center in CG points. |
| `assert <window>` | Cheap yes/no probe for a label. Optimized for tight loops. |
| `screenshot <window>` | One-shot JPEG (or PNG via `--out *.png`). Sized for LLM context by default. |
| `record <out>` | Record one or more windows / displays. SIGINT-clean. Writes a `.meta.json` sidecar. |
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
**Window IDs are per-launch** — re-list before each `record`. Add
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

- `--ax` — native AppKit; one entry per AX element (`role`, `label`, `bbox`).
- `--ocr` — Vision text recognition; works on any pixels (Wails/Electron/Canvas).

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
first match — pipe straight into a click.

### `deskagent screenshot`

```bash
deskagent screenshot --window <id> \
    [--region x,y,w,h] [--annotate-bboxes] \
    [--quality 1-100] [--max-dim N] \
    [--out path.jpg] [--json]
```

JPEG by default — PNG via `--out *.png`. Defaults: `quality=85`,
`max-dim=1568` (Claude's resize threshold), output
`$TMPDIR/deskagent/<window-id>-<ms>.jpg`. JSON emits `{path,
pixelSize, windowFrameCG, backingScale, format}`.

`--annotate-bboxes` overlays AX (cyan) + OCR (yellow) rectangles —
useful for visual verification of which element a label resolves to.

## Recording: `deskagent record`

`record` does NOT modify source windows. Composites that don't match
the canvas slot aspect are letterboxed.

```bash
deskagent record /tmp/demo.mp4 --window "$ID" \
    --fps 60 --quality high \
    --pid-file /tmp/rec.pid --quiet --json > /tmp/rec.json &
# … drive …
kill -INT "$(cat /tmp/rec.pid)"; wait
```

**Never `kill -9`** — the mp4's moov atom won't flush.

### Multi-source flags

| Want | Flags |
|---|---|
| One app's windows in a grid | `--app Safari` |
| Two specific windows side-by-side | `--window $A --window $B --layout side-by-side` |
| Custom weights (e.g. 70/30) | `--weights 70,30` (matches `--window`/`--display` order) |
| Window over a display backdrop | `--display 1 --window $A` (display becomes 8%-inset back layer) |
| Vertical "Shorts" frame | `--canvas 1080x1920 --layout stack` |
| Brand background | `--background "color:1a1a2e" --corner-radius 24 --padding 80` |

### Output formats

| Extension | Container | `--quality` |
|---|---|---|
| `.mp4` / `.m4v` *(default)* | MPEG-4 | `standard` (~3 bpp HEVC) · `high` (~10 bpp HEVC) |
| `.mov` / `.qt` | QuickTime | HEVC · `pro` (ProRes 422; .mov only) |

Other flags: `--fps` 10–120 (default 60), `--no-cursor`, `--canvas WxH`
(default: native single-source, else 2560x1440).

### Color & range (FYI)

SCK captures TV-range YUV; encoder tags BT.709 + TV-range. Two paths
preserve 16–235 luma end-to-end: (a) single-source bypasses Core Image
entirely; (b) multi-source pre-scales RGB through `CIColorMatrix`
(x·219/255 + 16/255) so CI emits in-range YUV. Without this, blacks
crush on QuickTime playback.

## Desktop control: `deskagent control`

A **deterministic replayer**. No screen observation, no retry. Author a
screenplay, dry-run, replay.

### Screenplay schema

Full reference: [`desktop.md`](./desktop.md). Minimal shape:

```json
{
  "schema_version": 1,
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
| `wait` | `ms` | — |
| `move` | `x`, `y` | `duration_ms` (interpolate if > 0) |
| `click` | `x`, `y` | `button` (`left`/`right`) |
| `double_click` | `x`, `y` | `button` |
| `drag` | `x`, `y`, `to_x`, `to_y` | `duration_ms` (default 400) |
| `type` | `text` | — (posts Unicode via `keyboardSetUnicodeString`) |
| `key` | `combo` | — (`cmd+s`, `shift+tab`, `escape`, …) |
| `scroll` | — | `dx`, `dy` (line-based wheel deltas) |

`coordinate_space: "window"` is the agent default — pair with
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
| `--target-window ID` | Resolve origin via `CGWindowListCopyWindowInfo` (and auto-raise unless `--no-activate`). **Forbidden during an active recording** — see Rule 4. |
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

- **Modifier shortcuts** can drop — briefly activate the target for
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

## Recording meta sidecar

`deskagent record <output>` writes `<output>.meta.json`:

```json
{
  "version": 2,
  "state": "complete",
  "pixelSize": [2560, 1440],
  "fps": 60,
  "firstFrameWallclockMs": 1778883093800,
  "durationSeconds": 18.4,
  "frames": 1104,
  "dropped": 0,
  "windows": [
    {
      "id": 245663, "app": "MobAI", "bundleID": "run.mobai.app", "pid": 40115,
      "frameCG": [538, 90, 1190, 831],
      "backingScale": 2.0,
      "canvasRect": [812, 124, 1708, 1193]
    }
  ],
  "displays": []
}
```

| Field | Meaning |
|---|---|
| `state` | `"recording"` (written at start; survives crashes) or `"complete"` (refreshed at clean finish). |
| `firstFrameWallclockMs` | Unix-epoch ms of the first encoded frame. Anchor for timeline events. |
| `durationSeconds` / `frames` / `dropped` | Final tallies; only on `"complete"`. |
| `windows[i].pid` | Owning process pid; downstream tools use it without re-querying WindowServer. |
| `windows[i].frameCG` | `[x, y, w, h]` in CG screen points. |
| `windows[i].canvasRect` | `[x, y, w, h]` in encoded video pixels — where this window is composited. Required for `add_highlights.js` on multi-window. |

`add_highlights.js` reads this sidecar to map window-relative points
into canvas pixels. Multi-window: pass `--target-window <id>` to
disambiguate.

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
| Overlays land at the wrong time in the video | Meta sidecar missing `firstFrameWallclockMs` | Re-record cleanly — the sidecar is rewritten on SIGINT finalize. |
| Editing script errors on multi-window meta | Omitted `--target-window` | Pass `--target-window <id>` on every editing stage. |
