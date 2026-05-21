#!/usr/bin/env node
// add_highlights.js <raw.mp4> <screenplay.json> <timeline.json> <out.mp4>
//
// Burns click ripples and cursor sprites onto the recording, plus writes a
// captions sidecar (read later by add_captions.js). Captions are NOT burned
// here so add_zoom can transform the frame without cropping them out.

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
function numFlag(name) { const v = readFlag(name, null); return v == null ? null : Number(v); }

const RIPPLE_COLOR   = readFlag("--ripple-color",  "255:255:255:180");
const RIPPLE_SPRITE  = readFlag("--ripple-sprite", null);
const TARGET_WINDOW  = numFlag("--target-window");
const DESKAGENT      = process.env.DESKAGENT || "deskagent";

const CURSOR_ENABLED       = !argv.includes("--no-cursor-sprite");
const CURSOR_COLOR         = readFlag("--cursor-color", "000000");
const CURSOR_SIZE_OVERRIDE = numFlag("--cursor-size");
const CURSOR_PNG_ARROW     = readFlag("--cursor-png",          null);
const CURSOR_PNG_POINTING  = readFlag("--cursor-png-pointing", null);
const CURSOR_HOTSPOT_ARROW    = readFlag("--cursor-hotspot",          null);
const CURSOR_HOTSPOT_POINTING = readFlag("--cursor-hotspot-pointing", null);

const RIPPLE_MS = 520;
const RIPPLE_DUR_SEC = RIPPLE_MS / 1000;

