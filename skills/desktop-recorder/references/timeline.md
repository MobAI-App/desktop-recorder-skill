# Timeline metadata (desktop / web)

Every action the script runs during `record_start → record_stop` becomes one `DemoTimelineEvent`. The export pipeline reads these events to drive captions, click highlights, and (eventually) speed-up of technical waits.

## Schema

```ts
type DemoTimelineEvent = {
  timeMs: number                  // ms since record_start
  type:
    | "record_start"
    | "record_stop"
    | "click"
    | "type"                      // keyboard input
    | "paste"                     // clipboard insert
    | "scroll"
    | "wait"                      // explicit pause
    | "caption"                   // standalone caption marker

  intent?: string                 // "Create project"
  caption?: string                // "Create your first project"

  x?: number                      // CG screen *points* in `coordinate_space`
  y?: number
  x2?: number                     // scroll endpoint (same space as x/y)
  y2?: number
  coordinate_space?: "window" | "screen"

  durationMs?: number             // wait, scroll duration
  text?: string                   // typed/pasted text
  reason?: "technical" | "viewer_readability"
}
```

## How the runtime emits events

The desktop runtime executes the JSON script step by step and owns event emission. It must:

1. Emit `{ timeMs: 0, type: "record_start" }` when it processes the `record_start` action.
2. For each subsequent action that has a visual effect, capture `timeMs` (ms since `record_start`) and emit one event using the action's `intent`, `caption`, `x`, `y`, etc.
3. Emit `{ timeMs: <elapsed>, type: "record_stop" }` when it processes the `record_stop` action.

All actions are coordinate-based (deskagent control). If the script used `coordinate_space: "window"`, the runtime resolves window-relative coords to absolute screen coords at click time using the target window's frame, so the value written to the timeline always matches the recorded pixels.

### Coordinate space

Coordinates in `timeline.json` are in **CG screen points** (not pixels)
and are interpreted in `coordinate_space` (`"window"` or `"screen"`) —
exactly as the control script wrote them.

Conversion to source pixels happens at overlay time. The recorder writes
`<output>.meta.json` next to the video with the recording's `backingScale`
and the captured window's `frameCG`; `add_highlights.js` reads it and
maps each event's `(x, y)` into the raw mp4's pixel grid:

```
if coordinate_space == "window":
    pixel = point * backingScale
else:  # "screen"
    pixel = (point - windowOriginCG) * backingScale
```

This way the same `timeline.json` and the same script work on retina and
non-retina captures without re-running the control step.

### Invariants

1. The first event has `timeMs: 0` and `type: "record_start"`.
2. `timeMs` is measured from `record_start`, in milliseconds, monotonically increasing.
3. The last event before `record_stop` is the final user-visible action.
4. The final event has `type: "record_stop"` and a `timeMs` equal to the elapsed recording duration.

## Example

```json
[
  { "timeMs": 0,    "type": "record_start" },
  { "timeMs": 1500, "type": "click", "x": 812,  "y": 522, "intent": "Open Settings", "caption": "Open Settings" },
  { "timeMs": 2200, "type": "wait",  "durationMs": 700, "reason": "viewer_readability" },
  { "timeMs": 2900, "type": "type",  "text": "Demo project", "intent": "Name the project" },
  { "timeMs": 4200, "type": "click", "x": 940,  "y": 710, "intent": "Create",  "caption": "Create your first project" },
  { "timeMs": 5200, "type": "wait",  "durationMs": 1000, "reason": "technical" },
  { "timeMs": 6200, "type": "record_stop" }
]
```

## How the exporter uses the timeline

| Field | Used for |
|---|---|
| `type: "click"` + `x,y` | render a click ripple at that pixel coordinate |
| `type: "scroll"` + endpoints | render a motion trail (optional) |
| `intent` | tooltip / fallback caption when none provided |
| `caption` | floating caption overlay; on screen from this event to the next caption event (or `record_stop`) |
| `reason: "technical"` on `wait` | candidate for speed-up during edit (deferred MVP feature) |
| `reason: "viewer_readability"` on `wait` | preserve at 1× — never speed up |
| `timeMs` of first action | trim point for the start of the final video |
| `timeMs` of last non-wait action | trim point for the end of the final video |

## Validation rules

Before export, verify:

- `timeline.json` parses as JSON
- exactly one `record_start` and one `record_stop`
- `timeMs` is non-decreasing
- every `click` has both `x` and `y`
- every `scroll` has both endpoints and `durationMs`
- every `wait` has `durationMs` and a `reason`

If any of these fail, do not export — fix the timeline-emit step and re-run (no need to re-record; the source mp4 is unchanged).
