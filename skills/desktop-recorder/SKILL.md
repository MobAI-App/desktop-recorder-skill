---
name: desktop-recorder
description: Use when the user asks to record / produce / export a screencast or demo video of a macOS desktop or web app - for launch, marketing, social posts, landing pages, internal walkthroughs. Triggers on "record a screencast", "screen recording", "desktop app demo", "web app demo", "record this Mac app", "make a screencast", "marketing video for the app", "record Chrome / Safari". Enforces explore → script → dry-run → record → export. macOS only. For mobile demos use the sibling `mobile-recorder-skill`.
---

# Desktop Recorder

Built on `deskagent` (ScreenCaptureKit + AXPress + Vision OCR). The
agent never improvises during the final take - exploration is
unconstrained, the recording is a deterministic JSON-script replay.

## Pre-recording checklist - ASK, don't pick silently

Use `AskUserQuestion` (or plain text) before recording. State defaults
explicitly so the user can shrug and accept.

| Decision | Default if user shrugs |
|---|---|
| **Background** `none / dark / light / color:RRGGBB / image:/path` | `color:1a1a2e` (dark navy). `dark`/`light` render as cached vertical gradients; `image:` covers the canvas. |
| **Layout** for multi-source: `auto / side-by-side / grid / stack` | `auto` |
| **Padding** between elements | `60` |
| **Composition canvas** | display native (or `[1400, 1000]` for the typical 1.4 AR) |
| **Supersample on capture** | `1` (device pixels). Bump to `2` for sharper playback when the editor will scale clips up |
| **Cursor sprite** | macOS system arrow with pointing-hand on click (`deskagent cursor-png`). Override via `screenplay.highlights.cursor.{arrow,pointing,size}` |
| **Click ripple** | Procedural soft expanding white ring. Override color/size/duration via `screenplay.highlights.ripple.*`, or supply your own `.mov`/APNG via `ripple.sprite` |
| **Zoom follow_cursor** | Enabled - camera tracks the synthetic cursor's eased path (shared with the sprite, no desync) |
| **Final export resolution** | display native (so QuickTime plays 1:1 on this machine) |
| **Final quality** | `high` (HEVC ~200 Mbps target) |
| **State-verification level** | preflight + fingerprint at dry-run boundary |
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

### 2. The screenplay - single source of truth

One `screenplay.json` describes the demo end-to-end: scenes of actions
to execute, plus top-level `composition` / `zoom` / `speed` / `captions`
/ `trim` directives. `deskagent control` reads only `scenes[].actions[]`;
editor scripts read the top-level directives.

```jsonc
{
  "schema_version": 2,
  "name": "demo1",
  "coordinate_space": "window",
  "scenes": [
    { "id": "open_settings", "windowId": 245663,
      "actions": [ { "action": "click", "x": 244.5, "y": 54.5 } ] },
    { "id": "wait_load",     "windowId": 245663,
      "actions": [ { "action": "wait", "ms": 4000 } ] }
  ],
  "composition": {
    "canvas":     [2560, 1600],
    "background": "color:0a0a10",
    "layout":     "side-by-side",          // optional; auto-computes slot rects
    "padding":    60,                      // optional gap (used by layout)
    "elements": [
      { "windowId": 245663 }               // auto rect from layout
    ]
  },
  "zoom": [
    { "scale": 2.0, "follow_cursor": true,
      "fromAction": "open_settings/0", "toAction": "wait_load/0" }
  ],
  "speed": [
    { "factor": 2.5,
      "fromAction": "wait_load/0", "toAction": "wait_load/0", "endDelayMs": 4000 }
  ],
  "captions": [
    { "text": "Open Settings",       "fromAction": "open_settings/0", "durationMs": 1500 },
    { "text": "Loading the panel…",  "fromAction": "wait_load/0",     "toAction": "wait_load/0", "endDelayMs": 3000 }
  ],
  "trim": { "beforeScene": "open_settings", "afterScene": "wait_load" }
}
```

`composition` drives `scripts/stages/compose.js` - required for multi-clip
recordings, optional when there's a single clip. `zoom`, `speed`, and
`captions` are top-level arrays with global `fromAction` / `toAction` refs
- a single entry can span any range of actions across any scenes, with
timing offsets via `startDelayMs`/`endDelayMs`. **Zoom camera modes**:
`follow_cursor: true` tracks the synthetic cursor across click-driven
ranges; `pan: [...]` does cinematic sweeps over no-click ranges (the
cursor is hidden during pans). Don't overlap a pan with clicks - use
`follow_cursor` there. See
[`references/desktop.md`](./references/desktop.md) for the full shape.

`coordinate_space: "window"` keeps screenplays portable across window
drags. Per-scene `windowId` routes that scene's action coords to the
correct window in multi-window compositions. No conditionals, no
`wait_for`, no observation loops - every action is deterministic.
Recording start/stop is **outside** the screenplay; the agent owns the
lifecycle.

### 3. Dry-run + state fingerprint

Run the full script with `--background` against the live UI (no
recorder active). Iterate until clean.

Before the final take, prove state matches what the script expects:

