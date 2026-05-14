# `deskagent` — native macOS recorder + deterministic desktop control

`deskagent` is the **preferred recording backend for macOS** in this skill.
It replaces `ffmpeg avfoundation` (which can only capture full displays) with
a ScreenCaptureKit-based recorder that captures individual application
windows — including occluded or minimized ones — and a deterministic
mouse / keyboard replayer for driving the UI during the take.

> macOS only.

## What it does

| Subcommand | Purpose |
|---|---|
| `deskagent list` | Enumerate displays + windows with stable per-process IDs (JSON-friendly). |
| `deskagent inspect <window>` | Discover clickable elements via Accessibility tree + Vision OCR. Returns bounding boxes + click centers in screen coords. |
| `deskagent record <out>` | Record one or more displays/windows to `.mp4` (default) or `.mov`. SIGINT-clean. |
| `deskagent control <script>` | Replay a deterministic mouse/keyboard JSON script. Optional `--background` mode drives a target without focus shift via AXPress + per-PID. |
| `deskagent doctor` | Verify Screen Recording (and optionally Accessibility) permissions are granted. |

All commands accept `--json`. Exit codes: `0` ok, `2` runtime/permission, `64` usage.

Install: `./deskagent/scripts/build.sh && ./deskagent/scripts/install.sh`
(see [`deskagent/README.md`](../deskagent/README.md) for signing/TCC details).

## Permissions

| Capability | macOS permission | Triggered by |
|---|---|---|
| Record screens & windows | **Screen Recording** | First `record` or `list` call |
| Send mouse / keyboard events | **Accessibility** | First `control` call; pass `--prompt-permission` to surface the system prompt |

`deskagent doctor` prints both states. Wire it into agent setup before the
first capture call so a missing grant fails fast.

## Discovery: `deskagent list`

```bash
deskagent list --json
```

```json
{
  "displays": [
    { "id": 1, "width": 3024, "height": 1964, "primary": true }
  ],
  "windows": [
    {
      "id": 12345,
      "app": "Safari", "bundleID": "com.apple.Safari",
      "title": "GitHub", "x": 100, "y": 50,
      "width": 1280, "height": 800,
      "onScreen": true
    }
  ]
}
```

Window IDs are **per-launch** — re-run `list` before each `record`. `--all`
also surfaces occluded / minimized windows (`onScreen: false`); recording
those still works because ScreenCaptureKit reads each window's backing layer
directly.

Pick the right window programmatically:

```bash
ID=$(deskagent list --all --json \
     | jq -r --arg app "$APP_NAME" '
         .windows
         | map(select(.app == $app and .width > 200))
         | first.id')
```

## Discovery: `deskagent inspect`

`list` gives windows; `inspect` gives **clickable elements inside one window**
with click centers in CG screen points. This is the primitive that lets an
agent author a deterministic script without eyeballing screenshots.

```bash
deskagent inspect --window <id> [--ax|--no-ax] [--ocr|--no-ocr] [--json]
```

Two complementary sources, both on by default:

| Source | Best for | Output |
|---|---|---|
| `--ax` | Native AppKit apps (Calculator, Finder, Mail, Notes, …) | One entry per AX element with role + label + bbox |
| `--ocr` | Wails / Electron / Canvas / any pixels | One entry per recognized text block via Vision `VNRecognizeTextRequest` |

Example agent recipe:

```bash
ID=$(deskagent list --json | jq '.windows[] | select(.app=="Safari") | .id')

# AX path — labels are the button names ("Submit", "Cancel", …)
read X Y < <(deskagent inspect --window $ID --no-ocr --json \
             | jq -r '.ax[] | select(.label=="Submit") | "\(.center[0]) \(.center[1])"')

# OCR path — labels are recognized text strings
read X Y < <(deskagent inspect --window $ID --no-ax --json \
             | jq -r '.ocr[] | select(.label=="Submit") | "\(.center[0]) \(.center[1])"')

# Either way, hand the result to control:
echo "{\"coordinate_space\":\"screen\",\"steps\":[{\"action\":\"click\",\"x\":$X,\"y\":$Y}]}" \
    | tee /tmp/click.json | deskagent control /tmp/click.json --target-window $ID
```

