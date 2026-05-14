#!/usr/bin/env node
/**
 * Render click ripples onto a desktop screen recording, using ffmpeg.
 *
 * Usage:
 *   node add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [--ripple-color rgba]
 *
 * What it does:
 *   - reads timeline.json
 *   - generates a soft circular ripple sprite (alpha gradient from centre)
 *     via ffmpeg `geq`, cached at /tmp/demo-ripple-<...>.png
 *   - overlays one ripple per click at the moment of the click
 *   - emits a sidecar `<out>.captions.json` track so captions can be burned
 *     in later (we don't burn them here because many ffmpeg builds lack
 *     drawtext / libfreetype)
 *
 * The system cursor is already visible in the recording, so there is no
 * separate "finger" overlay (unlike the mobile skill). If you want a
 * persistent cursor halo, use ffmpeg's `mouse` filter directly on raw.mp4
 * before running this script.
 *
 * Coordinates in the timeline are in *source pixels* of the recording.
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
if (argv.length < 3) {
  console.error("usage: node add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [--ripple-color rgba]");
  process.exit(2);
}
const [RAW, TIMELINE, OUT] = argv.slice(0, 3);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const RIPPLE_COLOR = readFlag("--ripple-color", "255:255:255:180"); // r:g:b:a-peak (0-255)

if (!fs.existsSync(RAW))      { console.error(`not found: ${RAW}`); process.exit(3); }
if (!fs.existsSync(TIMELINE)) { console.error(`not found: ${TIMELINE}`); process.exit(3); }

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

// Desktop ripple sized smaller than mobile — about 3% of the short edge.
// On a 1920×1080 capture that's ~30 px; on a 3456×2234 retina capture
// it's ~65 px. Big enough to read as a click, small enough not to cover
// the UI element underneath.
const rippleDiameter = Math.round(Math.min(srcW, srcH) * 0.03);
const rippleMs       = 520;

// ---------------------------------------------------------------------------
// generate (or reuse) the soft ripple sprite

const events = JSON.parse(fs.readFileSync(TIMELINE, "utf8"));

const ripplePath = path.join(os.tmpdir(), `demo-desktop-ripple-${rippleDiameter}-${RIPPLE_COLOR.replace(/[^0-9]/g, "_")}.png`);

if (!fs.existsSync(ripplePath)) {
  const [r, g, b, aPeak] = RIPPLE_COLOR.split(":").map(Number);
  const D = rippleDiameter;
  const C = D / 2;
  // Soft circle: alpha falls off quadratically from the center to the edge.
  // Outer 6% is fully transparent (anti-aliased seam).
  const expr = `r=${r}:g=${g}:b=${b}:a='if(lt(hypot(X-${C},Y-${C}),${C * 0.94}), ${aPeak}*pow(max(0,1-hypot(X-${C},Y-${C})/${C * 0.94}),1.6), 0)'`;
  const gen = spawnSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black@0:s=${D}x${D}:d=0.04`,
    "-vf", `format=rgba,geq=${expr}`,
    "-frames:v", "1",
    ripplePath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (gen.status !== 0) {
    console.error("failed to render ripple sprite:", gen.stderr.toString());
    process.exit(5);
  }
  console.log(`Ripple sprite → ${ripplePath} (${D}×${D})`);
}

// ---------------------------------------------------------------------------
// coordinate transform: timeline events carry CG-point coordinates in the
// space the control script wrote ("window" or "screen"). The recording is
// in source pixels, so we need the backing scale (and the window origin
// when the script used screen-space coords) to land ripples on the right
// pixel. Both come from the `<raw>.meta.json` sidecar that `deskagent
// record` writes alongside the .mp4.

const metaPath = RAW + ".meta.json";
let backingScale = 1.0;
let windowOriginCG = [0, 0];
let metaLoaded = false;
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  // Single-window is the common case; for multi-window or display-only
  // recordings the caller has to pick a reference window — we use the
  // first one.
  if (meta.windows && meta.windows.length > 0) {
    const w = meta.windows[0];
    backingScale = w.backingScale || 1.0;
    windowOriginCG = [w.frameCG[0], w.frameCG[1]];
  } else if (meta.pixelSize) {
    // Display-only recording: coords match the display's pixel grid 1:1
    // when the recording was captured at native resolution.
    backingScale = 1.0;
  }
  metaLoaded = true;
}
if (!metaLoaded) {
  console.warn(`warn: ${metaPath} not found — assuming timeline coords are already in source pixels.`);
}

/**
 * Convert a single timeline event's CG-point coordinates into source pixels
 * of the recording. Falls back to identity when the meta sidecar wasn't found
 * (legacy timelines where coords are already in pixel space).
 */
