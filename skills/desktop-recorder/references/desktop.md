# Screenplay format

The screenplay is the single source of truth for a demo: scenes of
actions to execute, plus per-scene editing directives (`caption`,
`zoom`, `speed`) and a top-level `trim`. `deskagent control` reads
only `scenes[].actions[]`; the editing scripts read everything.

See [`deskagent.md`](./deskagent.md) for the CLI,
[`timeline.md`](./timeline.md) for the execution-event schema,
[`editing.md`](./editing.md) for the editing pipeline.

## Top-level shape

```json
{
  "schema_version": 1,
  "name": "demo1",
  "coordinate_space": "window",
  "timeout_ms": 30000,
  "sample_mouse_ms": 16,

  "scenes": [ /* ... */ ],

  "trim": { "beforeScene": "<sceneId>", "afterScene": "<sceneId>" }
}
```

| Field | Required | Purpose |
|---|---|---|
| `schema_version` | yes | Currently `1`. Wrong value → hard error. |
| `coordinate_space` | no (`screen`) | `"window"` resolves x/y against the executor's window origin — recommended. |
| `timeout_ms` | no | Total budget for the run; override at CLI with `--timeout-ms`. |
| `sample_mouse_ms` | no | Mouse-path sampling cadence (HID-mode demos). |
| `scenes` | yes | Ordered execution units. |
| `trim` | no | Scene IDs that bound the final video. Defaults: first scene, last scene + 600 ms pad. |

## Scenes

```jsonc
{
  "id": "open_settings",            // unique within the screenplay
  "caption": "Open Settings",       // viewer-facing; spans the whole scene
  "note":    "verify panel state",  // author/debug only; never rendered

  "zoom":  { "scale": 2.0, "follow_cursor": true },
  "speed": 5.0,

  "actions": [
    { "action": "click", "x": 244.5, "y": 54.5 },
    { "action": "wait",  "ms": 600 }
  ]
}
```

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Canonical scene reference. Used in `actionId = "<sceneId>/<index>"`, `trim.*Scene`, directive ranges. |
| `caption` | no | Rendered by `add_highlights.js` across `[scene tStart, scene tEnd)`. |
| `note` | no | Skipped by every consumer. |
| `zoom`  | no | See below. |
| `speed` | no | See below. |
| `actions` | yes | One or more `Action` records executed in order. |

## Actions (execution-only)

```jsonc
{ "action": "wait",         "ms": 500 }
{ "action": "move",         "x": 1, "y": 2, "duration_ms": 250 }
{ "action": "click",        "x": 10, "y": 20, "button": "left" }
{ "action": "double_click", "x": 30, "y": 40 }
{ "action": "drag",         "x": 0, "y": 0, "to_x": 100, "to_y": 200 }
{ "action": "type",         "text": "hello" }
{ "action": "key",          "combo": "cmd+s" }
{ "action": "scroll",       "dx": 0, "dy": -3 }
```

No `intent` / `caption` / `zoom` fields on actions — those live on the
scene. Action records are pure execution.

`coordinate_space` is screenplay-wide (`"window"` or `"screen"`); the
executor adds the resolved window origin at runtime for `"window"`.

## Editing directives

### `zoom` (scene-level)

```jsonc
"zoom": {
  "scale":         2.0,          // > 1; required
  "follow_cursor": true,         // optional; default false
  "x": 244.5, "y": 54.5,         // optional center override
  "coordinate_space": "window",  //   (defaults to top-level)
  "fromAction": "scene/0",       // optional half-open sub-range
  "toAction":   "scene/2"        //   excludes toAction
}
```

- Without `fromAction`/`toAction`: zoom covers the whole scene range.
- Without `x`/`y`: the first action in the range with `x`/`y` is used
  as the centre. Pure-`wait` scenes need an explicit centre.
- `follow_cursor: true`: camera tracks click positions inside the
  segment with deadzone+EMA (cursor "pushes invisible walls").

### `speed` (scene-level)

```jsonc
"speed": 5.0
// or:
"speed": { "factor": 5.0, "fromAction": "scene/0", "toAction": "scene/2" }
```

Factor `> 1` plays faster, `< 1` slower. Sub-range scoping mirrors zoom.
`add_speedups.js` builds a piecewise warp; the resulting `timewarp.json`
is consumed by `export_video.js` for trim math.

### `trim` (top-level)

```jsonc
"trim": { "beforeScene": "intro", "afterScene": "outro" }
```

Head trim = `beforeScene`'s `tStart`. Tail trim = `afterScene`'s
`tEnd + 600 ms`. Both fields default to first/last scene.

## Validation (Swift, on load)

- `schema_version == 1`.
- Scene IDs unique.
- All actions have a valid `action` kind (the eight above).

Editing scripts additionally validate:

- Every referenced `fromAction` / `toAction` resolves.
- Every referenced scene id resolves.
- Multi-window meta requires `--target-window <id>`.

## `setup` / `preflight` / `validate` (informational)

Authors may add free-form `setup`, `preflight`, `validate` arrays at the
top level for their own bookkeeping (open-app shell commands,
`deskagent assert` probes, post-demo verifications). Neither
`deskagent control` nor the editing scripts read them — they're notes
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
| `horizontal_16_9` (1920×1080) | 1440×900 @ 1× retina |
| `square_1_1` (1080×1080) | 1080×1080 centered crop |
| `vertical_9_16` (1080×1920) | 540×960 |

Pick the window size BEFORE exploration so click coords stay valid.

Worked example: [`assets/examples/notes-demo.json`](../assets/examples/notes-demo.json).
