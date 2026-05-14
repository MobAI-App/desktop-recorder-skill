---
name: desktop-recorder
description: Use this skill when the user asks to record, create, produce, or export a screencast or demo video of a **desktop app or web app on macOS** — for launch, marketing, Product Hunt, social posts, landing-page videos, internal walkthroughs. Triggers on "record a screencast", "screen recording", "desktop app demo", "web app demo", "record this Mac app", "make a screencast", "marketing video for the app", "record my Mac screen", "record Chrome", "record Safari". Enforces an exploration-first workflow — explore → script → dry-run → record → edit/export — and produces a deterministic JSON script, native ScreenCaptureKit recording via `deskagent`, timeline metadata, captions, click highlights, and upload copy. macOS only. For mobile (iOS/Android) demos, use the sibling `mobile-recorder-skill` instead.
---

# Desktop Recorder

## Promise

Turn a prompt describing a desktop or web demo into a polished, reproducible screencast — plus a saved JSON script that can be re-recorded any time.

**macOS only.** Built on `deskagent` (ScreenCaptureKit recorder + AXPress driver + Vision OCR). The skill assumes `deskagent` is installed and on PATH; if not, point the user at `install.md` in the repo.

## The golden rule

**Never improvise during the final recording.**

Correct flow:

```
explore → script → dry-run → record → edit/export
```

Wrong flow (produces ugly, glitchy video):

```
start recording → observe → think → click → observe → think → click
```

The agent is allowed to be slow and uncertain during exploration. Once recording starts, every action must be pre-decided and pre-timed.

---

## Core rules

### Rule 1 — Explore first

Before writing the script, explore the workflow end-to-end. Allowed tools during exploration:

- `deskagent list --json` to find the target window
- `deskagent inspect --window <id> --json` to discover element coords (AX walk + Vision OCR)
- `screencapture -l <id>` for visual reference
- `osascript` against the app's accessibility tree if it exposes one
- Trial-and-error `deskagent control` runs against the live UI to confirm coords land

Exploration must collect, at minimum:

- the exact click sequence — coords from `deskagent inspect`, in window-relative space
- per-action waits (technical vs. viewer-readability)
- demo data to use
- popups / cookie banners / first-run dialogs that need to be normalized in setup
- the window size the recording will use (pin it before exploration so coords stay valid)
- the start state and final state
- moments that deserve a caption or callout

### Rule 2 — Generate a deterministic JSON script

The script is a JSON file with `setup`, `preflight`, `recording`, and `validate` sections. `setup` normalizes state off-camera; `recording` is the take, bracketed by `record_start` / `record_stop`. Every step in `recording` is one deterministic action with optional `intent` and `caption`.

Coordinate space: prefer `coordinate_space: "window"` so the script keeps working when the user drags the window. Pair with `--target-window <id>` at run time.

**No live observation inside `recording`.** No "observe → reason → click" loops. No conditionals. Each step is a single deterministic action that was decided during exploration.

Timeline metadata: each `recording` step carries inline `intent` and `caption` fields. The runtime emits one `DemoTimelineEvent` per step.

Recording is started and stopped **outside** the script. The agent:

1. starts `deskagent record` in the background (PID file written for clean stop);
2. runs the script via `deskagent control --target-window <id> --background`;
3. SIGINTs the recorder when the script's `record_stop` action fires.

### Rule 3 — Dry-run before recording

Run the full script in dry-run mode (no recorder running). Verify each step lands by inspecting the UI between steps or after the run. If it fails:

1. capture a screenshot at the failure
2. fix the script (coords from a fresh `deskagent inspect`, or timing, or pre-recording state normalization)
3. dry-run again

Do not record until a clean dry-run passes end-to-end.

### Rule 4 — Native recording only for the final take

Final output uses `deskagent record` — ScreenCaptureKit, per-window or multi-window composited, HEVC `.mp4` (or ProRes `.mov`), SIGINT-clean. Captures occluded windows.

The canonical pipeline:

1. `deskagent inspect --window $ID --json` → element coords (use OCR for Wails/Electron WebView UIs)
2. Author the script with `coordinate_space: "window"`
3. Start `deskagent record … --window $ID --no-cursor --pid-file …` in the background
4. Drive with `deskagent control script.json --target-window $ID --background --no-activate` — `--background` uses AXPress for clicks + per-PID for keys, leaving the user's cursor and frontmost app untouched while the recording runs
5. `kill -INT $(cat <pid-file>); wait`

macOS prompts for Screen Recording permission the first time `deskagent` runs (System Settings → Privacy & Security → Screen Recording). Driving the desktop with `deskagent control` additionally needs Accessibility permission. `deskagent doctor` reports both.

### Rule 5 — No recovery inside the final recording

If the final take fails:

1. stop recording
2. discard the failed take
3. fix the script
4. re-record from scratch

Live recovery during recording makes ugly video.

---

## End-to-end workflow

