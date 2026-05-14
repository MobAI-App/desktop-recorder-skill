# Desktop / Web workflow (macOS, deskagent)

This skill drives demos exclusively with [`deskagent`](./deskagent.md):
recording, deterministic input replay, and AX/OCR element discovery.

For the CLI surface itself see [`deskagent.md`](./deskagent.md). For
output processing (trim, highlights, captions, export) see
[`editing.md`](./editing.md). For event timeline schema see
[`timeline.md`](./timeline.md).

## Pipeline

```
User prompt
  ↓
Pick the target window (deskagent list)
  ↓
Discover element coords (deskagent inspect — AX + OCR)
  ↓
Author the JSON script with coordinate_space:"window"
  ↓
Dry-run script with deskagent control --target-window <id> --background
  ↓
Iterate until clean; normalize state
  ↓
Start deskagent record in the background
  ↓
Drive UI with deskagent control --target-window <id> --background
  ↓
SIGINT the recorder
  ↓
Map control timeline → DemoTimelineEvent → highlights + export
```

## Script section rules

The JSON script has `setup`, `preflight`, `recording`, `validate`
sections.

### `recording` is a flat list of deterministic actions

No live observation, no conditionals, no `wait_for`. Every entry is one
deterministic action, with optional `intent` and `caption` for the
exporter to render as captions / tooltips.

```json
{ "action": "click", "x": 321, "y": 56, "intent": "Switch tab", "caption": "Browse tests" }
```

Coordinates use `coordinate_space: "window"` (recommended) or
`coordinate_space: "screen"`. Window-relative coords stay correct when
the user drags the window between recordings.

### Wait reasons are tagged

```json
{ "action": "wait", "ms": 800,  "reason": "technical" }
{ "action": "wait", "ms": 1400, "reason": "viewer_readability" }
```

The exporter speeds up `technical` waits during edit and preserves
`viewer_readability` ones at 1×.

### Setup normalizes everything off-camera

The `setup` section should handle:

- launch the app (`open -a "App Name"` via `shell` action)
- set window size and position
  (`osascript -e 'tell app "System Events" to tell process "App" to set size/position of window 1 to {…}'`)
- close extra tabs / panes
- log in (prefer programmatic / API where possible)
- navigate to the starting screen
- preload required data
- set theme (light/dark) if relevant
- hide bookmarks bar, sidebars, dev tools

The `recording` section must NOT include setup unless the user
explicitly asks to show it on camera.

## Element discovery

Before writing coordinates into the script, run
`deskagent inspect --window <id> --json` and extract centers from the
AX walk (native elements) or OCR pass (any rendered text — includes
Wails / Electron WebViews).

Convert center coords to window-relative for the script:

```bash
deskagent inspect --window $ID --json \
  | jq --arg label "Submit" '
      .windowFrame as $wf
      | (.ax + .ocr)[]
      | select(.label == $label)
      | { label, x: (.center[0] - $wf[0]), y: (.center[1] - $wf[1]) }
    '
```

For full discovery + click recipes see
[`deskagent.md → Discovery`](./deskagent.md#discovery-deskagent-inspect).

## Canonical script skeleton

```json
{
  "name": "<demo_name>",
  "format": "horizontal_16_9",
  "window": { "width": 1440, "height": 900 },
  "sections": {
    "setup": [
      { "action": "shell", "cmd": "open -a 'My App'", "reason": "technical" },
      { "action": "wait", "ms": 1500, "reason": "technical" }
    ],
    "preflight": [
      { "action": "inspect_required_text", "label": "Welcome" }
    ],
    "recording": [
      { "action": "record_start" },
      { "action": "click", "x": 320, "y": 180, "intent": "Start demo", "caption": "Start in seconds" },
      { "action": "wait",  "ms": 700, "reason": "viewer_readability" },
      { "action": "type",  "text": "Demo Project" },
      { "action": "wait",  "ms": 300, "reason": "technical" },
      { "action": "click", "x": 540, "y": 410, "intent": "Create project", "caption": "Create your first project" },
      { "action": "wait",  "ms": 1000, "reason": "viewer_readability" },
      { "action": "record_stop" }
    ],
    "validate": [
      { "action": "inspect_required_text", "label": "Dashboard" }
    ]
  }
}
```

A worked example: [`assets/examples/notes-demo.json`](../assets/examples/notes-demo.json).

## Web app demos

Same pipeline. Use `shell` + `open` to launch the browser at the URL,
let the page render, then drive clicks/typing via `deskagent control`
using OCR-derived coords for buttons and text fields.

```json
{ "action": "shell", "cmd": "open -a 'Safari' 'https://example.com/app'", "reason": "technical" },
{ "action": "wait", "ms": 2000, "reason": "technical" }
```

Programmatic login is preferred over typing credentials on camera —
either via the app's API or a curl call in `setup`.

## Window and zoom guidance

| Format | Recommended window | Notes |
|---|---|---|
| `horizontal_16_9` (1920×1080) | 1440×900 with 1.0× zoom on retina | export upscales cleanly |
| `square_1_1` (1080×1080) | 1080×1080 centered crop | record full window, crop in export |
| `vertical_9_16` (1080×1920) | 540×960 window | uncommon for desktop demos; usually mobile |

Always pick the window size **before** exploration so coordinates
collected match the recording.
