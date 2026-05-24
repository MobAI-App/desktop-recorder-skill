# Web driver - `scripts/drive-web.js`

A **CDP-based driver for web page content**. It replaces `deskagent control`
for browser scenes: it talks to Chrome over the DevTools Protocol (zero deps,
Node's built-in `WebSocket`) and emits the **same `timeline.json` contract** as
`deskagent control`, so `deskagent record` and the whole `export.js` pipeline
are unchanged.

## Why it exists

`deskagent control` posts OS-level events (CGEvent / AX). For a browser that
means:

- it can drive the **browser chrome** (tabs, omnibox, buttons) but **not page
  content** reliably - the DOM lives in an out-of-process renderer;
- HID mode requires the window **focused/frontmost** and targets raw pixels.

CDP injects input at the renderer: **no focus, no foreground, the real cursor
never moves**, and you target the DOM by selector. So Chrome can sit unfocused
(even behind other windows) and still be driven while SCK records its window.

**Division of labor:** use the web driver for page content (scroll, click
links, fill forms, draw on a web canvas); use `deskagent control` for the
browser's own UI (omnibox, tabs, extensions, menus) - CDP can't touch those.
A mixed demo can do both against the same Chrome (native posts to its pid;
CDP attaches to its page target).

## Launching the debug Chrome

CDP can't attach to an already-running vanilla Chrome (no debugging port). Launch
a dedicated instance:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \              # REQUIRED on Chrome 111+ or the CDP WebSocket handshake is rejected (403)
  --user-data-dir=/tmp/demo/chrome-profile \ # isolated profile (clean, no extensions)
  --disable-background-timer-throttling \    # keep an UNFOCUSED window compositing
  --disable-renderer-backgrounding \         #   at full rate so scroll/animation
  --disable-backgrounding-occluded-windows \ #   stay smooth while recording
  --window-size=1280,840 --window-position=120,90 \
  --no-first-run --no-default-browser-check \
  --new-window "https://example.com"
```

- The isolated profile is **not logged in** - private/authed pages 404. For
  authed content, point `--user-data-dir` at a persistent profile you logged
  into once.
- Even with the anti-throttle flags an unfocused window caps ~50-55 fps during
  scroll (vs a locked 60 if focused). Hands-off background recording's tradeoff.

## Workflow

Same as the native pipeline, with `drive-web.js` in place of `control`:

```bash
# 1. pre-load so the recording's first frames aren't stale (optional but clean)
node scripts/drive-web.js prenav.json --cdp-port 9222 --window-frame "120,90,1280,840" --timeline /dev/null

# 2. record the (unfocused) Chrome window
deskagent record ./demo/raw --window <ID> --no-cursor --pid-file /tmp/rec.pid &

# 3. drive page content over CDP -> timeline.json
node scripts/drive-web.js screenplay.json \
    --cdp-port 9222 --window-frame "x,y,w,h" \
    --timeline ./demo/raw/timeline.json

# 4. stop + export (unchanged)
kill -INT $(cat /tmp/rec.pid); wait
node scripts/export.js ./demo/raw screenplay.json ./demo/raw/timeline.json demo.mp4 --width W --height H
```

Get `<ID>` and the `--window-frame "x,y,w,h"` (CG points) from `deskagent list`.

## CLI

```
node scripts/drive-web.js <screenplay.json>
    --cdp-port 9222                 # debug port (default 9222)
    --window-frame "x,y,w,h"        # REQUIRED; CG points from `deskagent list`
    --timeline <out.json>           # REQUIRED; the timeline.json to emit
    [--url-match <substring>]       # pick the page target by URL (default: first page)
```

## Coordinates

The driver writes **window-space CG points** to the timeline (what
`pointToCanvasPixel` expects). It derives the browser chrome height as
`chromeH = window.h - window.innerHeight` and maps viewport CSS px → window
points as `y_window = y_css + chromeH` (x is flush-left, 1:1 at 100% page zoom).

So in a screenplay, **raw `x`/`y` and all `path`/`shape` points are window CG
points**; selector/text targets are resolved to their element centre and
mapped for you.

## Actions

Targets resolve by `selector` (CSS) **or** `text` (+ optional `tag`, default
`h1..h6`; matches visible elements only, so GitHub's duplicate mobile/desktop
rows don't trip it) **or** raw window `x`/`y`.

| Action | Fields | Notes |
|---|---|---|
| `wait` | `ms` | Idle. |
| `navigate` | `url`, `timeoutMs?` | `Page.navigate`, waits for load. |
| `wait_for` | `selector`/`text`, `timeoutMs?` | Poll until the element exists. |
| `scroll_to` | `selector`/`text`, `smooth?` | `scrollIntoView` (block:center); settles by polling the element's own rect, so it works in inner scroll containers (e.g. GitHub blob view). Emits the element centre. |
| `scroll` | `dx`/`dy`, `settleMs?` | Relative `scrollBy` (smooth). |
| `scroll_page` | `dy?`, `durationMs?` | One continuous rAF scroll (easeInOutQuad) over `durationMs`; omit `dy` to scroll to the bottom. Use ONE for a smooth page tour (don't chain several - that stutters). |
| `click` | target, `scroll?`, `settleMs?` | Real `mousePressed`/`Released`. Drives a click event (ripple + pointer-hand in the editor). |
| `move` | target **or** `path`/`shape`, `durationMs?`, `scroll?` | Non-clicking cursor waypoint to draw the eye. `durationMs` = glide time. With `path`/`shape`, traces a trajectory (see below). |
| `pointer_down` | target | Press and hold (button state on). |
| `pointer_move` | target **or** `path`/`shape`, `durationMs?` | Move while held (drag) - compose strokes/gestures. |
| `pointer_up` | target? | Release (defaults to current position). |
| `key` | `key` | `Escape`/`Enter`/`Tab`/`ArrowUp/Down`/`PageUp/Down`. |
| `type` | `text`, `selector?`, `perCharMs?` | `Input.insertText` per char; focuses `selector` first. |

### Trajectories (`path` / `shape`)

`move` and `pointer_move` accept a trajectory instead of a single point:

```jsonc
{ "action": "pointer_move", "path": [ {"x":110,"y":130}, {"x":400,"y":130} ], "duration_ms": 600 }   // polyline (window pts)
{ "action": "move", "shape": "circle", "cx": 640, "cy": 470, "r": 180, "points": 48, "duration_ms": 2200 }
{ "action": "move", "shape": "line",   "x1": 100, "y1": 100, "x2": 400, "y2": 100 }
```

`shape` is authoring sugar (`circle` params: `cx`,`cy`,`r`,`points?`,`turns?`,
`startDeg?`,`ccw?`; `line`: `x1,y1,x2,y2`) - it compiles to a polyline; the
timeline only ever carries points. The cursor traces the polyline at constant
speed over `duration_ms`.

**Drawing on a web canvas** (e.g. jsPaint, Excalidraw): select the tool, then
`pointer_down → pointer_move(path/shape) → pointer_up` is one continuous stroke.
Same vocabulary as native `control`, so screenplays port across native and web.
