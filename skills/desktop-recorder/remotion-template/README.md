# Remotion bridge template

Turn a deskagent recording into a Remotion motion-graphics video. The **bridge**
(`src/bridge/`) does the integration; you only edit the creative composition
(`src/Demo.tsx`).

This is an **optional** path, separate from the lean ffmpeg `export.js` pipeline.
It needs Node + Remotion installed (heavier deps, headless Chrome). Use it when
you want React-grade motion graphics around the footage.

## Use

1. **Copy** this folder into a working dir and `npm install`.
2. **Feed the recording** into `public/` (the contract from `deskagent record` +
   the web/native driver):
   - `public/rec.mp4` - the clip, transcoded to a browser codec:
     `ffmpeg -i raw/window-<id>.mov -vf scale=<w>:<h> -c:v libx264 -pix_fmt yuv420p -an public/rec.mp4`
   - `public/recording.manifest.json` - from the recording dir
   - `public/timeline.json` - from the driver (`deskagent control` or `drive-web.js`)
   - `public/screenplay.json` - optional, for captions
3. **Render**: `npx remotion render Demo out/video.mp4`
   (first run: `npx remotion browser ensure` to fetch the headless shell).
4. **Iterate** in `npx remotion studio`.

## The bridge (`src/bridge/`)

- `loadRecording(fps, {speed?, videoFile?})` - reads the contract (via
  `fetch(staticFile(...))`, so it runs in `calculateMetadata`) and returns
  frame-indexed props: `fps`, `durationInFrames`, `speed`, `stageWidth/Height`
  (recording window in CG points), `videoSrc`, `events` (clicks/moves as
  `{frame,x,y}`), `scenes`, `captions`. `speed > 1` plays the footage faster -
  duration and event frames are scaled down to match; pass `rec.speed` to
  `<RecordingCard playbackRate>` so the cursor stays synced with the video.
- `<RecordingStage width height>` - the recording's coordinate space. Put the
  card + cursor + ripples inside; the creative comp scales/positions the stage
  as one unit and everything stays aligned with the footage.
- `<RecordingCard src width height playbackRate?>` - the `<OffthreadVideo>`, framed.
- `<Cursor events>` / `<ClickRipple events>` - timeline-driven, in stage coords.
- `<Caption captions>` - output-canvas captions (`y`/`align` honored).

`Root.tsx` wires `loadRecording` into `calculateMetadata`, so the composition
duration comes from the recording and `Demo` receives the parsed `rec` prop.
Coordinates: `timeline` x/y are recording-window CG points = the video's pixel
space, so cursor/ripples line up without extra mapping.
