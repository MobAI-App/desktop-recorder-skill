#!/usr/bin/env node
// add_zoom.js <input.mp4> <screenplay.json> <timeline.json> <output.mp4>
//
// Animated zoom from screenplay.scenes[].zoom directives. Scenes without a
// zoom field are passed through untouched. Optional cursor-follow tracks
// click positions within each zoom segment using a deadzone + EMA.

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
function numFlag(name) { const v = flag(name, null); return v == null ? null : Number(v); }

const RAMP             = Number(flag("--ramp", "0.2"));
const DEADZONE         = Number(flag("--deadzone", "0.10"));
const FOLLOW_SMOOTHING = Number(flag("--follow-smoothing", "0.5"));
const TARGET_WINDOW    = numFlag("--target-window");
const DEBUG            = argv.includes("--debug");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: INPUT, screenplayPath: SCREENPLAY, timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

const { srcW, srcH, srcFps } = probeStream(INPUT);

const segments = buildSegments(ctx);

if (segments.length === 0) {
  console.log("No zoom directives; copying through.");
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT);
  process.exit(r.status ?? 0);
}

console.log(`Camera segments: ${segments.length}`);
for (const s of segments) {
  console.log(
    `  [${s.tStart.toFixed(2)}s..${s.tEnd.toFixed(2)}s]  scale=${s.scale}  ` +
    `at canvas=(${s.cx.toFixed(0)},${s.cy.toFixed(0)})  ` +
    `scene=${s.sceneId}  follow=${s.followCursor}`,
  );
}

const cursorPath = buildCursorPath();
const filtergraph = buildZoompanFilter();
if (DEBUG) console.error("=== filtergraph ===\n" + filtergraph);

const r = spawnSync("ffmpeg", [
  "-y", "-i", INPUT, "-vf", filtergraph,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", "-an",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 6);
}
propagateSidecars(INPUT, OUTPUT);
console.log(`Zoom -> ${OUTPUT}`);

// ---------------------------------------------------------------------------

function probeStream(input) {
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", input,
  ]);
  if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
  const [pw, ph, frate] = probe.stdout.toString().trim().split(",");
  const [fNum, fDen] = frate.split("/").map(Number);
  return {
    srcW:   Number(pw),
    srcH:   Number(ph),
    srcFps: Math.round((fNum / (fDen || 1)) * 1000) / 1000,
  };
}

function buildSegments(ctx) {
  const segs = [];
  for (const scene of ctx.screenplay.scenes) {
    if (!scene.zoom) continue;
    const z = scene.zoom;
    const scale = Number(z.scale);
    if (!(scale > 1)) {
      console.error(`scene "${scene.id}" zoom.scale must be > 1 (got ${z.scale})`);
      process.exit(2);
    }
    const range = ctx.resolveActionRange({
      sceneId: scene.id, fromAction: z.fromAction, toAction: z.toAction,
    });
    const [cx, cy] = resolveCenter(ctx, scene, z, range);
    segs.push({
      sceneId: scene.id,
      tStart: range.tStart, tEnd: range.tEnd,
      cx, cy, scale,
      followCursor: !!z.follow_cursor,
    });
  }
  return segs;
}

function resolveCenter(ctx, scene, z, range) {
  if (z.x != null && z.y != null) {
    return ctx.pointToCanvasPixel({
      x: Number(z.x), y: Number(z.y),
      coordinate_space: z.coordinate_space || ctx.screenplay.coordinate_space || "screen",
    });
  }
  const anchor = [...ctx.actionEvents.values()]
    .filter((e) => e.sceneId === scene.id && e.x != null && e.y != null)
    .filter((e) => !z.fromAction || e.tStart >= range.tStart)
    .filter((e) => !z.toAction   || e.tStart <  range.tEnd)
    .sort((a, b) => a.tStart - b.tStart)[0];
  if (!anchor) {
    console.error(`scene "${scene.id}" zoom has no center: provide zoom.x/zoom.y, or include an action with x/y in the range`);
    process.exit(2);
  }
  return ctx.pointToCanvasPixel(anchor);
}

// Linear interpolation between click positions, matching the synthetic-cursor
// motion profile in add_highlights so follow-cursor zoom and the visible
// cursor sprite move together.
function buildCursorPath() {
  const raw = ctx.clickEventsInVideoSeconds().map((c) => ({ t: c.tStart, x: c.canvasX, y: c.canvasY }));
  if (raw.length < 2) return raw;

  const APPROACH_S = 0.45;
  const STEP_S = 1 / 30;
  const out = [{ t: raw[0].t, x: raw[0].x, y: raw[0].y }];

  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1], cur = raw[i];
    const approachStart = Math.max(prev.t, cur.t - APPROACH_S);
    if (approachStart > prev.t) out.push({ t: approachStart, x: prev.x, y: prev.y });
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

function fmt(n) { return Number(n).toFixed(3); }