1. `deskagent screenshot --window $ID` → visual record.
2. At least **two** `deskagent assert` calls on labels that exist
   ONLY in the expected sub-state. (Section names usually persist
   across sub-states - they're too coarse.)
3. Refuse to record if any assert fails. Re-normalize in `setup`.

Per-step assertions inside `recording` are NOT supported - the
recording is meant to be a deterministic replay, not a probe loop.

### 4. Pin window info BEFORE recording

Capture `id`, `pid`, and `x,y` for every window during exploration,
then drive with `--target-pid` + `--window-frame` + `--background`
during the take. No WindowServer lookups during the run, no chance of
the wrong window being picked if focus shifted between dry-run and
record. Multi-window: collect pid+origin per window in one pre-record
`list` call; route each `control` invocation via its own flags.

Targeting flag rules are documented in `references/deskagent.md`. The
short form: HID mode needs `--target-window` (activates the app);
background mode needs `--target-pid` + `--window-frame` (delivers per-pid,
no activation).

### 5. No live recovery - re-record

Final take failed? Stop, discard, fix the script, re-record. Don't
patch live.

### 6. Don't resize source windows after exploration

Any `osascript … set size of window` belongs in `setup` BEFORE
exploration, confirmed with the user. Never inside `recording`.
Composition is done in the editor's `compose` stage; per-clip placement +
canvas + background live in the screenplay's `composition` block, so a
mid-take window resize would still mismatch the composition rects.

## End-to-end pipeline

```
1. Explore  -> pin id/pid/origin per window, gather click coords.
2. Author   -> screenplay.json (scenes + actions, top-level composition/zoom/speed/captions/trim).
3. Normalize state (close tabs, log in, hide chrome, theme).
4. Dry-run  -> deskagent control screenplay.json --target-window $ID --timeline /tmp/dry.json
5. Fingerprint state with deskagent assert.
6. Record   -> deskagent record ./demo/raw --window $ID [--window $ID2 ...] --no-cursor --pid-file /tmp/rec.pid [--supersample 2] &
                  (writes per-source ProRes 4444 .mov clips + recording.manifest.json into ./demo/raw/)
7. Drive    -> deskagent control screenplay.json --target-pid $PID --window-frame "$ORIGIN" \
                  --background --no-activate --timeline timeline.json
                  (run in parallel per target window for multi-window demos)
8. Stop     -> kill -INT $(cat /tmp/rec.pid); wait
9. Export   -> node scripts/export.js ./demo/raw screenplay.json timeline.json demo.final.mp4 [format] [--quality high]
                  (one ffmpeg pass: compose -> highlights -> zoom -> captions -> speedups -> encode)
10. Copy    -> node scripts/generate_copy.js timeline.json prompt.txt copy.md
```

Every editing operation runs in a single ffmpeg invocation off the
per-source clips - no intermediate mp4s in the hot path, no
generation-loss from per-stage re-encodes. The final encoder choice
(HEVC / H.264 / ProRes 422) is the only re-encode in the entire pipeline.

## Outputs (one demo folder, default `./demo-out/<name>/`)

```
screenplay.json        single source of truth (scenes + composition + directives)
timeline.json          execution evidence from `deskagent control`
raw/                   directory written by `deskagent record`:
  recording.manifest.json   per-clip paths + host-time alignment anchors
  window-<id>.mov           one ProRes 4444 .mov per source (alpha-preserving)
  display-<id>.mov
demo.final.mp4         the deliverable (single ffmpeg pass via scripts/export.js)
copy.md                upload copy
```

For per-stage debugging, each editing stage has a CLI that can either
emit its filter fragment as JSON (used by the orchestrator) or render it
standalone to a ProRes 4444 `.mov` to inspect just that stage's effect:

```bash
node scripts/stages/zoom.js generate <recDir> <screenplay> <timeline>
node scripts/stages/zoom.js generate <recDir> <screenplay> <timeline> --apply input.mov output.mov
```

## References (load on demand)

- `references/deskagent.md` - CLI surface, permissions, recording.manifest.json schema
- `references/desktop.md` - screenplay schema (scenes + composition + captions + zoom + speed + trim), setup normalization, state-fingerprint recipe
- `references/timeline.md` - timeline event schema (scene_start / action / scene_end)
- `references/editing.md` - export orchestrator + per-stage modules (compose / highlights / zoom / captions / speedups)

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
| `screenplay schema_version N not supported` | screenplay was authored for a different deskagent build | re-author to current schema (current: 2) |
| `compose.js` errors: "manifest has N clips but screenplay has no \`composition\`" | multi-clip recording lacks composition | add `composition.canvas` + `composition.elements[]` to screenplay |
| `captions[i] overlaps captions[j]` | two caption entries cover the same time range | shorten the first with `endDelayMs`/`durationMs` or push the second with `startDelayMs` |
| Video looks soft in QuickTime | QT renders .mov dimensions as logical points; pixel-doubles on retina | record with `--supersample 2`, OR export at display-native size (default), OR open the frame as PNG in Preview |
| Composition stretches a window | source pixel size doesn't fit slot AND `composition.upscale` is on | leave `upscale` unset; clip will sit at native size centered in the slot (downscale-only) |
| TCC re-prompts every release | Ad-hoc signing - fresh identity per build | re-grant once, or build with a stable self-signed cert |

## Chromium-based browsers (Chrome, Edge, Brave, Arc)

`--background` reaches only the browser chrome (Back/Reload/tabs); page
DOM lives in an out-of-process renderer that AX/per-pid events don't
reach. For page-content demos, record with `--no-cursor` and drive
with `--target-window` (HID mode) - the user's cursor moves during the
take, but the highlights stage's synthetic cursor sprite keeps the video
clean.

For Chrome element discovery: OCR is more reliable than AX. Navigate
via URL bar (`cmd+l` → type → `return`) is more deterministic than
chasing SPA nav links.

## Out of scope

Mobile (use `mobile-recorder-skill`); Linux/Windows; direct upload;
AI voiceover / music; GUI video editor.
