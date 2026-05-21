#!/usr/bin/env node
// add_captions.js <input.mp4> <screenplay.json> <timeline.json> <out.mp4>
//
// Burns captions at viewport-fixed coords. Runs AFTER add_zoom so the zoom
// transformation can't crop captions out of frame.

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
function numFlag(name) { const v = flag(name, null); return v == null ? null : Number(v); }

const TARGET_WINDOW = numFlag("--target-window");
const CAPTION_Y     = Number(flag("--caption-y", "0.85"));
const FONT_SIZE_OV  = numFlag("--caption-font-size");
const BURN          = !argv.includes("--no-captions");
const DESKAGENT     = process.env.DESKAGENT || "deskagent";

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: INPUT, screenplayPath: SCREENPLAY, timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

const captions = loadCaptions(ctx);

const outSidecar = OUTPUT.replace(/\.[^.]+$/, "") + ".captions.json";
fs.writeFileSync(outSidecar, JSON.stringify(captions, null, 2) + "\n");

if (!BURN || captions.length === 0) {
  const reason = !BURN ? "(--no-captions)" : "(no captions)";
  console.log(`Captions ${reason}; copying through -> ${OUTPUT}`);
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
  process.exit(r.status ?? 0);
}

const [outW, outH] = probeWH(INPUT);
const fontSize = FONT_SIZE_OV ?? Math.max(28, Math.round(outH * 0.04));

const captionPngs = renderCaptionPngs(captions, outW, fontSize);
const filtergraph = buildFiltergraph(captionPngs);

const args = ["-y", "-i", INPUT];
captionPngs.forEach((c) => args.push("-loop", "1", "-i", c.pngPath));
args.push(
  "-filter_complex", filtergraph,
  "-map", "[vout]",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-shortest", "-an",
  OUTPUT,
);

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg captions pass failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
console.log(`Captions burned -> ${OUTPUT}  (${captions.length} captions, y=${CAPTION_Y}, font=${fontSize}px)`);

// ---------------------------------------------------------------------------

function loadCaptions(ctx) {
  const sidecarPath = INPUT.replace(/\.[^.]+$/, "") + ".captions.json";
  if (fs.existsSync(sidecarPath)) return JSON.parse(fs.readFileSync(sidecarPath, "utf8"));

  const out = [];
  for (const scene of ctx.screenplay.scenes) {
    if (!scene.caption) continue;
    const range = ctx.sceneRanges.get(scene.id);
    if (!range) continue;
    out.push({
      startMs: Math.round(range.tStart * 1000),
      endMs:   Math.round(range.tEnd   * 1000),
      text:    scene.caption,
    });
  }
  return out;
}

function probeWH(input) {
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0", input,
  ]);
  if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
  return probe.stdout.toString().trim().split(",").map(Number);
}

function renderCaptionPngs(captions, outW, fontSize) {
  const tmpDir = path.join(os.tmpdir(), `demo-captions-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return captions.map((c, i) => {
    const pngPath = path.join(tmpDir, `c${i}.png`);
    const r = spawnSync(DESKAGENT, [
      "text-png",
      "--text", c.text, "--out", pngPath,
      "--font-size", String(fontSize),
      "--max-width", String(Math.round(outW * 0.7)),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    if (r.status !== 0) {
      console.error(`deskagent text-png failed for caption ${i}: ${r.stderr?.toString() ?? ""}`);
      process.exit(7);
    }
    return { pngPath, tin: c.startMs / 1000, tout: c.endMs / 1000 };
  });
}

function buildFiltergraph(captionPngs) {
  const chain = [];
  let last = "[0:v]";
  captionPngs.forEach((c, i) => {
    const next = `[c${i}]`;
    const x = `(W-overlay_w)/2`;
    const y = `${CAPTION_Y}*H - overlay_h/2`;
    chain.push(
      `${last}[${i + 1}:v] overlay=x=${x}:y=${y}:shortest=1:` +
      `enable='between(t,${c.tin.toFixed(3)},${c.tout.toFixed(3)})' ${next}`
    );
    last = next;
  });
  chain.push(`${last} null [vout]`);
  return chain.join(";\n");
}