For Wails/Electron WebViews `--ax` typically returns only the window
chrome — the WebView contents aren't enumerated by the standard AX walk.
Use `--ocr` for those, or rely on `--background`'s AXPress hit test
(which walks the WebKit-bridged AX tree directly at click time).

## Recording: `deskagent record`

### Single window — the common agent case

```bash
deskagent record demo.mp4 --window "$ID"          # blocks; ^C / SIGINT to stop
```

### Background mode + PID file (what the skill should use)

```bash
deskagent record /tmp/demo.mp4 --window "$ID" \
    --fps 60 --quality high \
    --pid-file /tmp/deskagent.pid --quiet --json > /tmp/deskagent.json &

# … drive the app (deskagent control or osascript for app activation) …

kill -INT "$(cat /tmp/deskagent.pid)"
wait                                              # ensures the file flushes
cat /tmp/deskagent.json                           # { output, durationSeconds, frames, dropped }
```

**Never SIGKILL** — it corrupts the `.mp4` (no `moov` atom flushed).

### Multi-source compositing

| Want | Flags |
|---|---|
| One app's windows in a grid | `--app Safari` (auto-layout: 1 fullscreen, 2 side-by-side, 3+ grid) |
| Two specific windows side-by-side | `--window $A --window $B --layout side-by-side` |
| Window over a display backdrop | `--display 1 --window $A` (display becomes back-layer with 8% inset) |
| Vertical "Shorts" frame | `--canvas 1080x1920 --layout stack` |
| Brand background | `--background "color:1a1a2e" --corner-radius 24 --padding 80` |

### Output container & codec

| Extension | Container | Codec choices (`--quality`) |
|---|---|---|
| `.mp4` / `.m4v` *(default)* | MPEG-4 | `standard` (~3 bpp HEVC), `high` (~10 bpp HEVC) |
| `.mov` / `.qt` | QuickTime | HEVC or `pro` (ProRes 422) |

