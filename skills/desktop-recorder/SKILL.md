---
name: desktop-recorder
description: Use when the user asks to record / produce / export a screencast or demo video of a macOS desktop or web app — for launch, marketing, social posts, landing pages, internal walkthroughs. Triggers on "record a screencast", "screen recording", "desktop app demo", "web app demo", "record this Mac app", "make a screencast", "marketing video for the app", "record Chrome / Safari". Enforces explore → script → dry-run → record → export. macOS only. For mobile demos use the sibling `mobile-recorder-skill`.
---

# Desktop Recorder

Built on `deskagent` (ScreenCaptureKit + AXPress + Vision OCR). The
agent never improvises during the final take — exploration is
unconstrained, the recording is a deterministic JSON-script replay.

## Pre-recording checklist — ASK, don't pick silently

Use `AskUserQuestion` (or plain text) before recording. State defaults
explicitly so the user can shrug and accept.

| Decision | Default if user shrugs |
|---|---|
| **Backdrop** `none / dark / light / color:RRGGBB / image:PATH` | `dark` |
| **Padding + corner radius** | `--padding 60 --corner-radius 24` (or `0,0` for raw capture) |
| **Layout** for multi-source: `auto / side-by-side / grid / stack` | `auto` |
| **State-verification level** | `standard` (preflight + fingerprint at dry-run boundary) |
| **Which apps may be driven** | Whichever the user named; never silently click into others |

## The 6 rules

### 1. Explore first

Tools allowed during exploration only:

- `deskagent list --json` → window picking
- `deskagent inspect --window $ID` → element coords (AX + OCR)
- `deskagent assert --window $ID --label X` → cheap yes/no probe
- `deskagent screenshot --window $ID` → visual reference
- Trial `deskagent control` runs against the live UI

Collect: click coords (window-relative), per-step waits, demo data,
popups to normalize, the recording's window size (pin BEFORE
inspecting), start/end states, captions.

### 2. The screenplay — single source of truth

One `screenplay.json` describes the demo end-to-end: scenes of actions
to execute, plus per-scene editing directives (`caption`, `zoom`,
`speed`) and a top-level `trim`. The recorder only sees
`scenes[].actions[]`; editing scripts read the directives.

```jsonc
{
  "schema_version": 1,
  "name": "demo1",
  "coordinate_space": "window",
  "scenes": [
    {
      "id": "open_settings",
      "caption": "Open Settings",
      "zoom": { "scale": 2.0, "follow_cursor": true },
      "actions": [ { "action": "click", "x": 244.5, "y": 54.5 } ]
    },
    {
      "id": "wait_load",
      "speed": 5.0,
      "actions": [ { "action": "wait", "ms": 4000 } ]
    }
  ],
  "trim": { "beforeScene": "open_settings", "afterScene": "wait_load" }
}
```

`coordinate_space: "window"` keeps screenplays portable across window
drags. No conditionals, no `wait_for`, no observation loops — every
action is deterministic. Recording start/stop is **outside** the
screenplay — the agent owns the lifecycle.

### 3. Dry-run + state fingerprint

Run the full script with `--background` against the live UI (no
recorder active). Iterate until clean.

Before the final take, prove state matches what the script expects:

