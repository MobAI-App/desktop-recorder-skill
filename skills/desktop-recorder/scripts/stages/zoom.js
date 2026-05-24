#!/usr/bin/env node
// Stage 3: zoom - per-frame scale + center crop. Center is static (x/y),
// follow_cursor (tracks the synthetic cursor), or pan (waypoints).
// Input [afterHighlights] → Output [afterZoom].

const { loadContext } = require("../lib/screenplay");
const { runFfmpeg } = require("../lib/ffmpeg");
const { cursorPathExpressions } = require("../lib/cursor-path");

const RAMP_SEC = 0.2;

function generate(ctx, { inputLabel = "[afterHighlights]" } = {}) {
  const entries = Array.isArray(ctx.screenplay.zoom) ? ctx.screenplay.zoom : [];
  if (entries.length === 0) {
    return passThrough(inputLabel, "[afterZoom]");
  }

  const segments = entries.map((z, i) => {
    const label = `zoom[${i}]`;
    const scale = Number(z.scale);
    if (!(scale > 1)) fatal(`${label}: scale must be > 1 (got ${z.scale})`);
    const hasPan = Array.isArray(z.pan) && z.pan.length > 0;
    if (z.follow_cursor && hasPan) {
      fatal(`${label}: follow_cursor and pan are mutually exclusive`);
    }
    const range = ctx.resolveActionRange({
      fromAction: z.fromAction, toAction: z.toAction,
      startDelayMs: z.startDelayMs, endDelayMs: z.endDelayMs,
      label,
    });
    let pathExprs = null, cx, cy;
    if (hasPan) {
      // The start center (entry x/y or first action with coords) is the
      // implicit afterMs=0 waypoint.
      let startX, startY;
      if (z.x != null && z.y != null) {
        [startX, startY] = ctx.pointToCanvasPixel({
          x: Number(z.x), y: Number(z.y),
          windowId: z.windowId, source: label,
          coordinate_space: z.coordinate_space || ctx.screenplay.coordinate_space || "screen",
        });
      } else {
        const anchor = [...ctx.actionEvents.values()]
          .filter((e) => e.x != null && e.y != null)
          .filter((e) => e.tStart >= range.tStart && e.tStart < range.tEnd)
          .sort((a, b) => a.tStart - b.tStart)[0];
        if (!anchor) fatal(`${label}: pan needs a start center - provide x/y on the entry or include an action with x/y in range`);
        [startX, startY] = ctx.pointToCanvasPixel(anchor);
      }
      const waypoints = validatePan(z.pan, range, label, ctx, z);
      pathExprs = panPathExpressions(range.tStart, startX, startY, waypoints);
      cx = startX; cy = startY;
    } else if (z.follow_cursor) {
      // Same cursor-path waypoints highlights uses (clicks + moves), so the
      // camera stays glued to the synthetic sprite.
      const wp = ctx.cursorWaypointsInCanvasSeconds()
        .filter((e) => e.tStart >= range.tStart && e.tStart < range.tEnd)
        .map((e) => ({ tStart: e.tStart, canvasX: e.canvasX, canvasY: e.canvasY }));
      if (wp.length === 0) {
        fatal(`${label}: follow_cursor requires at least one click or move event in [${z.fromAction}, ${z.toAction})`);
      }
      pathExprs = cursorPathExpressions(wp);
      cx = wp[0].canvasX; cy = wp[0].canvasY;
    } else if (z.x != null && z.y != null) {
      [cx, cy] = ctx.pointToCanvasPixel({
        x: Number(z.x), y: Number(z.y),
        windowId: z.windowId, source: label,
        coordinate_space: z.coordinate_space || ctx.screenplay.coordinate_space || "screen",
      });
    } else {
      const anchor = [...ctx.actionEvents.values()]
        .filter((e) => e.x != null && e.y != null)
        .filter((e) => e.tStart >= range.tStart && e.tStart < range.tEnd)
        .sort((a, b) => a.tStart - b.tStart)[0];
      if (!anchor) fatal(`${label}: no center - provide x/y or include an action with x/y in range`);
      [cx, cy] = ctx.pointToCanvasPixel(anchor);
    }
    if (pathExprs == null && (!Number.isFinite(cx) || !Number.isFinite(cy))) {
      fatal(`${label}: resolved center is non-finite (cx=${cx}, cy=${cy}) - bad windowId or missing pixelSize on the source clip`);
    }
    return { tStart: range.tStart, tEnd: range.tEnd, scale, cx, cy, pathExprs };
  }).sort((a, b) => a.tStart - b.tStart);
  // Zoom runs BEFORE speedups in the export chain, so `t` in the filter
  // expressions below is source time - which matches click event times.
  // Reordering stages would silently shift the zoom window.

  const W = ctx.composition.canvasW;
  const H = ctx.composition.canvasH;

  const sExpr  = piecewiseScale(segments);
  const cxExpr = piecewiseCenter(segments, "cx", W / 2);
  const cyExpr = piecewiseCenter(segments, "cy", H / 2);

  // crop x/y bounded to [0, scaled - cropSize] so the camera never reveals
  // black bars at edges. min/max, not clip() - clip() isn't in every
  // ffmpeg's expression evaluator.
  const S  = `(${sExpr})`;
  const CX = `(${cxExpr})`;
  const CY = `(${cyExpr})`;
  const cropX = `min(max(${CX}*${S}-${W}/2,0),iw*${S}-${W})`;
  const cropY = `min(max(${CY}*${S}-${H}/2,0),ih*${S}-${H})`;

  // Filter args are single-quoted, so ffmpeg un-quotes before evaluating -
  // commas inside if(...) are already safe; escaping them with \, would
  // break the expression parser on some builds.
  const filterStr =
    `[${inputLabel.replace(/^\[|\]$/g, "")}]` +
    `scale=w='iw*${S}':h='ih*${S}':eval=frame,` +
    `crop=${W}:${H}:x='${cropX}':y='${cropY}':exact=1` +
    `[afterZoom]`;

  return {
    filters: [filterStr],
    inputs: [inputLabel],
    outputs: "[afterZoom]",
    extraInputs: [],
    sidecars: {},
  };
}