```
1. Read the prompt → identify the macOS app, the key flow, the vibe.
2. Pick window size BEFORE exploration so coords stay valid.
3. EXPLORE — `deskagent list` → `deskagent inspect` → note coords/waits/captions.
4. DRAFT JSON script — setup section (normalization), recording section (linear actions with intent/caption).
5. NORMALIZE state (close extra tabs, log in, hide bookmarks bar, set theme, navigate to start screen).
6. DRY-RUN the script (no recorder); fix coords / timing until clean.
7. RE-NORMALIZE state.
8. START `deskagent record` in the background; note wall-clock t0.
9. RUN the script via `deskagent control --target-window $ID --background`.
10. STOP recorder (SIGINT).
11. BUILD timeline.json from the control runtime's step events (jq recipe in references/deskagent.md).
12. ADD highlights (click ripples; the cursor isn't in the recording when --no-cursor is used, so ripples are the visual cue).
13. EXPORT horizontal_16_9 (or other target format).
14. WRITE copy.md.
15. SAVE the JSON script + timeline.json next to the video so the demo is reproducible.
```

---

## Outputs

Save outputs in a single demo folder (default: `./demo-out/<name>/`):

```
demo.script.json      ← reproducible script
timeline.json         ← per-event metadata
demo.raw.mp4          ← native recording, untouched
demo.highlights.mp4   ← with click ripples
demo.horizontal.mp4   ← final 1920×1080 export
*.captions.json       ← caption track (sidecar)
copy.md               ← upload copy
```

---

## Detailed references

Load these as needed:

- `references/desktop.md` — JSON script format, window/zoom guidance, setup normalization checklist
- `references/deskagent.md` — `deskagent` CLI surface (`list`, `inspect`, `record`, `control`, `doctor`), permission model, the `ControlTimelineEvent → DemoTimelineEvent` mapping recipe, color/range internals
- `references/timeline.md` — `DemoTimelineEvent` schema and how the runtime should emit it
- `references/editing.md` — trimming, highlights, captions, speed-up rules, export presets

## Example scripts

- `assets/examples/notes-demo.json` — native macOS app demo (Notes, deskagent control with window-relative coords)

## Templates

- `assets/templates/copy-template.md` — title / short post / Shorts title / thumbnail
- `assets/templates/captions-template.json` — caption track shape

## Helper scripts

- `deskagent record <out> --window <id> --pid-file <pid>` — capture. Discover IDs with `deskagent list --json`. Full surface in `references/deskagent.md`.
- `deskagent control <script> --target-window <id> --background --timeline <path>` — drive the UI. Writes `ControlTimelineEvent[]`. Map to the exporter's `DemoTimelineEvent` schema via the jq recipe in `references/deskagent.md`.
- `deskagent inspect --window <id> --json` — discover clickable elements (AX + Vision OCR).
- `scripts/export_video.sh <raw.mp4> <timeline.json> <out.mp4> <format>` — trim + crop + final export. Format typically `horizontal_16_9`.
- `scripts/add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [--ripple-color rgba]` — render click ripples from timeline events. Also writes a `<out>.captions.json` sidecar.
- `scripts/generate_copy.js <timeline.json> <prompt.txt> <copy.md>` — produce upload copy.

`deskagent record` writes a PID file. Stop it with `kill -INT $(cat <pid-file>)` — SIGINT lets the recorder flush a valid mp4; SIGTERM works too; SIGKILL corrupts the file.

---

## Authorization rule

Driving a user's running apps with `deskagent control` can affect their workspace (window focus, tab order, frontmost app, open documents). `--background` minimizes the impact (no focus shift, no cursor movement on screen) but still mutates app state. Before touching apps other than the one the user explicitly named for the demo, ask which app to drive and what's in-bounds. If the chosen approach hits a blocker, surface it and ask — don't silently swap to a different app or open new tabs / windows / documents in the user's running apps.

---

## Failure handling at a glance

| Stage | Failure | Action |
|---|---|---|
| Exploration | flow unclear | ask user, or pick a reasonable path and note the assumption in `copy.md` |
| Inspect | `deskagent inspect` returns no useful elements | OCR may need different language packs; try `--ocr-language en-US ru-RU` etc. For a Wails/Electron app, AX walk returns chrome only — that's expected, rely on OCR |
| Dry-run | step fails | `deskagent inspect` again (window may have re-rendered), fix the coord, re-dry-run |
| Recording | step fails mid-take | SIGINT recorder, discard, fix the script, re-record |
| Validate | wrong final state | discard take, fix script, re-record |
| Export | ffmpeg error | re-read timeline, check format defaults in `references/editing.md` |
| Color crush in output | known issue with full-range YUV in TV-tagged stream | Update to deskagent ≥ 0.1.0 — single-source path bypasses CI render, multi-source path pre-scales RGB to TV-range via CIColorMatrix |
| macOS prompts for Screen Recording every release | ad-hoc signing — fresh identity per release | Re-grant once and skip the warning; or build deskagent locally with a stable self-signed cert |

---

## Not in scope (use a different skill / tool)

- Mobile (iOS / Android) demos → use the sibling `mobile-recorder-skill`.
- Linux / Windows recording — `deskagent` is macOS-only.
- Direct upload to YouTube / TikTok / X.
- AI voiceover or background music.
- A full GUI video editor.