if (!fs.existsSync(RAW)) { console.error(`not found: ${RAW}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: RAW, screenplayPath: SCREENPLAY, timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

const [srcW, srcH] = probeWH(RAW);
const rippleDiameter = Math.round(Math.min(srcW, srcH) * 0.05);

const ripplePath = RIPPLE_SPRITE ? validateSpritePath(RIPPLE_SPRITE) : generateRippleAnimation();
const clickRecs = ctx.clickEventsInVideoSeconds();
const overlayEvents = clickRecs.map((c) => ({
  cx: c.canvasX, cy: c.canvasY,
  tin: c.tStart, tout: c.tStart + RIPPLE_DUR_SEC,
}));

writeCaptionsSidecar();

const cursorClicks = clickRecs.map((c) => ({ tSec: c.tStart, x: c.canvasX, y: c.canvasY }));
const cursorSize = CURSOR_SIZE_OVERRIDE ?? Math.max(64, Math.round(srcH * 0.07));
const { cursorAssets, hotspotArrow, hotspotPointing } = resolveCursorAssets();

if (overlayEvents.length === 0 && !cursorAssets.arrow) {
  console.log("No click events; copying raw -> out.");
  const r = spawnSync("ffmpeg", ["-y", "-i", RAW, "-c", "copy", OUT], { stdio: "inherit" });
  propagateSidecars(RAW, OUT, { skipCaptions: true });
  process.exit(r.status ?? 0);
}

const filtergraph = buildFiltergraph();

const args = ["-y", "-i", RAW];
if (overlayEvents.length > 0) args.push("-i", ripplePath);
if (cursorAssets.arrow && cursorClicks.length > 0) {
  args.push("-loop", "1", "-i", cursorAssets.arrow);
  args.push("-loop", "1", "-i", cursorAssets.pointing);
}
args.push(
  "-filter_complex", filtergraph, "-map", "[vout]",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  // -shortest bounds the output to the video's length; without it the looped
  // -loop 1 cursor PNG inputs never EOS and ffmpeg writes forever.
  "-shortest", "-an",
  OUT,
);

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg highlight pass failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
propagateSidecars(RAW, OUT, { skipCaptions: true });
console.log(`Highlights -> ${OUT}`);

// ---------------------------------------------------------------------------

function probeWH(input) {
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", input,
  ]);
  if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
  return probe.stdout.toString().trim().split(",").map(Number);
}

function validateSpritePath(p) {
  if (!fs.existsSync(p)) { console.error(`--ripple-sprite not found: ${p}`); process.exit(3); }
  return p;
}

// qtrle in .mov: lossless alpha, no codec quirks (libvpx-vp9 silently drops
// the alpha channel on some builds).
function generateRippleAnimation() {
  const cachePath = path.join(
    os.tmpdir(),
    `demo-desktop-ripple-${rippleDiameter}-${RIPPLE_COLOR.replace(/[^0-9]/g, "_")}-${RIPPLE_MS}.mov`,
  );
  if (fs.existsSync(cachePath)) return cachePath;

  const [r, g, b, aPeak] = RIPPLE_COLOR.split(":").map(Number);
  const D = rippleDiameter;
  const C = D / 2;
  const MAXR = C * 0.94;
  const HALF_W = Math.max(2, D * 0.10);
  const expr =
    `r=${r}:g=${g}:b=${b}:` +
    `a='${aPeak}` +
      `*max(0, 1 - T/${RIPPLE_DUR_SEC})` +
      `*max(0, 1 - pow(abs(hypot(X-${C},Y-${C}) - ${MAXR}*T/${RIPPLE_DUR_SEC}) / ${HALF_W}, 2))'`;
  const gen = spawnSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black@0:s=${D}x${D}:r=60:d=${RIPPLE_DUR_SEC}`,
    "-vf", `format=rgba,geq=${expr}`,
    "-c:v", "qtrle", "-pix_fmt", "argb",
    cachePath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (gen.status !== 0) {
    console.error("failed to render ripple animation:", gen.stderr.toString());
    process.exit(5);
  }
  console.log(`Ripple animation -> ${cachePath} (${D}x${D}, ${RIPPLE_MS}ms)`);
  return cachePath;
}

function writeCaptionsSidecar() {
  const captions = [];
  for (const scene of ctx.screenplay.scenes) {
    if (!scene.caption) continue;
    const range = ctx.sceneRanges.get(scene.id);
    if (!range) continue;
    captions.push({
      startMs: Math.round(range.tStart * 1000),
      endMs:   Math.round(range.tEnd   * 1000),
      text:    scene.caption,
    });
  }
  const captionsPath = OUT.replace(/\.[^.]+$/, "") + ".captions.json";
  fs.writeFileSync(captionsPath, JSON.stringify(captions, null, 2) + "\n");
  console.log(`Captions sidecar -> ${captionsPath}`);
}

function parseHotspot(s, dx, dy) {
  if (!s) return [dx, dy];
  const [a, b] = s.split(",").map(Number);
  if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
  console.error(`invalid hotspot "${s}"; expected "X,Y" in pixels`);
  process.exit(2);
}

function resolveCursorAssets() {
  const assets = { arrow: null, pointing: null };
  let arrowHot = parseHotspot(CURSOR_HOTSPOT_ARROW, 0, 0);
  let pointingHot;

  if (!CURSOR_ENABLED || cursorClicks.length === 0) {
    return { cursorAssets: assets, hotspotArrow: arrowHot, hotspotPointing: arrowHot };
  }

  if (CURSOR_PNG_ARROW) {
    if (!fs.existsSync(CURSOR_PNG_ARROW)) { console.error(`--cursor-png not found: ${CURSOR_PNG_ARROW}`); process.exit(3); }
    if (CURSOR_PNG_POINTING && !fs.existsSync(CURSOR_PNG_POINTING)) { console.error(`--cursor-png-pointing not found: ${CURSOR_PNG_POINTING}`); process.exit(3); }
    assets.arrow    = CURSOR_PNG_ARROW;
    assets.pointing = CURSOR_PNG_POINTING || CURSOR_PNG_ARROW;
    // When pointing reuses the arrow sprite, share its hotspot so the click
    // frame doesn't visibly jump.
    const fallback = CURSOR_PNG_POINTING ? [0, 0] : arrowHot;
    pointingHot = parseHotspot(CURSOR_HOTSPOT_POINTING, ...fallback);
  } else {
    const dir = path.join(
      os.tmpdir(),
      `demo-cursors-${cursorSize}-${CURSOR_COLOR.replace(/[^0-9a-fA-F]/g, "_")}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    for (const kind of ["arrow", "pointing"]) {
      const p = path.join(dir, `${kind}.png`);
      if (!fs.existsSync(p)) {
        const r = spawnSync(DESKAGENT, [
          "cursor-png", "--type", kind,
          "--size", String(cursorSize),
          "--color", CURSOR_COLOR,
          "--out", p,
        ], { stdio: ["ignore", "ignore", "pipe"] });
        if (r.status !== 0) {
          console.error(`deskagent cursor-png ${kind} failed: ${r.stderr?.toString() ?? ""}`);
          process.exit(8);
        }
      }
      assets[kind] = p;
    }
    // Procedural pointing-hand: fingertip at (12/32, 1/32) of the sprite
    // grid - CursorPngCommand draws it on that layout.
    pointingHot = parseHotspot(
      CURSOR_HOTSPOT_POINTING,
      Math.round(cursorSize * 12 / 32),
      Math.round(cursorSize *  1 / 32),
    );
  }

  return { cursorAssets: assets, hotspotArrow: arrowHot, hotspotPointing: pointingHot };
}

