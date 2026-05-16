#!/usr/bin/env node
/**
 * Animated zoom for desktop recordings — directives from the screenplay.
 *
 *   node add_zoom.js <input.mp4> <screenplay.json> <timeline.json> <output.mp4> [flags]
 *
 * Opt-in: only scenes that have a `zoom` directive zoom. Each scene's zoom
 * covers the scene's wall-clock range by default; `fromAction`/`toAction`
 * narrows it to a half-open sub-range.
 *
 * Scene-level zoom directive shape:
 *   {
 *     "scale":         2.0,                // peak zoom; required.
 *     "follow_cursor": true,               // optional; default false.
 *     "x": 244.5, "y": 54.5,               // optional center override
 *     "coordinate_space": "window",        //   (defaults to screenplay-level).
 *     "fromAction": "scene1/0",            // optional; sub-range scope.
 *     "toAction":   "scene1/2"             //   half-open (excludes toAction).
 *   }
 *
 * If no center is supplied, the first action in the range with x/y is used.
 *
 * Flags:
 *   --target-window <id>      REQUIRED for multi-window meta sidecars.
 *   --ramp S                  ease-in / ease-out seconds at the range edges (default 0.2).
 *   --deadzone F              fraction of zoomed-view dim cursor may roam before pan (default 0.10).
 *   --follow-smoothing F      EMA alpha for camera catch-up (default 0.5).
 *   --debug                   print the ffmpeg filtergraph on stderr.
 *
 * Pipeline order: highlights → zoom → speedups → export. The meta sidecar must
 * sit beside the INPUT (cp the raw's meta next to the highlighted mp4).
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadContext, propagateSidecars } = require("./lib/screenplay");

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("usage: add_zoom.js <input.mp4> <screenplay.json> <timeline.json> <output.mp4> [flags]");
  process.exit(2);
}
const [INPUT, SCREENPLAY, TIMELINE, OUTPUT] = argv.slice(0, 4);

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
const RAMP             = Number(flag("--ramp", "0.2"));
const DEADZONE         = Number(flag("--deadzone", "0.10"));
const FOLLOW_SMOOTHING = Number(flag("--follow-smoothing", "0.5"));
const TARGET_WINDOW    = (() => { const v = flag("--target-window", null); return v == null ? null : Number(v); })();
const DEBUG            = argv.includes("--debug");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: INPUT,
  screenplayPath: SCREENPLAY,
  timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

// ---------------------------------------------------------------------------
// probe input

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height,r_frame_rate",
  "-of", "csv=p=0", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const [pw, ph, frate] = probe.stdout.toString().trim().split(",");
const srcW = Number(pw), srcH = Number(ph);
const [fNum, fDen] = frate.split("/").map(Number);
const srcFps = Math.round((fNum / (fDen || 1)) * 1000) / 1000;

// ---------------------------------------------------------------------------
// build camera segments from screenplay.scenes[].zoom

const segments = [];

for (const scene of ctx.screenplay.scenes) {
  if (!scene.zoom) continue;
  const z = scene.zoom;
  const scale = Number(z.scale);
  if (!(scale > 1)) {
    console.error(`scene "${scene.id}" zoom.scale must be > 1 (got ${z.scale})`);
    process.exit(2);
  }

  const range = ctx.resolveActionRange({
    sceneId: scene.id,
    fromAction: z.fromAction,
    toAction:   z.toAction,
  });

  // Centre: explicit x/y → use; else first action with x/y in the sub-range.
  let cx, cy;
  if (z.x != null && z.y != null) {
    [cx, cy] = ctx.pointToCanvasPixel({
      x: Number(z.x), y: Number(z.y),
      coordinate_space: z.coordinate_space || ctx.screenplay.coordinate_space || "screen",
    });
  } else {
    const anchor = [...ctx.actionEvents.values()]
      .filter((e) => e.sceneId === scene.id && e.x != null && e.y != null)
      .filter((e) => !z.fromAction || e.tStart >= range.tStart)
      .filter((e) => !z.toAction   || e.tStart <  range.tEnd)
      .sort((a, b) => a.tStart - b.tStart)[0];
    if (!anchor) {
      console.error(`scene "${scene.id}" zoom has no center: provide zoom.x/zoom.y, or include an action with x/y in the range`);
      process.exit(2);
    }
    [cx, cy] = ctx.pointToCanvasPixel(anchor);
  }

  segments.push({
    sceneId: scene.id,
    tStart: range.tStart,
    tEnd:   range.tEnd,
    cx, cy,
    scale,
    followCursor: !!z.follow_cursor,
  });
}

if (segments.length === 0) {
  console.log("No scene-level zoom directives; copying through.");
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT);
  process.exit(r.status ?? 0);
}

console.log(`Camera segments: ${segments.length}`);
for (const s of segments) {
  console.log(`  [${s.tStart.toFixed(2)}s..${s.tEnd.toFixed(2)}s]  scale=${s.scale}  at canvas=(${s.cx.toFixed(0)},${s.cy.toFixed(0)})  scene=${s.sceneId}  follow=${s.followCursor}`);
}

// ---------------------------------------------------------------------------
// cursor path for --follow-cursor segments — interpolate between click events

function buildCursorPath() {
  // Mirror the synthetic-cursor sprite's motion profile from add_highlights.js:
  // idle at click[i-1] until APPROACH_S before click[i], then linear approach.
  // Sample at 30 Hz so the camera-follow EMA has enough resolution.
  const raw = ctx.clickEventsInVideoSeconds()
    .map((c) => ({ t: c.tStart, x: c.canvasX, y: c.canvasY }));
  if (raw.length < 2) return raw;

  const APPROACH_S = 0.45;
  const STEP_S = 1 / 30;
  const out = [{ t: raw[0].t, x: raw[0].x, y: raw[0].y }];

  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1];
    const cur  = raw[i];
    const approachStart = Math.max(prev.t, cur.t - APPROACH_S);
    if (approachStart > prev.t) {
      out.push({ t: approachStart, x: prev.x, y: prev.y });
    }
    const dur = cur.t - approachStart;
    const steps = Math.max(2, Math.floor(dur / STEP_S));
    for (let j = 1; j <= steps; j++) {
      const u = j / steps;
      out.push({
        t: approachStart + u * dur,
        x: prev.x + u * (cur.x - prev.x),
        y: prev.y + u * (cur.y - prev.y),
      });
    }
  }
  return out;
}
const cursorPath = buildCursorPath();

// ---------------------------------------------------------------------------
// build piecewise expressions for scale(t), cx(t), cy(t)

function fmt(n) { return Number(n).toFixed(3); }

// Per-segment amount: ease in over RAMP, hold, ease out over RAMP.
// RAMP is clamped to a quarter of the segment so very short segments still
// pulse in and out instead of being all-ramp.
function amountSubExpr(seg) {
  const dur  = seg.tEnd - seg.tStart;
  const ramp = Math.min(RAMP, dur / 4);
  const t0 = fmt(seg.tStart);
  const t1 = fmt(seg.tStart + ramp);
  const t2 = fmt(seg.tEnd - ramp);
  const t3 = fmt(seg.tEnd);
  return (
    `if(between(t,${t0},${t1}), (t-${t0})/${fmt(ramp)}, ` +
    `if(between(t,${t1},${t2}), 1, ` +
    `if(between(t,${t2},${t3}), 1-(t-${t2})/${fmt(ramp)}, 0)))`
  );
}

// scale = 1 + max_over_segments( (segScale-1) * amount ). ffmpeg's `max` is
// binary so nest for N>2 segments.
function maxNested(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `max(${parts[0]},${parts[1]})`;
  return `max(${parts[0]},${maxNested(parts.slice(1))})`;
}
function scaleExpr() {
  const parts = segments.map((s) => `${fmt(s.scale - 1)}*(${amountSubExpr(s)})`);
  return `1+${maxNested(parts)}`;
}

// Static-centre fallback for non-follow segments.
function staticCenterExpr(coord) {
  let expr = coord === "x" ? "iw/2" : "ih/2";
  const sorted = [...segments].sort((a, b) => a.tStart - b.tStart);
  for (const s of sorted) {
    const c = coord === "x" ? s.cx : s.cy;
    expr = `if(between(t,${fmt(s.tStart)},${fmt(s.tEnd)}), ${fmt(c)}, ${expr})`;
  }
  return expr;
}

// Follow-cursor: precompute camera path with deadzone + EMA (ffmpeg
// expressions are stateless), emit as piecewise interpolation.
function buildFollowCenter(coord) {
  const followSegs = segments.filter((s) => s.followCursor);
  if (followSegs.length === 0) return staticCenterExpr(coord);

  const allPath = []; // [{ t, x, y, segId }]
  for (const seg of followSegs) {
    // Seed at segment start so the camera begins on-target.
    allPath.push({ t: seg.tStart, x: seg.cx, y: seg.cy, segId: seg });

    const inRange = cursorPath.filter((p) => p.t > seg.tStart && p.t <= seg.tEnd);
    if (inRange.length === 0) continue;

    const viewW = srcW / seg.scale;
    const viewH = srcH / seg.scale;
    const dzX = viewW * DEADZONE;
    const dzY = viewH * DEADZONE;
    const alpha = FOLLOW_SMOOTHING;

    let camX = seg.cx, camY = seg.cy;
    const tick = (t, x, y) => {
      const dx = x - camX, dy = y - camY;
      if (Math.abs(dx) > dzX / 2) {
        const tgt = x - Math.sign(dx) * (dzX / 2);
        camX = camX + alpha * (tgt - camX);
      }
      if (Math.abs(dy) > dzY / 2) {
        const tgt = y - Math.sign(dy) * (dzY / 2);
        camY = camY + alpha * (tgt - camY);
      }
      allPath.push({ t, x: camX, y: camY, segId: seg });
    };
    for (const p of inRange) tick(p.t, p.x, p.y);

    // After cursor's last sample, tick at 15 Hz with cursor frozen so EMA
    // converges during the post-click hold (otherwise camera freezes mid-pan).
    const lastSamp = inRange[inRange.length - 1];
    const STEP = 1 / 15;
    let prevCamX = camX, prevCamY = camY;
    for (let t = lastSamp.t + STEP; t <= seg.tEnd; t += STEP) {
      tick(t, lastSamp.x, lastSamp.y);
      if (Math.abs(camX - prevCamX) < 0.5 && Math.abs(camY - prevCamY) < 0.5) break;
      prevCamX = camX; prevCamY = camY;
    }
  }

  // Merge non-follow segments (static centre) on top of the follow path.
  let expr = coord === "x" ? "iw/2" : "ih/2";
  for (const s of segments) {
    if (s.followCursor) continue;
    const c = coord === "x" ? s.cx : s.cy;
    expr = `if(between(t,${fmt(s.tStart)},${fmt(s.tEnd)}), ${fmt(c)}, ${expr})`;
  }
  for (let i = allPath.length - 1; i >= 0; i--) {
    const p = allPath[i];
    const next = allPath[i + 1];
    const c = coord === "x" ? p.x : p.y;
    if (next) {
      const cn = coord === "x" ? next.x : next.y;
      const dt = (next.t - p.t) || 0.001;
      expr = `if(between(t,${fmt(p.t)},${fmt(next.t)}), ${fmt(c)}+(${fmt(cn - c)})*(t-${fmt(p.t)})/${fmt(dt)}, ${expr})`;
    } else {
      const seg = p.segId;
      expr = `if(between(t,${fmt(p.t)},${fmt(seg.tEnd)}), ${fmt(c)}, ${expr})`;
    }
  }
  return expr;
}

// ---------------------------------------------------------------------------
// build zoompan filter

const subT = (s) => s.replace(/\bt\b/g, "out_time");

const zExpr  = subT(scaleExpr());
const cxBase = buildFollowCenter("x");
const cyBase = buildFollowCenter("y");
const cxZP   = subT(cxBase);
const cyZP   = subT(cyBase);
const xZP = `max(0, min(iw - iw/zoom, (${cxZP}) - iw/zoom/2))`;
const yZP = `max(0, min(ih - ih/zoom, (${cyZP}) - ih/zoom/2))`;

const vf = `zoompan=z='${zExpr}':x='${xZP}':y='${yZP}':d=1:s=${srcW}x${srcH}:fps=${srcFps}`;

if (DEBUG) {
  console.error("=== filtergraph ===");
  console.error(vf);
}

const r = spawnSync("ffmpeg", [
  "-y",
  "-i", INPUT,
  "-vf", vf,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 6);
}
propagateSidecars(INPUT, OUTPUT);
console.log(`Zoom → ${OUTPUT}`);