`--quality pro` requires `.mov` (the MPEG-4 spec doesn't allow ProRes); the
CLI rejects the combination at parse time with exit 64.

### Encoding flags

| Flag | Default | Notes |
|---|---|---|
| `--fps` | `60` | 10–120; canvas timestamps use this cadence |
| `--quality` | `high` | `standard` \| `high` \| `pro` |
| `--no-cursor` | (off) | Hide the system cursor in the capture |
| `--canvas WxH` | native single-source, else `2560x1440` | |

### Color & range

ScreenCaptureKit captures TV-range YUV (`kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`),
the encoder writes HEVC tagged BT.709 + TV range, and the two pipeline
paths preserve the 16-235 luma floor end-to-end so QuickTime / Quick
Look don't crush dark pixels on playback:

- **Single source** — SCK's TV-range YUV buffer is handed to the
  encoder verbatim (no Core Image step), matching what Apple's own
  `screencapture` does.
- **Multi-source / composited** — Core Image renders the composited
  CIImage into a TV-range YUV pool buffer. To make CI emit values in
  16-235 instead of full-range 0-255, the compositor pre-scales RGB
  with a `CIColorMatrix` filter (`x × 219/255 + 16/255`) before render.

Without these steps the bytes are full-range but the bitstream is
tagged TV-range, and players apply a 16-235→0-255 expansion that drops
anything below 16 to absolute black ("blacks crushed, too contrasted").
The visible result on Apple's `screencapture` and ours now matches.

## Desktop control: `deskagent control`

A **deterministic replayer**. It doesn't observe the screen, find UI elements,
or retry — you write exact coordinates, dry-run them, then replay during
recording.

### Script schema

```json
{
  "coordinate_space": "window",
  "timeout_ms": 30000,
  "sample_mouse_ms": 16,
  "steps": [
    { "action": "wait",  "ms": 500 },
    { "action": "move",  "x": 320, "y": 180, "duration_ms": 250 },
    { "action": "click", "x": 320, "y": 180, "intent": "Open settings", "caption": "Open settings" },
    { "action": "type",  "text": "Launch checklist" },
    { "action": "key",   "combo": "cmd+s" },
    { "action": "scroll","dx": 0, "dy": -6 }
  ]
}
```

`coordinate_space: "window"` is the recommended form. Pair the script
with `--target-window <id>` (or `--window-frame "x,y"` to pin a fixed
origin) and the executor adds the resolved window origin at runtime, so
the script keeps working when the user drags the window. Use
`coordinate_space: "screen"` (CG global pixels, top-left origin) only
when there's no specific window — e.g. clicking a menu-bar item.

| Action | Required | Optional | Notes |
|---|---|---|---|
| `wait` | `ms` | — | Sleep N ms |
| `move` | `x`, `y` | `duration_ms` | Interpolated cursor motion if `duration_ms > 0` |
| `click` | `x`, `y` | `button` (`left`/`right`), `intent`, `caption` | Single click |
| `double_click` | `x`, `y` | `button` | Two clicks in quick succession |
| `drag` | `x`, `y`, `to_x`, `to_y` | `duration_ms` (default 400) | Hold-and-drag |
| `type` | `text` | — | Posts Unicode keyboard events directly (any character) |
| `key` | `combo` | — | e.g. `cmd+s`, `shift+tab`, `escape` |
| `scroll` | — | `dx`, `dy` | Line-based scroll wheel deltas |

For `coordinate_space: "screen"`, coordinates are **CG screen points**
with top-left origin — the same space `deskagent list` reports under
`x` / `y`. (Logical points, not native pixels — macOS converts internally.)
For `"window"`, coordinates are points relative to the target window's
top-left, with the same units.

`deskagent inspect --window <id>` returns each element's `center` in
CG screen points. To get window-relative coords for a script, subtract
the result's `windowFrame[0..1]`:

```bash
deskagent inspect --window $ID --json | jq --arg label "Submit" '
  .windowFrame as $wf |
  .ocr[] | select(.label == $label) | .center as $c |
  { label, x: ($c[0] - $wf[0]), y: ($c[1] - $wf[1]) }
'
```

### Invocation

```bash
deskagent control demo.actions.json \
    --timeline /tmp/raw-timeline.json \
    --mouse-path /tmp/mouse-path.json \
    --json
```

| Flag | Purpose |
|---|---|
| `--timeline PATH` | Write a `ControlTimelineEvent[]` array — one entry per step |
| `--mouse-path PATH` | Write sampled cursor positions (`sample_mouse_ms` cadence) for post-FX |
| `--timeout-ms N` | Override the script-level timeout |
| `--target-window ID` | Window this script targets. Resolves window origin for `coordinate_space: "window"` and (unless `--no-activate`) auto-raises that window so HID clicks land on it |
| `--target-pid PID` | Override the resolved PID (only meaningful with `--background`) |
| `--window-frame "x,y"` | Override the resolved window origin (use when scripting without `--target-window`) |
| `--background` | Drive the target without focus shift via AXPress (clicks) + CGEventPostToPid (keys/scroll). See below |
| `--no-activate` | Skip auto-raising the target window (default `--target-window` activates the app first) |
| `--prompt-permission` | Trigger the Accessibility permission prompt if not granted |

### Coordinate spaces

A `ControlScript` declares its coordinate space:

```json
{
  "coordinate_space": "window",   // or "screen"
  "steps": [ { "action": "click", "x": 321, "y": 56 } ]
}
```

- `"screen"` (default) — CG global screen points. Portable only if the
  target window doesn't move.
- `"window"` — points relative to the target window's top-left. The
  executor adds the resolved origin (from `--target-window` or
  `--window-frame`) at runtime, so the same script keeps working no
  matter where the user drags the window.

`coordinate_space: "window"` is the recommended form for agent-authored
scripts — pair it with `deskagent inspect --window <id>` to discover
clickable elements in the window's coords.

### Two delivery modes: HID vs `--background`

| Concern | HID (default) | `--background` |
|---|---|---|
| User's cursor | Moves to each step | Doesn't move |
| Frontmost app | Switches to the target (default activates it) | Stays where it was |
| Clicks | `CGEvent.post(.cghidEventTap)` | `AXUIElementPerformAction(.AXPress)` on the AX element at the point |
| Keys / scroll | Global HID tap | `CGEventPostToPid(pid, event)` |
| Works on Wails/Electron WebView UIs | Yes (target must be frontmost) | Yes (WebKit bridges WebView content into the AX tree) |
| Works on apps with no AX exposure | Yes | Clicks fall back to per-PID CGEvent, which macOS filters — typically no-op |
| Modifier-key shortcuts (`cmd+s`) | Reliable | Often dropped (AppKit reads flag state from the global tap) |
| Right-click / double-click | Reliable | Currently sent via CGEvent (same caveat as background clicks on non-AX apps) |

The HID path is the safe default — it always works, just at the cost of
focus shift. Use `--background` when the user must keep working in another
app during the run.

### Canonical agent flow — recording + background drive

```bash
ID=$(deskagent list --all --json | jq '.windows[] | select(.app=="Safari") | .id' | head -1)

# Pipeline: record runs in the background; control drives the same window
# without stealing focus. User keeps using their editor while this runs.
deskagent record demo.mp4 --window "$ID" --no-cursor \
    --pid-file /tmp/rec.pid --quiet --json &
deskagent control demo.actions.json \
    --target-window "$ID" --background --no-activate \
    --timeline /tmp/ctl.json
sleep 1                            # let any final UI render
kill -INT "$(cat /tmp/rec.pid)"
wait
```

`demo.actions.json` should use `coordinate_space: "window"` and click
centers from `deskagent inspect --window <id>` for portability.

#### Caveats

- **Modifier-key shortcuts** under `--background` are unreliable —
  AppKit reads modifier-flag state from the global event tap, not from
  per-PID synthetic keys. For an essential shortcut, either drop
  `--background` for that step, briefly activate the target, or use a
  menu/AppleScript equivalent.
- **Apps with no AX exposure** (rare — most native and most WebKit-based
  apps expose AX content) won't accept `--background` clicks; the
  CGEvent fallback will be filtered by macOS's first-click-activation
  rule. Validate with `deskagent inspect --window <id> --ax`.
- **Inter-character pacing** — `--background` `type` adds an 8 ms gap
  between characters because target processes drain their event queue
  more slowly than the global tap, and without spacing only the first
  few characters
  land. HID mode keeps zero delay since the OS serializes for you.

### Output schema (`ControlTimelineEvent`)

```ts
type ControlTimelineEvent = {
  index: number          // step number in the source script
  action: string         // "click" | "type" | "wait" | …
  startedAtMs: number    // ms since `control` started (NOT since record_start)
  endedAtMs: number
  x?: number             // CG screen *points* in the declared coordinate_space
  y?: number
  coordinate_space: "window" | "screen"
  intent?: string
  caption?: string
}
```

`x` / `y` are passed through verbatim from the source script — they're in
CG screen **points**, not pixels, and they live in the space named by
`coordinate_space`. The recorder's `<output>.meta.json` sidecar carries the
backing-scale + window-origin needed to convert to source pixels for
overlay rendering (see [Recording meta sidecar](#recording-meta-sidecar)).

```ts
type MousePathSample = { tMs: number, x: number, y: number }
```

## End-to-end skill pipeline

The skill's macOS leg becomes:

```
1. deskagent list                   → pick window ID
2. deskagent inspect --window $ID   → click coords (window-relative)
3. write demo.actions.json with coordinate_space: "window"
4. dry-run: deskagent control demo.actions.json --target-window $ID --background
            (verify each click lands; iterate)
5. normalize state (the agent prompt empty, default tab, etc.)
6. START:   deskagent record demo.raw.mp4 --window $ID --no-cursor \
              --pid-file /tmp/rec.pid --quiet --json &
7. DRIVE:   deskagent control demo.actions.json \
              --target-window $ID --background --no-activate \
              --timeline /tmp/control-timeline.json \
              --mouse-path /tmp/mouse-path.json
8. sleep 1                          # let the final UI render
9. STOP:    kill -INT $(cat /tmp/rec.pid); wait
10. MAP:    jq … /tmp/control-timeline.json > timeline.json  (see next section)
11. HIGHLIGHT: scripts/add_highlights.js demo.raw.mp4 timeline.json demo.highlights.mp4
12. EXPORT: scripts/export_video.sh demo.highlights.mp4 timeline.json demo.horizontal.mp4 horizontal_16_9
```

The user can keep working in another app for the entire duration of steps
6–9. `record` captures the window's back buffer regardless of focus or
occlusion; `control --background` drives clicks via AXPress and keys via
per-PID delivery so nothing visible happens outside the target window.

`--no-cursor` on `record` is recommended in this flow because no real
cursor is moving on the captured window — including a cursor would just
draw a stale arrow at the user's actual mouse position.

`mouse-path.json` is optional but lets a future post-processor render a
smoothed cursor or auto-zoom track from the recorded motion.

## Timeline mapping: control → skill exporter

`deskagent control` writes `ControlTimelineEvent`, but the skill's exporter
(see [`timeline.md`](./timeline.md)) consumes `DemoTimelineEvent` with
`timeMs` measured from `record_start`. Two adjustments are required:

1. Rename fields and pick a `type` per action.
2. Add the `record_start` / `record_stop` bookends (deskagent doesn't emit
   them — only the orchestration script knows when capture began/ended).

### `jq` recipe

```bash
RECORD_DURATION_MS=$(jq -r '(.durationSeconds * 1000) | floor' /tmp/deskagent.json)

jq --argjson dur "$RECORD_DURATION_MS" '
  [ { timeMs: 0, type: "record_start" } ]
  + ( map({
         timeMs:   .startedAtMs,
         type:     (.action
                    | gsub("double_click"; "click")
                    | gsub("move"; "wait")        # cursor-only moves are not exporter events
                    | gsub("drag"; "click")
                    | gsub("key";  "type")),
         x:        .x,
         y:        .y,
         coordinate_space: .coordinate_space,
         intent:   .intent,
         caption:  .caption,
         durationMs: (.endedAtMs - .startedAtMs)
       })
     # add a default reason on every wait so the exporter's validation
     # passes; deskagent waits don't distinguish technical vs readability
     | map(if .type == "wait" then . + { reason: "technical" } else . end)
     | map(select(.type != "wait" or .durationMs > 50))   # drop sub-frame waits
    )
  + [ { timeMs: $dur, type: "record_stop" } ]
' /tmp/control-timeline.json > timeline.json
```

> **Note**: the `--timeline` sidecar is a bare JSON array of `ControlTimelineEvent`,
> not an object with a `steps` field. The `--json` stdout output of `deskagent
> control` does wrap the events in `{ "steps": [...] }`; if you pipe that into
> jq instead, change the second line to `+ ( .steps | map( … ) | … )`.

`timeline.json`'s `x` / `y` stay in CG screen points (matching the source
script). `add_highlights.js` reads the recorder's `<output>.meta.json`
sidecar to learn the backing scale and window origin, then converts each
click into source-pixel coordinates at overlay time. Don't multiply by
backing-scale at the jq step — the meta sidecar drives the transform so
the same `timeline.json` works on retina and non-retina captures alike.

### Recording meta sidecar

`deskagent record <output>` writes `<output>.meta.json` next to the video,
e.g. `demo.raw.mp4.meta.json`:

```json
{
  "pixelSize": [2880, 1800],
  "fps": 60,
  "windows": [
    {
      "id": 12345,
      "app": "Safari",
      "bundleID": "com.apple.Safari",
      "frameCG": [100, 80, 1440, 900],
      "backingScale": 2.0
    }
  ],
  "displays": []
}
```

The fields:

| Field | Meaning |
|---|---|
| `pixelSize` | `[width, height]` of the encoded video, in source pixels |
| `windows[i].frameCG` | `[x, y, width, height]` of the captured window in CG screen points (top-left origin) |
| `windows[i].backingScale` | Pixels-per-point on the window's screen — multiply CG points by this to get source pixels |
| `displays[i].pixelSize` | Display capture pixel dimensions (when `--display` was used) |

Highlight rendering uses this sidecar so the same control script + timeline
works on retina and non-retina captures without manual scaling.

`deskagent` deliberately does not carry a `reason` on `wait` steps — every
mapped wait gets defaulted to `"technical"`. If a particular take needs a
viewer-readability pause preserved through editing, hand-edit `timeline.json`
after mapping, or just choose not to include the wait in the control script
at all and let the visible action sit on screen for as long as needed.

### Caveats

- `ControlTimelineEvent.startedAtMs` is measured from `control` startup,
  not from `record_start`. As long as you start `deskagent record` first
  and wait for the PID file to exist before invoking `control`, the offset
  is small (<200 ms). If you need exact alignment, capture wall-clock
  before both processes and offset accordingly.
- `mouse-path` samples use the same `tMs` origin as control timeline events.
- Cursor coordinates from `control` are pass-through from the source
  script, in CG screen **points** (not pixels), in whichever
  `coordinate_space` the script declared (`window` or `screen`). The
  `.meta.json` sidecar pairs each timeline with the backing-scale +
  window-origin needed to land overlays on the recorded pixel grid.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `deskagent record` writes a 0-byte file | Process was `kill -9`'d | Always send SIGINT/SIGTERM; the file is finalized in `finishWriting` |
| `cannot enumerate sources — Screen Recording permission required` | TCC blocked the binary | Run `deskagent doctor`; grant in System Settings → Privacy & Security → Screen Recording |
| `control error: Accessibility permission is required …` | TCC blocked input events | Run with `--prompt-permission` once, then grant in System Settings → Privacy & Security → Accessibility |
| `window id <N> not found` | Window IDs change across launches | Re-run `deskagent list` immediately before `record` |
| Recording is the wrong window | Multiple windows of the same app match `--app` | Use `--window-title "<substring>"` or pick an explicit `--window ID` |
| Click lands on the wrong pixel on retina | Coordinates were captured in logical points, not CG pixels | Multiply by the screen's backing scale (usually 2×) before writing the script |
| `--quality pro` errors out | ProRes only fits in `.mov` | Change the output path to `.mov` |
| `cmd+X` / `shift+X` shortcut had no effect under `--background` | AppKit reads modifier flags from the global tap, not per-PID synthetic events | Briefly activate the target app before the shortcut, use a menu-driven `osascript` equivalent, or drop `--background` for that step |
| Only the first character of a `type` lands under `--background` | (should not happen; deskagent paces per-PID typing at 8 ms/char) | If reproducible, increase the pacing in `ControlExecutor.type`; file an issue with the target app name |
| `--background` click had no effect | App's UI element has no `AXPress` action, and CGEvent fallback was filtered by macOS | Drop `--background` for that step (HID + activate), or wire an `osascript` AX action for the specific element |
| Recording shows the click sequence but the typed text never appeared | `type` finished too close to the SIGINT; the WebView didn't redraw before the .mp4 was finalized | Add a 1–2 s `wait` after the last `type` step in the script, and `sleep 1` between control completion and `kill -INT` of the recorder |
| Coordinates worked in dry-run but miss after the user dragged the window | Script used `coordinate_space: "screen"` | Switch to `coordinate_space: "window"` and pass `--target-window` so origin is resolved at run time |
