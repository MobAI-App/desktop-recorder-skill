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
  x?: number               // CG screen points in coordinate_space
  y?: number
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

Every editing script anchors via:

```
videoSec = (event.startedAtWallclockMs - meta.firstFrameWallclockMs) / 1000
```

`firstFrameWallclockMs` lives in the recording's `<out>.meta.json`
sidecar. Editing scripts read both files; the agent never computes
this by hand.

## Joining timeline to screenplay

Both files agree on `scene_id`. Action references in screenplay
directives (`fromAction`, `toAction`) use the canonical `action_id =
"${scene_id}/${action_index}"`. Resolution is hard-failure on the
editing side - missing IDs print the available IDs and exit non-zero.

## Coordinate space

`x` / `y` are CG screen **points** (not pixels) in the declared
`coordinate_space`. Editing scripts map to canvas pixels via the meta
sidecar's `canvasRect` for the chosen `--target-window`:

```
windowSpace:  pixel = canvasRect.x + point * canvasRect.w / frameCG.w
screenSpace:  pixel = canvasRect.x + (point - frameCG.x) * canvasRect.w / frameCG.w
```

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
   `firstFrameWallclockMs` is the only video anchor.
