#!/usr/bin/env node
// add_speedups.js <input.mp4> <screenplay.json> <timeline.json> <output.mp4>
//
// Variable-speed playback. Each scene.speed becomes one segment; gaps fill
// with factor=1. Emits <output>.timewarp.json and remaps <input>.captions.json
// through the warp so trim/export can map source-time bounds to dst-time.

const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadContext, propagateSidecars } = require("./lib/screenplay");

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("usage: add_speedups.js <input.mp4> <screenplay.json> <timeline.json> <output.mp4> [flags]");
  process.exit(2);
}
const [INPUT, SCREENPLAY, TIMELINE, OUTPUT] = argv.slice(0, 4);

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
function numFlag(name) { const v = flag(name, null); return v == null ? null : Number(v); }

const TARGET_WINDOW = numFlag("--target-window");
const DEBUG         = argv.includes("--debug");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: INPUT, screenplayPath: SCREENPLAY, timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

const srcDuration = probeDuration(INPUT);

const speedSpecs = collectSpeedSpecs(ctx.screenplay.scenes);

if (speedSpecs.length === 0) {
  const identity = { segments: [{ srcStart: 0, srcEnd: srcDuration, dstStart: 0, dstEnd: srcDuration, factor: 1 }] };
  fs.writeFileSync(OUTPUT + ".timewarp.json", JSON.stringify(identity, null, 2) + "\n");
  remapCaptions(identity);
  console.log("No speed directives; copying through with identity timewarp.");
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
  process.exit(r.status ?? 0);
}

const segments = buildSegments(speedSpecs, srcDuration);
const totalDst = segments[segments.length - 1].dstEnd;

console.log(`Speed segments: ${segments.length}  (src ${srcDuration.toFixed(2)}s -> dst ${totalDst.toFixed(2)}s)`);
for (const s of segments) {
  const tag = s.factor === 1 ? "" : `  (${s.factor.toFixed(2)}x)`;
  console.log(`  [${s.srcStart.toFixed(2)}..${s.srcEnd.toFixed(2)}]s src -> [${s.dstStart.toFixed(2)}..${s.dstEnd.toFixed(2)}]s dst${tag}`);
}

const timewarp = { segments: segments.map((s) => ({
  srcStart: round(s.srcStart), srcEnd: round(s.srcEnd),
  dstStart: round(s.dstStart), dstEnd: round(s.dstEnd),
  factor: s.factor,
})) };
fs.writeFileSync(OUTPUT + ".timewarp.json", JSON.stringify(timewarp, null, 2) + "\n");
console.log(`Timewarp -> ${OUTPUT}.timewarp.json`);
remapCaptions(timewarp);

const filtergraph = buildFiltergraph(segments);
if (DEBUG) { console.error("=== filtergraph ===\n" + filtergraph); }

const r = spawnSync("ffmpeg", [
  "-y", "-i", INPUT,
  "-filter_complex", filtergraph, "-map", "[vout]",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", "-an",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 6);
}
propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
console.log(`Speedups -> ${OUTPUT}`);

// ---------------------------------------------------------------------------

function round(n) { return Math.round(n * 1000) / 1000; }

function probeDuration(input) {
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=duration", "-of", "csv=p=0", input,
  ]);
  if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
  const d = Number(probe.stdout.toString().trim());
  if (!(d > 0)) { console.error(`could not determine source duration for ${input}`); process.exit(4); }
  return d;
}

function normalizeSpeed(scene) {
  const sp = scene.speed;
  if (sp == null) return null;
  if (typeof sp === "number") return { factor: sp, fromAction: null, toAction: null };
  if (typeof sp !== "object") {
    console.error(`scene "${scene.id}" speed must be a number or an object`);
    process.exit(2);
  }
  return { factor: Number(sp.factor), fromAction: sp.fromAction ?? null, toAction: sp.toAction ?? null };
}

function collectSpeedSpecs(scenes) {
  const specs = [];
  for (const scene of scenes) {
    const spec = normalizeSpeed(scene);
    if (!spec) continue;
    if (!(spec.factor > 0) || spec.factor === 1) {
      console.error(`scene "${scene.id}" speed.factor must be > 0 and != 1 (got ${spec.factor})`);
      process.exit(2);
    }
    const range = ctx.resolveActionRange({
      sceneId: scene.id, fromAction: spec.fromAction, toAction: spec.toAction,
    });
    specs.push({ sceneId: scene.id, srcStart: range.tStart, srcEnd: range.tEnd, factor: spec.factor });
  }
  specs.sort((a, b) => a.srcStart - b.srcStart);
  for (let i = 1; i < specs.length; i++) {
    if (specs[i].srcStart < specs[i - 1].srcEnd) {
      console.error(`overlapping speed segments: "${specs[i - 1].sceneId}" and "${specs[i].sceneId}"`);
      process.exit(2);
    }
  }
  return specs;
}

function buildSegments(speedSpecs, totalSrc) {
  const segs = [];
  let cursor = 0;
  for (const s of speedSpecs) {
    if (s.srcStart > cursor) segs.push({ srcStart: cursor, srcEnd: s.srcStart, factor: 1 });
    segs.push({ srcStart: s.srcStart, srcEnd: Math.min(s.srcEnd, totalSrc), factor: s.factor });
    cursor = Math.min(s.srcEnd, totalSrc);
  }
  if (cursor < totalSrc) segs.push({ srcStart: cursor, srcEnd: totalSrc, factor: 1 });

  let dstCursor = 0;
  for (const seg of segs) {
    const dstDur = (seg.srcEnd - seg.srcStart) / seg.factor;
    seg.dstStart = dstCursor;
    seg.dstEnd   = dstCursor + dstDur;
    dstCursor += dstDur;
  }
  return segs;
}

function buildFiltergraph(segments) {
  const chain = segments.map((s, i) =>
    `[0:v]trim=start=${s.srcStart.toFixed(6)}:end=${s.srcEnd.toFixed(6)},` +
    `setpts=(PTS-STARTPTS)/${s.factor}[s${i}]`
  );
  const concatIn = segments.map((_, i) => `[s${i}]`).join("");
  chain.push(`${concatIn}concat=n=${segments.length}:v=1:a=0[vout]`);
  return chain.join(";\n");
}

function remapCaptions(warp) {
  const inCap = INPUT.replace(/\.[^.]+$/, "") + ".captions.json";
  if (!fs.existsSync(inCap)) return;
  const captions = JSON.parse(fs.readFileSync(inCap, "utf8"));
  const remapped = captions.map((c) => ({
    startMs: Math.round(srcSecondsToDst(c.startMs / 1000, warp) * 1000),
    endMs:   Math.round(srcSecondsToDst(c.endMs   / 1000, warp) * 1000),
    text:    c.text,
  }));
  const outCap = OUTPUT.replace(/\.[^.]+$/, "") + ".captions.json";
  fs.writeFileSync(outCap, JSON.stringify(remapped, null, 2) + "\n");
  console.log(`Captions remapped -> ${outCap}`);
}

function srcSecondsToDst(srcSec, warp) {
  for (const seg of warp.segments) {
    if (srcSec >= seg.srcStart && srcSec <= seg.srcEnd) {
      const dur = seg.srcEnd - seg.srcStart;
      const u = dur > 0 ? (srcSec - seg.srcStart) / dur : 0;
      return seg.dstStart + u * (seg.dstEnd - seg.dstStart);
    }
  }
  return warp.segments[warp.segments.length - 1].dstEnd;
}
