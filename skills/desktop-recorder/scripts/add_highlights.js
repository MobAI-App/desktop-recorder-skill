#!/usr/bin/env node
/**
 * Render click ripples + cursor sprites onto a desktop recording.
 * Also emits the captions sidecar (consumed by add_captions.js later).
 *
 *   node add_highlights.js <raw.mp4> <screenplay.json> <timeline.json> <out.mp4> [flags]
 *
 * Reads click positions from the timeline. The captions sidecar comes from
 * `screenplay.scenes[].caption` (span = scene's full range). Captions are
 * NOT burned here — they're applied after zoom (see add_captions.js) so the
 * zoom transformation doesn't crop them out.
 *
 * Multi-window composites: `--target-window <id>` is REQUIRED. Single-window
 * recordings default to the only window in the meta sidecar.
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadContext, propagateSidecars } = require("./lib/screenplay");

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("usage: add_highlights.js <raw.mp4> <screenplay.json> <timeline.json> <out.mp4> [flags]");
  process.exit(2);
}
const [RAW, SCREENPLAY, TIMELINE, OUT] = argv.slice(0, 4);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const RIPPLE_COLOR = readFlag("--ripple-color", "255:255:255:180");
const RIPPLE_SPRITE = readFlag("--ripple-sprite", null); // user-supplied animated sprite (video w/ alpha)
const TARGET_WINDOW_ID = (() => {
  const raw = readFlag("--target-window", null);
  return raw == null ? null : Number(raw);
})();
const DESKAGENT = process.env.DESKAGENT || "deskagent";

const CURSOR_ENABLED       = !argv.includes("--no-cursor-sprite");
const CURSOR_COLOR         = readFlag("--cursor-color", "000000");
const CURSOR_SIZE_OVERRIDE = (() => { const raw = readFlag("--cursor-size", null); return raw == null ? null : Number(raw); })();
const CURSOR_PNG_ARROW     = readFlag("--cursor-png",          null);
const CURSOR_PNG_POINTING  = readFlag("--cursor-png-pointing", null);
const CURSOR_HOTSPOT_ARROW    = readFlag("--cursor-hotspot",          null); // "X,Y" pixels
const CURSOR_HOTSPOT_POINTING = readFlag("--cursor-hotspot-pointing", null); // "X,Y" pixels

function parseHotspot(s, dx = 0, dy = 0) {
  if (!s) return [dx, dy];
  const [a, b] = s.split(",").map(Number);
  if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
  console.error(`invalid hotspot "${s}"; expected "X,Y" in pixels`);
  process.exit(2);
}

if (!fs.existsSync(RAW)) { console.error(`not found: ${RAW}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: RAW,
  screenplayPath: SCREENPLAY,
  timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW_ID,
});

// ---------------------------------------------------------------------------
// probe source

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "csv=p=0", RAW,
]);
if (probe.status !== 0) {
  console.error("ffprobe failed:", probe.stderr.toString());
  process.exit(4);
}
const [srcW, srcH] = probe.stdout.toString().trim().split(",").map(Number);

const rippleDiameter = Math.round(Math.min(srcW, srcH) * 0.05);
const rippleMs       = 520;
const rippleDurSec   = rippleMs / 1000;

// ---------------------------------------------------------------------------
// generate (or reuse) the animated ripple sprite (transparent WebM)
//
// User can override with --ripple-sprite PATH (any video format ffmpeg
// understands; needs an alpha channel for the transparent background).
// Default: a procedural ring that grows from radius 0 to ~94% over the
// click duration, with alpha fading from peak to 0 over the same window.

let ripplePath = RIPPLE_SPRITE;
if (!ripplePath) {
  ripplePath = path.join(
    os.tmpdir(),
    `demo-desktop-ripple-${rippleDiameter}-${RIPPLE_COLOR.replace(/[^0-9]/g, "_")}-${rippleMs}.mov`,
  );
  if (!fs.existsSync(ripplePath)) {
    const [r, g, b, aPeak] = RIPPLE_COLOR.split(":").map(Number);
    const D = rippleDiameter;
    const C = D / 2;
    const MAXR = C * 0.94;
    const HALF_W = Math.max(2, D * 0.10); // ring half-thickness
    // geq expression evaluated per frame and per pixel:
    //   ring radius at time T = MAXR * T / dur
    //   distance from ring = abs(hypot(X-C, Y-C) - radius(T))
    //   alpha = aPeak * (1 - T/dur) * smoothstep(distance vs HALF_W)
    const expr =
      `r=${r}:g=${g}:b=${b}:` +
      `a='${aPeak}` +
        `*max(0, 1 - T/${rippleDurSec})` +
        `*max(0, 1 - pow(abs(hypot(X-${C},Y-${C}) - ${MAXR}*T/${rippleDurSec}) / ${HALF_W}, 2))'`;
    // qtrle (Apple Animation) in .mov: lossless alpha, supported by ffmpeg
    // overlay, no codec quirks like libvpx-vp9 silently dropping the alpha
    // channel.
    const gen = spawnSync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", `color=c=black@0:s=${D}x${D}:r=60:d=${rippleDurSec}`,
      "-vf", `format=rgba,geq=${expr}`,
      "-c:v", "qtrle", "-pix_fmt", "argb",
      ripplePath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    if (gen.status !== 0) {
      console.error("failed to render ripple animation:", gen.stderr.toString());
      process.exit(5);
    }
    console.log(`Ripple animation → ${ripplePath} (${D}×${D}, ${rippleMs}ms)`);
  }
} else if (!fs.existsSync(ripplePath)) {
  console.error(`--ripple-sprite not found: ${ripplePath}`);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// build overlay events from timeline clicks (canvas pixels, video seconds)

const clickRecs = ctx.clickEventsInVideoSeconds();

const overlayEvents = clickRecs.map((c) => ({
  cx: c.canvasX,
  cy: c.canvasY,
  tin:  c.tStart,
  tout: c.tStart + rippleMs / 1000,
}));

// ---------------------------------------------------------------------------
// captions: one per scene (from screenplay.scenes[].caption).
// Written as a sidecar only — actual burn-in happens after zoom (add_captions.js).

const captionsJson = [];
for (const scene of ctx.screenplay.scenes) {
  if (!scene.caption) continue;
  const range = ctx.sceneRanges.get(scene.id);
  if (!range) continue;
  captionsJson.push({
    startMs: Math.round(range.tStart * 1000),
    endMs:   Math.round(range.tEnd   * 1000),
    text:    scene.caption,
  });
}
const captionsPath = OUT.replace(/\.[^.]+$/, "") + ".captions.json";
fs.writeFileSync(captionsPath, JSON.stringify(captionsJson, null, 2) + "\n");
console.log(`Captions sidecar → ${captionsPath}`);

// ---------------------------------------------------------------------------
// cursor sprites: arrow during motion, pointing hand around each click

const cursorClicks = clickRecs.map((c) => ({ tSec: c.tStart, x: c.canvasX, y: c.canvasY }));

const cursorSize = CURSOR_SIZE_OVERRIDE ?? Math.max(64, Math.round(srcH * 0.07));
const cursorAssets = { arrow: null, pointing: null };
// Hotspots in sprite pixels. Procedural defaults: arrow tip at (0,0),
// pointing-hand fingertip at (12/32, 1/32) of the cursor size grid.
let hotspotArrow    = parseHotspot(CURSOR_HOTSPOT_ARROW, 0, 0);
let hotspotPointing = parseHotspot(
  CURSOR_HOTSPOT_POINTING,
  Math.round(cursorSize * 12 / 32),
  Math.round(cursorSize *  1 / 32),
);

if (CURSOR_ENABLED && cursorClicks.length > 0) {
  if (CURSOR_PNG_ARROW) {
    if (!fs.existsSync(CURSOR_PNG_ARROW)) {
      console.error(`--cursor-png not found: ${CURSOR_PNG_ARROW}`); process.exit(3);
    }
    cursorAssets.arrow = CURSOR_PNG_ARROW;
    // No procedural default for the pointing-hand sprite — fall back to the
    // arrow if the user didn't override pointing too (so click frames still
    // render with *something*, just without the swap).
    cursorAssets.pointing = CURSOR_PNG_POINTING || CURSOR_PNG_ARROW;
    if (CURSOR_PNG_POINTING && !fs.existsSync(CURSOR_PNG_POINTING)) {
      console.error(`--cursor-png-pointing not found: ${CURSOR_PNG_POINTING}`); process.exit(3);
    }
  } else {
    const dir = path.join(os.tmpdir(), `demo-cursors-${cursorSize}-${CURSOR_COLOR.replace(/[^0-9a-fA-F]/g, "_")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const t of ["arrow", "pointing"]) {
      const p = path.join(dir, `${t}.png`);
      if (!fs.existsSync(p)) {
        const r = spawnSync(DESKAGENT, [
          "cursor-png", "--type", t,
          "--size", String(cursorSize),
          "--color", CURSOR_COLOR,
          "--out", p,
        ], { stdio: ["ignore", "ignore", "pipe"] });
        if (r.status !== 0) {
          console.error(`deskagent cursor-png ${t} failed: ${r.stderr?.toString() ?? ""}`);
          process.exit(8);
        }
      }
      cursorAssets[t] = p;
    }
  }
}

// ---------------------------------------------------------------------------
// build filtergraph

const chain = [];
let lastLabel = "[0:v]";

if (overlayEvents.length > 0) {
  // Ripple is now an animated transparent video instead of a looped still.
  // Each click needs its own setpts shift so the animation starts at the
  // click moment; without that, all clicks would see the same global PTS
  // and the animation would only play for the first one.
  if (overlayEvents.length === 1) {
    chain.push(`[1:v] null [r0_pre]`);
  } else {
    chain.push(`[1:v] split=${overlayEvents.length} ${overlayEvents.map((_, i) => `[r${i}_pre]`).join("")}`);
  }
  overlayEvents.forEach((o, i) => {
    chain.push(`[r${i}_pre] setpts=PTS+${o.tin.toFixed(3)}/TB [s${i}]`);
  });

  overlayEvents.forEach((o, i) => {
    const nextLabel = `[v${i}]`;
    const x = `${o.cx} - overlay_w/2`;
    const y = `${o.cy} - overlay_h/2`;
    // shortest=0 lets the main video continue after the sprite ends.
    chain.push(`${lastLabel}[s${i}] overlay=x=${x}:y=${y}:shortest=0:eof_action=pass:enable='between(t,${o.tin.toFixed(3)},${o.tout.toFixed(3)})' ${nextLabel}`);
    lastLabel = nextLabel;
  });
}

const cursorArrowInputIdx    = overlayEvents.length > 0 ? 2 : 1;
const cursorPointingInputIdx = cursorArrowInputIdx + 1;

if (cursorAssets.arrow && cursorClicks.length > 0) {
  const APPROACH_S   = 0.45;
  const POINT_PRE_S  = 0.08;
  const POINT_POST_S = 0.22;
  const HOLD_POST_S  = 0.8;

  const [arrowHotX,    arrowHotY]    = hotspotArrow;
  const [pointingHotX, pointingHotY] = hotspotPointing;

  // Arrow segments: idle holds + quick approaches, each click's pointer
  // window excluded so the arrow and pointing-hand swap (don't stack).
  const arrowSegs = [];
  arrowSegs.push({
    x: cursorClicks[0].x, y: cursorClicks[0].y,
    t0: 0, t1: Math.max(0, cursorClicks[0].tSec - POINT_PRE_S),
    interp: false,
  });
  for (let i = 1; i < cursorClicks.length; i++) {
    const prev = cursorClicks[i - 1], cur = cursorClicks[i];
    const idleStart    = prev.tSec + POINT_POST_S;
    const approachStart = Math.max(idleStart, cur.tSec - APPROACH_S);
    const approachEnd   = cur.tSec - POINT_PRE_S;
    if (approachStart > idleStart) {
      arrowSegs.push({
        x: prev.x, y: prev.y,
        t0: idleStart, t1: approachStart,
        interp: false,
      });
    }
    if (approachEnd > approachStart) {
      arrowSegs.push({
        x: prev.x, y: prev.y, x1: cur.x, y1: cur.y,
        t0: approachStart, t1: approachEnd,
        interp: true,
      });
    }
  }
  const lastClick = cursorClicks[cursorClicks.length - 1];
  arrowSegs.push({
    x: lastClick.x, y: lastClick.y,
    t0: lastClick.tSec + POINT_POST_S, t1: lastClick.tSec + HOLD_POST_S,
    interp: false,
  });

  const arrowCount    = arrowSegs.length;
  const pointingCount = cursorClicks.length;

  chain.push(`[${cursorArrowInputIdx}:v] split=${arrowCount} ${
    Array.from({ length: arrowCount }, (_, i) => `[a${i}]`).join("")
  }`);
  chain.push(`[${cursorPointingInputIdx}:v] split=${pointingCount} ${
    Array.from({ length: pointingCount }, (_, i) => `[p${i}]`).join("")
  }`);

  arrowSegs.forEach((seg, i) => {
    const out = `[ac${i}]`;
    // Subtract the arrow hotspot so the click coord lines up with the sprite's
    // tip pixel — for the procedural arrow that's (0,0) and a no-op.
    const sx = seg.x - arrowHotX,  sy = seg.y - arrowHotY;
    const sx1 = (seg.x1 ?? 0) - arrowHotX, sy1 = (seg.y1 ?? 0) - arrowHotY;
    let xExpr, yExpr;
    if (seg.interp) {
      const dt = (seg.t1 - seg.t0).toFixed(6);
      xExpr = `'${sx.toFixed(1)}+(${sx1.toFixed(1)}-${sx.toFixed(1)})*(t-${seg.t0.toFixed(3)})/${dt}'`;
      yExpr = `'${sy.toFixed(1)}+(${sy1.toFixed(1)}-${sy.toFixed(1)})*(t-${seg.t0.toFixed(3)})/${dt}'`;
    } else {
      xExpr = sx.toFixed(1);
      yExpr = sy.toFixed(1);
    }
    chain.push(
      `${lastLabel}[a${i}] overlay=x=${xExpr}:y=${yExpr}:shortest=1:` +
      `enable='between(t,${seg.t0.toFixed(3)},${seg.t1.toFixed(3)})' ${out}`
    );
    lastLabel = out;
  });

  cursorClicks.forEach((c, i) => {
    const pin  = Math.max(0, c.tSec - POINT_PRE_S);
    const pout = c.tSec + POINT_POST_S;
    const nxt = `[pc${i}]`;
    const px = (c.x - pointingHotX).toFixed(1);
    const py = (c.y - pointingHotY).toFixed(1);
    chain.push(
      `${lastLabel}[p${i}] overlay=x=${px}:y=${py}:shortest=1:` +
      `enable='between(t,${pin.toFixed(3)},${pout.toFixed(3)})' ${nxt}`
    );
    lastLabel = nxt;
  });
}

chain.push(`${lastLabel} null [vout]`);

const filtergraph = chain.join(";\n");

// ---------------------------------------------------------------------------
// invoke ffmpeg

if (overlayEvents.length === 0 && !cursorAssets.arrow) {
  console.log("No click events; copying raw → out.");
  const r = spawnSync("ffmpeg", ["-y", "-i", RAW, "-c", "copy", OUT], { stdio: "inherit" });
  // captions sidecar already written above; meta passes through.
  propagateSidecars(RAW, OUT, { skipCaptions: true });
  process.exit(r.status ?? 0);
}

const args = ["-y", "-i", RAW];
if (overlayEvents.length > 0) {
  // Ripple is an animated transparent video — no -loop. Each click branch
  // applies its own setpts shift in the filtergraph.
  args.push("-i", ripplePath);
}
if (cursorAssets.arrow && cursorClicks.length > 0) {
  args.push("-loop", "1", "-i", cursorAssets.arrow);
  args.push("-loop", "1", "-i", cursorAssets.pointing);
}
args.push(
  "-filter_complex", filtergraph,
  "-map", "[vout]",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  // Bounds the output to the main video's length; without it the looped
  // -loop 1 cursor PNG inputs never EOS and ffmpeg writes forever.
  "-shortest",
  "-an",
  OUT,
);

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg highlight pass failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
// captions sidecar already written; meta carries over.
propagateSidecars(RAW, OUT, { skipCaptions: true });
console.log(`Highlights → ${OUT}`);