// Ramp clamped to half the segment so short (<2×RAMP_SEC) segments don't
// get overlapping ramp regions (which collapse to "ramp-up only").
function piecewiseScale(segments) {
  let expr = "1";
  for (const s of segments) {
    const a = s.tStart, b = s.tEnd;
    const r = Math.min(RAMP_SEC, (b - a) / 2);
    const rampUp   = `(1+(${s.scale}-1)*((t-${a})/${r}))`;
    const rampDown = `(${s.scale}+(1-${s.scale})*((t-${b - r})/${r}))`;
    const inA   = `gte(t,${a})*lt(t,${a + r})`;
    const inMid = `gte(t,${a + r})*lt(t,${b - r})`;
    const inB   = `gte(t,${b - r})*lt(t,${b})`;
    expr = `if(${inA},${rampUp},if(${inMid},${s.scale},if(${inB},${rampDown},${expr})))`;
  }
  return expr;
}

function piecewiseCenter(segments, which, fallback) {
  let expr = String(fallback);
  for (const s of segments) {
    const a = s.tStart, b = s.tEnd;
    const inSeg = `gte(t,${a})*lt(t,${b})`;
    const segExpr = s.pathExprs
      ? (which === "cx" ? s.pathExprs.xExpr : s.pathExprs.yExpr)
      : String(which === "cx" ? s.cx : s.cy);
    expr = `if(${inSeg},${segExpr},${expr})`;
  }
  return expr;
}

// Validate + canonicalize pan waypoints. Returns absolute-time waypoints in
// canvas pixels: [{ t, x, y, ease }, ...] sorted by t.
function validatePan(rawPan, range, label, ctx, zEntry) {
  const dur = range.tEnd - range.tStart;
  const validEases = new Set(["linear", "in", "out", "in_out"]);
  let prevAfter = -Infinity;
  const out = [];
  for (let j = 0; j < rawPan.length; j++) {
    const w = rawPan[j];
    if (typeof w.afterMs !== "number") {
      fatal(`${label}.pan[${j}]: afterMs is required (number)`);
    }
    if (w.afterMs < 0) {
      fatal(`${label}.pan[${j}]: afterMs must be >= 0 (got ${w.afterMs})`);
    }
    if (w.afterMs / 1000 >= dur) {
      fatal(`${label}.pan[${j}]: afterMs (${w.afterMs}ms) exceeds range duration (${(dur * 1000).toFixed(0)}ms)`);
    }
    if (w.afterMs <= prevAfter) {
      fatal(`${label}.pan[${j}]: afterMs must be strictly increasing (${w.afterMs} <= ${prevAfter})`);
    }
    prevAfter = w.afterMs;
    if (w.x == null || w.y == null) {
      fatal(`${label}.pan[${j}]: x and y required`);
    }
    const ease = w.ease ?? "in_out";
    if (!validEases.has(ease)) {
      fatal(`${label}.pan[${j}]: ease must be one of ${[...validEases].join(", ")}`);
    }
    // All waypoints share the entry's windowId: a window-space pan stays in
    // one window's coordinate space. To travel across windows, use screen space.
    const [cx, cy] = ctx.pointToCanvasPixel({
      x: Number(w.x), y: Number(w.y),
      windowId: zEntry.windowId, source: label,
      coordinate_space: zEntry.coordinate_space || ctx.screenplay.coordinate_space || "screen",
    });
    out.push({ t: range.tStart + w.afterMs / 1000, x: cx, y: cy, ease });
  }
  return out;
}