1. `deskagent screenshot --window $ID` → visual record.
2. At least **two** `deskagent assert` calls on labels that exist
   ONLY in the expected sub-state. (Section names usually persist
   across sub-states — they're too coarse.)
3. Refuse to record if any assert fails. Re-normalize in `setup`.

Per-step assertions inside `recording` are NOT supported — the
recording is meant to be a deterministic replay, not a probe loop.

### 4. Pin window info BEFORE recording

Capture `id`, `pid`, and `x,y` for every window during exploration,
then drive with explicit flags. This keeps the take fully
deterministic — no WindowServer lookups during the run, no chance of
the wrong window being picked if focus shifted between dry-run and
record. Historically certain SCK versions also dropped the capture
stream on cross-process window queries; staying off WindowServer
during the take guards against that regression coming back.

```bash
# Pre-record (no recording active):
INFO=$(deskagent list --all --json \
       | jq -c '[.windows[] | select(.app=="Safari")] | first')
ID=$(echo "$INFO" | jq -r '.id')
PID=$(echo "$INFO" | jq -r '.pid')
ORIGIN=$(echo "$INFO" | jq -r '"\(.x),\(.y)"')

# Record:
deskagent record demo.mp4 --window $ID --no-cursor --pid-file /tmp/rec.pid &

# Drive — NEVER --target-window during recording:
deskagent control script.json \
    --target-pid $PID --window-frame "$ORIGIN" \
    --background --no-activate

kill -INT $(cat /tmp/rec.pid); wait
```

Multi-window: collect pid+origin per window in one pre-record `list`
call; route each `control` invocation via its own `--target-pid` +
`--window-frame`.

**Targeting matrix** (the two flags are not interchangeable):

| Mode | Required flags | Why |
|---|---|---|
| HID (default — cursor moves, target activated) | `--target-window <id>` | Events go through the global tap → land on the frontmost app. The executor needs the window id to resolve app name + bundle id, then `open -b` activates the target. |
| Background (`--background` — cursor stays put) | `--target-pid $PID --window-frame "x,y"` | Events post directly to the pid via `CGEventPostToPid` / `AXPress`. No activation; the frame is just for coordinate math. |

Mixing them (`--target-pid` / `--window-frame` without `--background`)
gives HID delivery with no activation — clicks land on whichever app
happens to be frontmost.

During a recording, **prefer the background form** — it avoids the
WindowServer lookup entirely, so the take stays deterministic and is
not at the mercy of any SCK regression on cross-process queries.

### 5. No live recovery — re-record

Final take failed? Stop, discard, fix the script, re-record. Don't
patch live.

### 6. Don't resize source windows after exploration

Any `osascript … set size of window` belongs in `setup` BEFORE
exploration, confirmed with the user. Never inside `recording`.
Multi-window composites letterbox; that's preferable to a destructive
mid-take resize.

## End-to-end pipeline

```
1. Explore → pin id/pid/origin per window, gather click coords.
2. Author screenplay.json (scenes + actions + zoom/speed/captions/trim).
3. Normalize state (close tabs, log in, hide bookmarks bar, theme).
4. Dry-run: deskagent control screenplay.json --target-window $ID --timeline /tmp/dry.json
   (safe — no recording yet).
5. State fingerprint via deskagent assert.
6. RECORD in background:
     deskagent record demo.raw.mp4 --window $ID --no-cursor --pid-file /tmp/rec.pid &
7. DRIVE:
     deskagent control screenplay.json \
         --target-pid $PID --window-frame "$ORIGIN" \
         --background --no-activate --timeline timeline.json
8. STOP: kill -INT $(cat /tmp/rec.pid); wait
9. Edit (each stage auto-propagates the meta + captions sidecars):
     node scripts/add_highlights.js demo.raw.mp4   screenplay.json timeline.json demo.hl.mp4
     node scripts/add_zoom.js       demo.hl.mp4    screenplay.json timeline.json demo.hlz.mp4
     node scripts/add_captions.js   demo.hlz.mp4   screenplay.json timeline.json demo.hlzc.mp4
     node scripts/add_speedups.js   demo.hlzc.mp4  screenplay.json timeline.json demo.hlzcs.mp4
     node scripts/export_video.js   demo.hlzcs.mp4 screenplay.json timeline.json demo.mp4 horizontal_16_9
10. Copy: node scripts/generate_copy.js timeline.json prompt.txt copy.md
```

Each editing stage takes the same four positional args:
`<input.mp4> <screenplay.json> <timeline.json> <out.mp4>`. Multi-window
recordings additionally need `--target-window <id>` on every stage.

## Outputs (one demo folder, default `./demo-out/<name>/`)

```
screenplay.json        single source of truth (scenes + directives)
timeline.json          execution evidence from `deskagent control`
demo.raw.mp4           recording + demo.raw.mp4.meta.json sidecar
demo.final.mp4         the deliverable (format from screenplay or --format)
copy.md                upload copy
```

The editing pipeline produces intermediate mp4s between `raw` and
`final` — see `references/editing.md` for the stage chain.

## References (load on demand)

- `references/deskagent.md` — CLI surface, permissions, meta sidecar schema
- `references/desktop.md` — screenplay schema, setup normalization, state-fingerprint recipe
- `references/timeline.md` — timeline event schema (scene_start / action / scene_end)
- `references/editing.md` — highlights / zoom / speedups / export

## Authorization rule

`deskagent control` mutates the user's app state (focus, tabs, open
docs). `--background` minimizes visible impact but still mutates.
Confirm before touching any app the user didn't name. Don't silently
swap targets or open new tabs / windows / documents.