function amountSubExpr(seg) {
  const dur  = seg.tEnd - seg.tStart;
  const ramp = Math.min(RAMP, dur / 4);
  const t0 = fmt(seg.tStart), t1 = fmt(seg.tStart + ramp);
  const t2 = fmt(seg.tEnd - ramp), t3 = fmt(seg.tEnd);
  return (
    `if(between(t,${t0},${t1}), (t-${t0})/${fmt(ramp)}, ` +
    `if(between(t,${t1},${t2}), 1, ` +
    `if(between(t,${t2},${t3}), 1-(t-${t2})/${fmt(ramp)}, 0)))`
  );
}

// ffmpeg's max() is binary, so nest for N>2 terms.
function maxNested(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `max(${parts[0]},${parts[1]})`;
  return `max(${parts[0]},${maxNested(parts.slice(1))})`;
}

function scaleExpr() {
  const parts = segments.map((s) => `${fmt(s.scale - 1)}*(${amountSubExpr(s)})`);
  return `1+${maxNested(parts)}`;
}

function staticCenterExpr(coord) {
  let expr = coord === "x" ? "iw/2" : "ih/2";
  for (const s of [...segments].sort((a, b) => a.tStart - b.tStart)) {
    const c = coord === "x" ? s.cx : s.cy;
    expr = `if(between(t,${fmt(s.tStart)},${fmt(s.tEnd)}), ${fmt(c)}, ${expr})`;
  }
  return expr;
}

// ffmpeg expressions are stateless; precompute the cursor-follow camera path
// in JS (deadzone + EMA) and emit as piecewise linear interpolation.
function buildFollowCenter(coord) {
  const followSegs = segments.filter((s) => s.followCursor);
  if (followSegs.length === 0) return staticCenterExpr(coord);

  const allPath = [];
  for (const seg of followSegs) {
    allPath.push({ t: seg.tStart, x: seg.cx, y: seg.cy, segId: seg });

    const inRange = cursorPath.filter((p) => p.t > seg.tStart && p.t <= seg.tEnd);
    if (inRange.length === 0) continue;

    const dzX = (srcW / seg.scale) * DEADZONE;
    const dzY = (srcH / seg.scale) * DEADZONE;

    let camX = seg.cx, camY = seg.cy;
    const tick = (t, x, y) => {
      const dx = x - camX, dy = y - camY;
      if (Math.abs(dx) > dzX / 2) {
        camX += FOLLOW_SMOOTHING * ((x - Math.sign(dx) * (dzX / 2)) - camX);
      }
      if (Math.abs(dy) > dzY / 2) {
        camY += FOLLOW_SMOOTHING * ((y - Math.sign(dy) * (dzY / 2)) - camY);
      }
      allPath.push({ t, x: camX, y: camY, segId: seg });
    };
    for (const p of inRange) tick(p.t, p.x, p.y);

    // After the cursor's last motion event, keep ticking with the cursor
    // frozen so the EMA can converge during the post-click hold - otherwise
    // the camera freezes mid-pan and never reaches the deadzone wall.
    const lastSamp = inRange[inRange.length - 1];
    const STEP = 1 / 15;
    let prevX = camX, prevY = camY;
    for (let t = lastSamp.t + STEP; t <= seg.tEnd; t += STEP) {
      tick(t, lastSamp.x, lastSamp.y);
      if (Math.abs(camX - prevX) < 0.5 && Math.abs(camY - prevY) < 0.5) break;
      prevX = camX; prevY = camY;
    }
  }

  let expr = coord === "x" ? "iw/2" : "ih/2";
  for (const s of segments) {
    if (s.followCursor) continue;
    const c = coord === "x" ? s.cx : s.cy;
    expr = `if(between(t,${fmt(s.tStart)},${fmt(s.tEnd)}), ${fmt(c)}, ${expr})`;
  }
  for (let i = allPath.length - 1; i >= 0; i--) {
    const p = allPath[i], next = allPath[i + 1];
    const c = coord === "x" ? p.x : p.y;
    if (next) {
      const cn = coord === "x" ? next.x : next.y;
      const dt = (next.t - p.t) || 0.001;
      expr = `if(between(t,${fmt(p.t)},${fmt(next.t)}), ${fmt(c)}+(${fmt(cn - c)})*(t-${fmt(p.t)})/${fmt(dt)}, ${expr})`;
    } else {
      expr = `if(between(t,${fmt(p.t)},${fmt(p.segId.tEnd)}), ${fmt(c)}, ${expr})`;
    }
  }
  return expr;
}

function buildZoompanFilter() {
  const subT = (s) => s.replace(/\bt\b/g, "out_time");
  const zExpr  = subT(scaleExpr());
  const cxZP   = subT(buildFollowCenter("x"));
  const cyZP   = subT(buildFollowCenter("y"));
  const xZP = `max(0, min(iw - iw/zoom, (${cxZP}) - iw/zoom/2))`;
  const yZP = `max(0, min(ih - ih/zoom, (${cyZP}) - ih/zoom/2))`;
  return `zoompan=z='${zExpr}':x='${xZP}':y='${yZP}':d=1:s=${srcW}x${srcH}:fps=${srcFps}`;
}
