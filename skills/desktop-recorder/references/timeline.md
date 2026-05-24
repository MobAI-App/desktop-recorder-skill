# Timeline event schema

`deskagent control screenplay.json --timeline timeline.json` emits a
flat JSON array of three event types, in execution order:

```ts
type TimelineEvent =
  | { type: "scene_start" } & SceneBoundary
  | { type: "scene_end"   } & SceneBoundary
  | { type: "action"      } & ActionEvent

type SceneBoundary = {
  scene_id:     string
  scene_index:  number
  startedAtMs:  number     // ms since control run start
  endedAtMs:    number     // === startedAtMs for boundary events
  startedAtWallclockMs: number    // Unix-epoch ms - anchor for video time
  endedAtWallclockMs:   number
  coordinate_space: "window" | "screen"
}

type ActionEvent = SceneBoundary & {
  action_id:    string     // canonical: "${scene_id}/${action_index}"
  action_index: number
  action:       "click" | "double_click" | "drag"
              | "type"  | "key"          | "scroll"
              | "wait"  | "move"
              | "pointer_down" | "pointer_move" | "pointer_up"
  x?: number               // CG points in coordinate_space (window/screen)
  y?: number
  path?: { x: number, y: number }[]   // trajectory polyline (move/pointer_move);
                                       // the cursor track follows it (linear)
}
```

## Example

```json
[
  { "type": "scene_start", "scene_id": "open_settings", "scene_index": 0,
    "startedAtMs": 500, "endedAtMs": 500,
    "startedAtWallclockMs": 1778883094300, "endedAtWallclockMs": 1778883094300,
    "coordinate_space": "window" },

  { "type": "action", "scene_id": "open_settings", "scene_index": 0,
    "action_id": "open_settings/0", "action_index": 0, "action": "click",
    "startedAtMs": 752, "endedAtMs": 800,
    "startedAtWallclockMs": 1778883094552, "endedAtWallclockMs": 1778883094600,
    "x": 244.5, "y": 54.5, "coordinate_space": "window" },

  { "type": "scene_end", "scene_id": "open_settings", "scene_index": 0,
    "startedAtMs": 850, "endedAtMs": 850,
    "startedAtWallclockMs": 1778883094650, "endedAtWallclockMs": 1778883094650,
    "coordinate_space": "window" }
]
```

## Mapping to video time

Every editing stage anchors via the recording's `recording.manifest.json`.
The editor picks a canvas t=0 from the shared time window across clips
(`t0 = max(clip.startHostNs)` in host time, with the wallclock-equivalent
used to convert timeline events):

```
t0WallMs = wallclock of the clip whose startHostNs == max(startHostNs)
videoSec = (event.startedAtWallclockMs - t0WallMs) / 1000
```

`lib/screenplay.js`'s `loadContext` does this once; stages call
`ctx.actionEvents.get(actionId).tStart` to read canvas-second timings.
The agent never computes this by hand.

## Joining timeline to screenplay

Both files agree on `scene_id`. Action references in screenplay
directives (`fromAction`, `toAction`) use the canonical `action_id =
"${scene_id}/${action_index}"`. Resolution is hard-failure on the
editing side - missing IDs print the available IDs and exit non-zero.

## Coordinate space

`x` / `y` are CG screen **points** (not pixels) in the declared
`coordinate_space`. Editing stages map to canvas pixels via
`ctx.pointToCanvasPixel(e)` which finds the action's window placement
(via the scene's `windowId`) and applies the placement's fitted rect:

```
windowSpace:  pixel = fit.ox + point * fit.fitW / frameCG.w
screenSpace:  pixel = fit.ox + (point - frameCG.x) * fit.fitW / frameCG.w
```

For multi-window compositions, scenes must carry `windowId` so the
scene's actions are mapped to the correct window's slot on the canvas.

## Invariants

1. Events arrive in execution order; `*WallclockMs` is monotone
   non-decreasing.
2. Every `scene_start` is followed by a matching `scene_end` with the
   same `scene_id` / `scene_index`. Actions in between carry that
   `scene_id`.
3. `action_id` is unique across the timeline (since scene IDs are
   unique and action indices are local).
4. `record_start` / `record_stop` markers are NOT in the timeline -
   the screenplay doesn't describe them. The recording's
   `recording.manifest.json` carries per-clip host-time + wallclock
   anchors that the editor uses to compute the shared canvas timeline.
