#!/usr/bin/env node
/**
 * Burn captions onto a video at viewport-fixed coords (centered horizontally,
 * configurable Y). Runs AFTER add_zoom so the zoom transformation doesn't
 * crop captions out of frame.
 *
 *   node add_captions.js <input.mp4> <screenplay.json> <timeline.json> <out.mp4> [flags]
 *
 * Captions are read from `<input>.captions.json` (written by add_highlights
 * and propagated through every stage). If the sidecar is missing, falls back
 * to deriving captions from `screenplay.scenes[].caption` directly.
 *
 * Flags:
 *   --target-window <id>      REQUIRED only when the meta sidecar has >1 windows.
 *   --caption-y FRACTION      Vertical position (0 = top, 1 = bottom). Default 0.85.
 *   --caption-font-size N     Default max(28, videoHeight * 0.04).
 *   --no-captions             Passthrough (writes captions sidecar unchanged).
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadContext, propagateSidecars } = require("./lib/screenplay");

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("usage: add_captions.js <input.mp4> <screenplay.json> <timeline.json> <out.mp4> [flags]");
  process.exit(2);
}
const [INPUT, SCREENPLAY, TIMELINE, OUTPUT] = argv.slice(0, 4);

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
const TARGET_WINDOW = (() => { const v = flag("--target-window", null); return v == null ? null : Number(v); })();
const CAPTION_Y     = Number(flag("--caption-y", "0.85"));
const FONT_SIZE_OV  = (() => { const v = flag("--caption-font-size", null); return v == null ? null : Number(v); })();
const BURN          = !argv.includes("--no-captions");
const DESKAGENT     = process.env.DESKAGENT || "deskagent";

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

// Load context for sidecar/meta validation; we don't actually need timeline
// joins here (captions sidecar carries the resolved times).
loadContext({
  inputMp4: INPUT,
  screenplayPath: SCREENPLAY,
  timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

// ---------------------------------------------------------------------------
// load captions: prefer the propagated sidecar, fall back to the screenplay

const sidecarPath = INPUT.replace(/\.[^.]+$/, "") + ".captions.json";
let captions;
if (fs.existsSync(sidecarPath)) {
  captions = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
} else {
  // Fallback: derive from screenplay + timeline (re-run highlights' logic).
  const ctx = loadContext({
    inputMp4: INPUT,
    screenplayPath: SCREENPLAY,
    timelinePath: TIMELINE,
    targetWindowId: TARGET_WINDOW,
  });
  captions = [];
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
}

const outSidecar = OUTPUT.replace(/\.[^.]+$/, "") + ".captions.json";
fs.writeFileSync(outSidecar, JSON.stringify(captions, null, 2) + "\n");

if (!BURN || captions.length === 0) {
  const reason = !BURN ? "(--no-captions)" : "(no captions)";
  console.log(`Captions ${reason}; copying through → ${OUTPUT}`);
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
  process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------
// probe output dimensions (overlay coords are in OUTPUT-frame pixels)

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "csv=p=0", INPUT,
]);
if (probe.status !== 0) {
  console.error("ffprobe failed:", probe.stderr.toString());
  process.exit(4);
}
const [outW, outH] = probe.stdout.toString().trim().split(",").map(Number);
const fontSize = FONT_SIZE_OV ?? Math.max(28, Math.round(outH * 0.04));

// ---------------------------------------------------------------------------
// render each caption as a transparent PNG via deskagent text-png

const tmpDir = path.join(os.tmpdir(), `demo-captions-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const captionPngs = [];
for (let i = 0; i < captions.length; i++) {
  const c = captions[i];
  const pngPath = path.join(tmpDir, `c${i}.png`);
  const r = spawnSync(DESKAGENT, [
    "text-png",
    "--text", c.text,
    "--out",  pngPath,
    "--font-size", String(fontSize),
    "--max-width", String(Math.round(outW * 0.7)),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    console.error(`deskagent text-png failed for caption ${i}: ${r.stderr?.toString() ?? ""}`);
    process.exit(7);
  }
  captionPngs.push({
    pngPath,
    tin:  c.startMs / 1000,
    tout: c.endMs / 1000,
  });
}

// ---------------------------------------------------------------------------
// filtergraph: chain N overlays on the input. All caption coords are in
// output-frame pixels — zoom/speed never touch these.

const chain = [];
let lastLabel = "[0:v]";
captionPngs.forEach((c, i) => {
  const next = `[c${i}]`;
  const x = `(W-overlay_w)/2`;
  const y = `${CAPTION_Y}*H - overlay_h/2`;
  chain.push(
    `${lastLabel}[${i + 1}:v] overlay=x=${x}:y=${y}:shortest=1:` +
    `enable='between(t,${c.tin.toFixed(3)},${c.tout.toFixed(3)})' ${next}`
  );
  lastLabel = next;
});
chain.push(`${lastLabel} null [vout]`);

const args = ["-y", "-i", INPUT];
captionPngs.forEach((c) => args.push("-loop", "1", "-i", c.pngPath));
args.push(
  "-filter_complex", chain.join(";\n"),
  "-map", "[vout]",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-shortest",
  "-an",
  OUTPUT,
);

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg captions pass failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
// sidecar already written explicitly above; meta carries over.
propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
console.log(`Captions burned → ${OUTPUT}  (${captions.length} captions, y=${CAPTION_Y}, font=${fontSize}px)`);