## Quick failure map

| Stage | Cause | Action |
|---|---|---|
| `inspect` returns nothing | Wails/Electron WebView | rely on OCR; AX walk only sees chrome |
| Capture errors at start | Target window `onScreen: false` | bring it forward; SCK can't always frame-pump occluded windows |
| Cursor / captions in wrong place | meta sidecar missing `firstFrameWallclockMs` | re-record cleanly (sidecar is rewritten on SIGINT finalize) |
| Editing script errors on multi-window meta | omitted `--target-window` | pass `--target-window <id>` on every editing stage |
| `screenplay schema_version N not supported` | screenplay was authored for a different deskagent build | re-author to current schema (current: 1) |
| Color crush in output | Pre-v0.2 record path | upgrade (TV-range YUV preserved via fast-path + CIColorMatrix) |
| TCC re-prompts every release | Ad-hoc signing — fresh identity per build | re-grant once, or build with a stable self-signed cert |

## Chrome / Chromium web apps

Chromium-based browsers (Chrome, Edge, Brave, Arc) are the **worst
case** for `--background` because Blink renders the page in a
separate out-of-process renderer that's not in the browser-process
AX tree:

| Click target | Works with `--background`? |
|---|---|
| Browser chrome (Back / Reload / tabs / address bar) | yes — AX-exposed, AXPress works |
| Page DOM (sidebar links, buttons, forms, anchors) | **no** — events go to the wrong process |

So you cannot record a clean Chrome demo with the canonical
`--background --target-pid` flow if the script touches page content
— which it almost always does.

The practical pattern for Chrome demos:

1. **Record with `--no-cursor`** so the system cursor never appears
   in the video — `add_highlights.js` will synthesize a clean cursor
   sprite on top.
2. **Drive with `--target-window`** (HID mode, NOT `--background`):
   ```bash
   deskagent control screenplay.json --target-window $ID --timeline timeline.json
   ```
   `--target-window` looks up bundle id + window frame, then `open -b`
   + AX-raise brings Chrome to the front before each session — no
   separate activation step needed.

This is the one place where Rule 4's "stay off WindowServer during
the take" recommendation gets bent: Chromium forces HID delivery, and
HID delivery needs `--target-window` for activation. In practice the
recording survives the query fine on current macOS. If a fallback is
ever needed, `osascript … execute javascript` in Chrome mutates the
DOM without going through the input layer at all.

The user's actual cursor moves during a Chrome take, so "user keeps
working in another app" isn't an option for Chromium demos.
WebKit-based browsers (Safari) and Wails/Electron apps DO expose
their DOM through an AX bridge and accept `--background` clicks
normally; only Blink-based renderers force HID mode.

Single-page apps quirks worth knowing:

- `deskagent inspect`'s `--ocr` is more reliable than `--ax` on
  Chrome page content — pick coords from the OCR pass.
- OCR centres on the text glyphs, not the whole clickable element.
  Clicking the OCR centre usually still hits the link, but for
  icon-only buttons use `--annotate-bboxes` on a screenshot and
  pick a visually safer interior point.
- "Navigate" via URL bar (`cmd+l` → type → `return`) is more
  deterministic than chasing nav links in a SPA.

## Out of scope

Mobile (use `mobile-recorder-skill`); Linux/Windows; direct upload;
AI voiceover / music; GUI video editor.