function pointToRecordingPixel(e) {
  let x = e.x;
  let y = e.y;
  if (metaLoaded) {
    if (e.coordinate_space === "screen" || e.coordinateSpace === "screen") {
      x -= windowOriginCG[0];
      y -= windowOriginCG[1];
    }
    x *= backingScale;
    y *= backingScale;
  }
  return [x, y];
}

// ---------------------------------------------------------------------------
// build overlay events — one ripple per click

const stopMs = (events.find((e) => e.type === "record_stop") || {}).timeMs
            ?? events[events.length - 1].timeMs;

const overlayEvents = [];
for (const e of events) {
  if (e.type === "click" && e.x != null && e.y != null) {
    const [cx, cy] = pointToRecordingPixel(e);
    overlayEvents.push({
      cx,
      cy,
      tin:  e.timeMs / 1000,
      tout: (e.timeMs + rippleMs) / 1000,
    });
  }
  // scroll trails: optional, off by default — uncomment to enable
  // else if (e.type === "scroll" && e.x2 != null && e.y2 != null) { ... }
}

// ---------------------------------------------------------------------------
// captions sidecar

const captionEvents = events.filter((e) => e.caption);
const captionsJson = captionEvents.map((e, idx) => ({
  startMs: e.timeMs,
  endMs:   captionEvents[idx + 1]?.timeMs ?? stopMs,
  text:    e.caption,
}));
const captionsPath = OUT.replace(/\.[^.]+$/, "") + ".captions.json";
fs.writeFileSync(captionsPath, JSON.stringify(captionsJson, null, 2) + "\n");
console.log(`Captions sidecar → ${captionsPath}`);

// ---------------------------------------------------------------------------
// build filtergraph

const chain = [];
let lastLabel = "[0:v]";

if (overlayEvents.length > 0) {
  if (overlayEvents.length === 1) {
    chain.push(`[1:v] null [s0]`);
  } else {
    chain.push(`[1:v] split=${overlayEvents.length} ${overlayEvents.map((_, i) => `[s${i}]`).join("")}`);
  }

  overlayEvents.forEach((o, i) => {
    const nextLabel = `[v${i}]`;
    const x = `${o.cx} - overlay_w/2`;
    const y = `${o.cy} - overlay_h/2`;
    // `shortest=1` keeps ffmpeg from waiting on the looped sprite input.
    chain.push(`${lastLabel}[s${i}] overlay=x=${x}:y=${y}:shortest=1:enable='between(t,${o.tin.toFixed(3)},${o.tout.toFixed(3)})' ${nextLabel}`);
    lastLabel = nextLabel;
  });
}

// final label
chain.push(`${lastLabel} null [vout]`);

const filtergraph = chain.join(";\n");

// ---------------------------------------------------------------------------
// invoke ffmpeg

if (overlayEvents.length === 0) {
  console.log("No click events; copying raw → out.");
  const r = spawnSync("ffmpeg", ["-y", "-i", RAW, "-c", "copy", OUT], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

const args = [
  "-y",
  "-i", RAW,
  "-loop", "1", "-i", ripplePath,
  "-filter_complex", filtergraph,
  "-map", "[vout]",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
  OUT,
];

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg highlight pass failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
console.log(`Highlights → ${OUT}`);