function panPathExpressions(segmentStart, startX, startY, waypoints) {
  if (waypoints.length === 0) {
    return { xExpr: String(startX), yExpr: String(startY) };
  }
  const all = [{ t: segmentStart, x: startX, y: startY }, ...waypoints];
  let xExpr = String(all[all.length - 1].x);
  let yExpr = String(all[all.length - 1].y);
  for (let i = all.length - 2; i >= 0; i--) {
    const a = all[i], b = all[i + 1];
    const dt = b.t - a.t;
    if (dt <= 1e-6) {
      xExpr = `if(lt(t,${b.t}),${a.x},${xExpr})`;
      yExpr = `if(lt(t,${b.t}),${a.y},${yExpr})`;
      continue;
    }
    const u = `((t-${a.t})/${dt})`;
    const eased = easeExpr(u, b.ease ?? "in_out");
    const xLerp = `(${a.x}+(${b.x}-${a.x})*(${eased}))`;
    const yLerp = `(${a.y}+(${b.y}-${a.y})*(${eased}))`;
    xExpr = `if(lt(t,${b.t}),${xLerp},${xExpr})`;
    yExpr = `if(lt(t,${b.t}),${yLerp},${yExpr})`;
  }
  // Before the segment start, hold at startX/startY (zoom segment gating
  // outside this expression keeps it from being read pre-segment anyway).
  return { xExpr, yExpr };
}

// ffmpeg expression for the four standard ease curves applied to u ∈ [0,1].
function easeExpr(u, kind) {
  switch (kind) {
    case "linear": return u;
    case "in":     return `pow(${u},2)`;
    case "out":    return `(1-pow(1-${u},2))`;
    case "in_out": return `if(lt(${u},0.5),4*pow(${u},3),1-pow(-2*${u}+2,3)/2)`;
    default:       return u;
  }
}

function passThrough(inputLabel, outputLabel) {
  return {
    filters: [`[${inputLabel.replace(/^\[|\]$/g, "")}]null${outputLabel}`],
    inputs: [inputLabel],
    outputs: outputLabel,
    extraInputs: [],
    sidecars: {},
  };
}

function apply(ctx, inputMov, outputMov, { dryRun = false } = {}) {
  const f = generate(ctx, { inputLabel: "[0:v]" });
  const args = [
    "-y", "-i", inputMov,
    "-filter_complex", f.filters.join(";"),
    "-map", f.outputs,
    "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
    outputMov,
  ];
  return runFfmpeg(args, { dryRun });
}

function fatal(msg) { console.error(`error: ${msg}`); process.exit(5); }

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd !== "generate") {
    console.error("usage: zoom.js generate <recordingDir> <screenplay> <timeline> [--apply <in.mov> <out.mov>]");
    process.exit(2);
  }
  const applyIdx = argv.indexOf("--apply");
  let applyIn = null, applyOut = null;
  if (applyIdx >= 0) {
    applyIn  = argv[applyIdx + 1];
    applyOut = argv[applyIdx + 2];
    argv.splice(applyIdx, 3);
  }
  const [recordingDir, screenplay, timeline] = argv;
  const ctx = loadContext({ recordingDir, screenplayPath: screenplay, timelinePath: timeline });
  if (applyIn && applyOut) {
    const r = apply(ctx, applyIn, applyOut, { dryRun: process.argv.includes("--dry-run") });
    process.exit(r.status ?? 0);
  } else {
    process.stdout.write(JSON.stringify(generate(ctx), null, 2) + "\n");
  }
}

module.exports = { generate, apply };
