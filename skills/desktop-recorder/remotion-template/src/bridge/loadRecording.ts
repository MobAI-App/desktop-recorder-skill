// The bridge: turn the deskagent recording contract (recording.manifest.json +
// timeline.json + optional screenplay.json) into Remotion-ready, frame-indexed
// props. Runs in `calculateMetadata` (Node at render, browser in Studio), so it
// reads via fetch(staticFile(...)) - put the three JSON files in public/.
//
// Coordinate space: events keep the recording's window CG-point coords (the
// same space the video pixels live in), so a <Cursor>/<ClickRipple> placed
// inside <RecordingStage> lines up with the footage regardless of how the
// creative composition scales/positions the stage.

import {staticFile} from 'remotion';

export type RecEvent = {kind: 'click' | 'move'; frame: number; x: number; y: number};
export type RecScene = {id: string; startFrame: number; endFrame: number};
export type RecCaption = {text: string; startFrame: number; endFrame: number; y: number; align: string};

export type Recording = {
  fps: number;
  durationInFrames: number;
  speed: number; // playback speedup; events + duration are already scaled by it
  stageWidth: number; // recording window, CG points
  stageHeight: number;
  videoSrc: string;
  events: RecEvent[];
  scenes: RecScene[];
  captions: RecCaption[];
};

async function getJSON(file: string): Promise<any | null> {
  try {
    const res = await fetch(staticFile(file));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function loadRecording(
  fps = 30,
  opts: {speed?: number; videoFile?: string} = {},
): Promise<Recording> {
  const speed = opts.speed ?? 1;
  const videoFile = opts.videoFile ?? 'rec.mp4';
  const manifest = await getJSON('recording.manifest.json');
  const timeline = (await getJSON('timeline.json')) ?? [];
  const screenplay = await getJSON('screenplay.json');
  if (!manifest) throw new Error('public/recording.manifest.json not found');

  const clip = manifest.clips[0];
  const t0 = clip.startWallclockMs;
  const endWall =
    clip.endWallclockMs && clip.endWallclockMs > 0 ? clip.endWallclockMs : t0 + clip.lastFramePtsNs / 1e6;
  // speed > 1 plays the footage faster: scale duration + event frames down,
  // and the card plays the video at the matching playbackRate so they stay synced.
  const durationInFrames = Math.max(1, Math.round((((endWall - t0) / 1000) * fps) / speed));
  const [, , stageWidth, stageHeight] = clip.frameCG; // window size in CG points
  const toFrame = (wallMs: number) => Math.round((((wallMs - t0) / 1000) * fps) / speed);

  const events: RecEvent[] = [];
  const scenes: RecScene[] = [];
  const sceneStart: Record<string, number> = {};
  const actionFrame: Record<string, number> = {};

  for (const e of timeline) {
    if (e.type === 'scene_start') {
      sceneStart[e.scene_id] = toFrame(e.startedAtWallclockMs);
    } else if (e.type === 'scene_end') {
      scenes.push({id: e.scene_id, startFrame: sceneStart[e.scene_id] ?? 0, endFrame: toFrame(e.endedAtWallclockMs)});
    } else if (e.type === 'action') {
      const startF = toFrame(e.startedAtWallclockMs);
      const endF = toFrame(e.endedAtWallclockMs);
      actionFrame[e.action_id] = startF;
      const positional = e.action === 'click' || e.action === 'move' || (e.action || '').startsWith('pointer');
      if (positional && Array.isArray(e.path) && e.path.length > 0) {
        // Expand the trajectory polyline into per-point events spread across
        // the action's duration, so the cursor traces it smoothly instead of
        // jumping start->end. Full resolution is fine here - it's JS per frame,
        // not an ffmpeg expression.
        const n = e.path.length;
        e.path.forEach((p: any, j: number) => {
          const fr = n === 1 ? startF : Math.round(startF + (j / (n - 1)) * (endF - startF));
          events.push({kind: 'move', frame: fr, x: p.x, y: p.y});
        });
      } else if (positional && e.x != null && e.y != null) {
        events.push({kind: e.action === 'click' ? 'click' : 'move', frame: startF, x: e.x, y: e.y});
      }
    }
  }
  events.sort((a, b) => a.frame - b.frame);

  const captions: RecCaption[] = [];
  if (screenplay && Array.isArray(screenplay.captions)) {
    for (const c of screenplay.captions) {
      const from = actionFrame[c.fromAction];
      if (from == null) continue;
      const start = from + Math.round(((c.startDelayMs || 0) / 1000) * fps);
      let end: number;
      if (c.toAction != null && actionFrame[c.toAction] != null) {
        end = actionFrame[c.toAction] + Math.round(((c.endDelayMs || 0) / 1000) * fps);
      } else if (c.durationMs != null) {
        end = start + Math.round((c.durationMs / 1000) * fps);
      } else {
        continue;
      }
      captions.push({text: c.text, startFrame: start, endFrame: end, y: c.y ?? 0.88, align: c.align ?? 'center'});
    }
  }

  return {fps, durationInFrames, speed, stageWidth, stageHeight, videoSrc: staticFile(videoFile), events, scenes, captions};
}

// Cursor position at a frame: linear interpolation between waypoints (matches
// the editor's pointer track), parked before the first / after the last.
export function cursorAt(events: RecEvent[], frame: number): {x: number; y: number} | null {
  if (events.length === 0) return null;
  if (frame <= events[0].frame) return {x: events[0].x, y: events[0].y};
  const last = events[events.length - 1];
  if (frame >= last.frame) return {x: last.x, y: last.y};
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i], b = events[i + 1];
    if (frame >= a.frame && frame < b.frame) {
      const t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
      return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
    }
  }
  return {x: last.x, y: last.y};
}