function buildFiltergraph() {
  const chain = [];
  let last = "[0:v]";

  if (overlayEvents.length > 0) {
    // setpts per click so each ripple animation starts at its click moment.
    // Without this all clicks see the same global PTS and the ripple only
    // plays for the first one.
    if (overlayEvents.length === 1) {
      chain.push(`[1:v] null [r0_pre]`);
    } else {
      chain.push(`[1:v] split=${overlayEvents.length} ${overlayEvents.map((_, i) => `[r${i}_pre]`).join("")}`);
    }
    overlayEvents.forEach((o, i) => {
      chain.push(`[r${i}_pre] setpts=PTS+${o.tin.toFixed(3)}/TB [s${i}]`);
    });
    overlayEvents.forEach((o, i) => {
      const next = `[v${i}]`;
      // shortest=0 lets the main video continue after the sprite ends.
      chain.push(
        `${last}[s${i}] overlay=x=${o.cx} - overlay_w/2:y=${o.cy} - overlay_h/2:` +
        `shortest=0:eof_action=pass:` +
        `enable='between(t,${o.tin.toFixed(3)},${o.tout.toFixed(3)})' ${next}`,
      );
      last = next;
    });
  }

  if (cursorAssets.arrow && cursorClicks.length > 0) {
    last = appendCursorChain(chain, last);
  }

  chain.push(`${last} null [vout]`);
  return chain.join(";\n");
}

function appendCursorChain(chain, last) {
  const APPROACH_S   = 0.45;
  const POINT_PRE_S  = 0.08;
  const POINT_POST_S = 0.22;
  const HOLD_POST_S  = 0.8;

  const [arrowHotX,    arrowHotY]    = hotspotArrow;
  const [pointingHotX, pointingHotY] = hotspotPointing;

  // Arrow idle holds + linear approaches, with the per-click pointer window
  // excluded so the arrow and pointing-hand swap instead of stacking.
  const arrowSegs = [];
  arrowSegs.push({
    x: cursorClicks[0].x, y: cursorClicks[0].y,
    t0: 0, t1: Math.max(0, cursorClicks[0].tSec - POINT_PRE_S),
    interp: false,
  });
  for (let i = 1; i < cursorClicks.length; i++) {
    const prev = cursorClicks[i - 1], cur = cursorClicks[i];
    const idleStart     = prev.tSec + POINT_POST_S;
    const approachStart = Math.max(idleStart, cur.tSec - APPROACH_S);
    const approachEnd   = cur.tSec - POINT_PRE_S;
    if (approachStart > idleStart) {
      arrowSegs.push({ x: prev.x, y: prev.y, t0: idleStart, t1: approachStart, interp: false });
    }
    if (approachEnd > approachStart) {
      arrowSegs.push({ x: prev.x, y: prev.y, x1: cur.x, y1: cur.y, t0: approachStart, t1: approachEnd, interp: true });
    }
  }
  const lastClick = cursorClicks[cursorClicks.length - 1];
  arrowSegs.push({
    x: lastClick.x, y: lastClick.y,
    t0: lastClick.tSec + POINT_POST_S, t1: lastClick.tSec + HOLD_POST_S,
    interp: false,
  });

  const cursorArrowIdx    = overlayEvents.length > 0 ? 2 : 1;
  const cursorPointingIdx = cursorArrowIdx + 1;

  chain.push(
    `[${cursorArrowIdx}:v] split=${arrowSegs.length} ` +
    Array.from({ length: arrowSegs.length }, (_, i) => `[a${i}]`).join(""),
  );
  chain.push(
    `[${cursorPointingIdx}:v] split=${cursorClicks.length} ` +
    Array.from({ length: cursorClicks.length }, (_, i) => `[p${i}]`).join(""),
  );

  arrowSegs.forEach((seg, i) => {
    const sx = seg.x - arrowHotX, sy = seg.y - arrowHotY;
    let xExpr, yExpr;
    if (seg.interp) {
      const sx1 = seg.x1 - arrowHotX, sy1 = seg.y1 - arrowHotY;
      const dt = (seg.t1 - seg.t0).toFixed(6);
      xExpr = `'${sx.toFixed(1)}+(${sx1.toFixed(1)}-${sx.toFixed(1)})*(t-${seg.t0.toFixed(3)})/${dt}'`;
      yExpr = `'${sy.toFixed(1)}+(${sy1.toFixed(1)}-${sy.toFixed(1)})*(t-${seg.t0.toFixed(3)})/${dt}'`;
    } else {
      xExpr = sx.toFixed(1);
      yExpr = sy.toFixed(1);
    }
    const out = `[ac${i}]`;
    chain.push(
      `${last}[a${i}] overlay=x=${xExpr}:y=${yExpr}:shortest=1:` +
      `enable='between(t,${seg.t0.toFixed(3)},${seg.t1.toFixed(3)})' ${out}`,
    );
    last = out;
  });

  cursorClicks.forEach((c, i) => {
    const pin  = Math.max(0, c.tSec - POINT_PRE_S);
    const pout = c.tSec + POINT_POST_S;
    const px = (c.x - pointingHotX).toFixed(1);
    const py = (c.y - pointingHotY).toFixed(1);
    const out = `[pc${i}]`;
    chain.push(
      `${last}[p${i}] overlay=x=${px}:y=${py}:shortest=1:` +
      `enable='between(t,${pin.toFixed(3)},${pout.toFixed(3)})' ${out}`,
    );
    last = out;
  });

  return last;
}
