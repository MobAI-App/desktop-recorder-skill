# Editing & export (desktop / web)

The final demo video is produced from two inputs:

- `demo.raw.mp4` — the native screen recording, untouched
- `timeline.json` — every action that happened during `record_start → record_stop`

The agent does not improvise during editing. Each edit operation is derived from the timeline.

## Operations (in order)

1. **Trim head** — drop everything before the first non-`record_start` event.
2. **Trim tail** — drop everything after the last action's `timeMs` + a small `tail_padding_ms` (default 600).
3. **Speed up technical waits** — for each `wait` event with `reason: "technical"`, re-time that segment at 2× to 4× (default 3×). *Deferred MVP feature; current `export_video.sh` trims tightly but plays back at 1×.*
4. **Preserve viewer-readability waits** — never speed up `wait` events with `reason: "viewer_readability"`.
5. **Add click highlights** — render a soft ripple at `(x, y)` for each `click` event (default duration 480 ms).
6. **Add scroll trails** — render a fading trail from `(x, y)` to `(x2, y2)` matching `durationMs` (optional).
7. **Add captions** — for each event with a `caption`, draw a bottom-third caption from that event's `timeMs` to the next caption event (or `record_stop`). Captions are written to a `<out>.captions.json` sidecar and burned in only if ffmpeg has the `drawtext` filter (libfreetype).
8. **Crop / fit** — letterbox or crop to the target `format` (`horizontal_16_9` by default for desktop).
9. **Export** — H.264, yuv420p, fps 60 if source is 60, otherwise 30; AAC audio if present.

Steps 1–4 are handled by `scripts/export_video.sh`. Steps 5–6 are handled by `scripts/add_highlights.js`. Steps 7–9 are handled at the end of `export_video.sh`.

Run order:

```bash
node scripts/add_highlights.js demo.raw.mp4 timeline.json demo.highlights.mp4
bash scripts/export_video.sh demo.highlights.mp4 timeline.json demo.horizontal.mp4 horizontal_16_9
```

## Highlight rules

- Click → soft circular ripple, ~3% of the recording's short edge in diameter (typically ~30–40 px on a 1920×1080 capture).
- The system cursor is already visible in the recording — do NOT draw a separate cursor halo.
- Scroll → optional fading trail along the path. Off by default for tight demos; useful for tutorials.
- Optional zoom-on-region for clicks tagged with `intent` containing `"zoom"` (deferred MVP feature).

## Caption rules

- short — under 8 words by default
- one caption visible at a time
- bottom third of the frame; move to top third only if a caption overlaps a critical UI element
- captions are editable — `add_highlights.js` writes a `<out>.captions.json` sidecar so a human can tweak the text before re-encoding
- font: system sans-serif, weight 700, ~32 px at 1920-wide horizontal, scaled proportionally for other formats

`captions.json` schema:

```json
[
  { "startMs": 1500, "endMs": 4200, "text": "Open Settings" },
  { "startMs": 4200, "endMs": 6200, "text": "Create your first project" }
]
```

If the user edits the sidecar, re-run the export with `--captions <out>.captions.json` to override.

## Export formats

```yaml
horizontal_16_9: { width: 1920, height: 1080 }
square_1_1:      { width: 1080, height: 1080 }
vertical_9_16:   { width: 1080, height: 1920 }
```

Default → `horizontal_16_9`. The user may override (`square_1_1` for Instagram feed posts; `vertical_9_16` is uncommon for desktop but possible).

## Window-and-zoom prep matters more than crop

A clean export starts with a tight capture region. macOS captures the full screen; if the demo target is a 1440×900 browser window inside a 3456×2234 retina display, the export will downscale a lot of empty pixels. Prefer to size the demo window so its visible content fills most of the capture region before recording, and crop only the menu bar / taskbar in post.

## ffmpeg primitives used by the export script

For reference (the script wraps these):

- Trim: `ffmpeg -ss <start> -to <end> -i raw.mp4 -c copy trimmed.mp4`
- Crop + scale: `ffmpeg -i in.mp4 -vf "crop=w:h:x:y,scale=W:H,setsar=1" out.mp4`
- Speed up a segment: `ffmpeg -i seg.mp4 -filter:v "setpts=PTS/3" -filter:a "atempo=3.0" sped.mp4`
- Concat: `ffmpeg -f concat -safe 0 -i list.txt -c copy concat.mp4`
- Burn caption: `ffmpeg -i in.mp4 -vf "drawtext=text='...':...:enable='between(t,a,b)'" out.mp4`

## copy.md generation

`scripts/generate_copy.js` reads `timeline.json` + the original user prompt and produces:

```md
# Title
<one-line headline drawn from the strongest caption>

# Short post
<2–3 sentences summarizing the flow>

# YouTube Shorts title
<short, hook-first phrasing>

# Thumbnail text
<3–5 words, large-text safe>
```

Use the first caption as the title hook by default. If captions are missing, fall back to `intent` fields.
