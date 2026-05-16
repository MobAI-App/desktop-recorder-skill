#!/usr/bin/env node
/**
 * Variable-speed playback from screenplay.scenes[].speed.
 *
 *   node add_speedups.js <input.mp4> <screenplay.json> <timeline.json> <output.mp4> [flags]
 *
 * Scene-level speed directive shape:
 *   "speed": 5.0                            // factor > 1 = faster, < 1 = slower
 *   "speed": { "factor": 5.0,
 *              "fromAction": "scene/0",     // optional sub-range scope
 *              "toAction":   "scene/2" }    //   half-open
 *
 * Pipeline order: highlights → zoom → speedups → export. Speedups run AFTER
 * geometry overlays so burned-in pixels (ripples, cursor, captions) come
 * along for free. Anything that lives in source-time gets remapped:
 *   - emits <output>.timewarp.json (src↔dst segments) for downstream consumers
 *   - rewrites <input>.captions.json → <output>.captions.json through the warp
 *
 * Flags:
 *   --target-window <id>   REQUIRED for multi-window meta sidecars.
 *   --debug                print the ffmpeg filtergraph on stderr.
 */

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
const TARGET_WINDOW = (() => { const v = flag("--target-window", null); return v == null ? null : Number(v); })();
const DEBUG         = argv.includes("--debug");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: INPUT,
  screenplayPath: SCREENPLAY,
  timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

// ---------------------------------------------------------------------------
// probe source duration (authoritative — speedups span the whole file)

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=duration",
  "-of", "csv=p=0", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const srcDuration = Number(probe.stdout.toString().trim());
if (!(srcDuration > 0)) {
  console.error(`could not determine source duration for ${INPUT}`);
  process.exit(4);
}

// ---------------------------------------------------------------------------
// collect speedup segments from screenplay

function normalizeSpeed(scene) {
  const sp = scene.speed;
  if (sp == null) return null;
  if (typeof sp === "number") return { factor: sp, fromAction: null, toAction: null };
  if (typeof sp !== "object") {
    console.error(`scene "${scene.id}" speed must be a number or an object`);
    process.exit(2);
  }
  return {
    factor:     Number(sp.factor),
    fromAction: sp.fromAction ?? null,
    toAction:   sp.toAction   ?? null,
  };
}

const speedSpecs = [];
for (const scene of ctx.screenplay.scenes) {
  const spec = normalizeSpeed(scene);
  if (!spec) continue;
  if (!(spec.factor > 0) || spec.factor === 1) {
    console.error(`scene "${scene.id}" speed.factor must be > 0 and != 1 (got ${spec.factor})`);
    process.exit(2);
  }
  const range = ctx.resolveActionRange({
    sceneId: scene.id,
    fromAction: spec.fromAction,
    toAction:   spec.toAction,
  });
  speedSpecs.push({
    sceneId: scene.id,
    srcStart: range.tStart,
    srcEnd:   range.tEnd,
    factor:   spec.factor,
  });
}

if (speedSpecs.length === 0) {
  console.log("No scene-level speed directives; copying through and emitting identity timewarp.");
  const identity = {
    segments: [{ srcStart: 0, srcEnd: srcDuration, dstStart: 0, dstEnd: srcDuration, factor: 1 }],
  };
  fs.writeFileSync(OUTPUT + ".timewarp.json", JSON.stringify(identity, null, 2) + "\n");
  remapCaptionsIfPresent(identity);
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  // captions handled by remapCaptionsIfPresent; meta propagates normally.
  propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
  process.exit(r.status ?? 0);
}

speedSpecs.sort((a, b) => a.srcStart - b.srcStart);
for (let i = 1; i < speedSpecs.length; i++) {
  if (speedSpecs[i].srcStart < speedSpecs[i - 1].srcEnd) {
    console.error(`overlapping speed segments: scene "${speedSpecs[i - 1].sceneId}" and "${speedSpecs[i].sceneId}"`);
    process.exit(2);
  }
}

// Fill gaps with factor=1 segments so the whole timeline is covered.
const segments = [];
let cursor = 0;
for (const s of speedSpecs) {
  if (s.srcStart > cursor) {
    segments.push({ srcStart: cursor, srcEnd: s.srcStart, factor: 1 });
  }
  segments.push({ srcStart: s.srcStart, srcEnd: Math.min(s.srcEnd, srcDuration), factor: s.factor });
  cursor = Math.min(s.srcEnd, srcDuration);
}
if (cursor < srcDuration) {
  segments.push({ srcStart: cursor, srcEnd: srcDuration, factor: 1 });
}

// Compute dst times cumulatively.
let dstCursor = 0;
for (const seg of segments) {
  const srcDur = seg.srcEnd - seg.srcStart;
  const dstDur = srcDur / seg.factor;
  seg.dstStart = dstCursor;
  seg.dstEnd   = dstCursor + dstDur;
  dstCursor += dstDur;
}

console.log(`Speed segments: ${segments.length}  (src ${srcDuration.toFixed(2)}s → dst ${dstCursor.toFixed(2)}s)`);
for (const s of segments) {
  const tag = s.factor === 1 ? "" : `  (${s.factor.toFixed(2)}x)`;
  console.log(`  [${s.srcStart.toFixed(2)}..${s.srcEnd.toFixed(2)}]s src → [${s.dstStart.toFixed(2)}..${s.dstEnd.toFixed(2)}]s dst${tag}`);
}

// ---------------------------------------------------------------------------
// emit timewarp.json + remap captions sidecar

const timewarp = {
  segments: segments.map((s) => ({
    srcStart: round(s.srcStart),
    srcEnd:   round(s.srcEnd),
    dstStart: round(s.dstStart),
    dstEnd:   round(s.dstEnd),
    factor:   s.factor,
  })),
};
const warpPath = OUTPUT + ".timewarp.json";
fs.writeFileSync(warpPath, JSON.stringify(timewarp, null, 2) + "\n");
console.log(`Timewarp → ${warpPath}`);

remapCaptionsIfPresent(timewarp);

// ---------------------------------------------------------------------------
// build ffmpeg filtergraph: trim each segment, setpts to retime, then concat

const chain = [];
segments.forEach((s, i) => {
  chain.push(
    `[0:v]trim=start=${s.srcStart.toFixed(6)}:end=${s.srcEnd.toFixed(6)},` +
    `setpts=(PTS-STARTPTS)/${s.factor}[s${i}]`
  );
});
const concatIn = segments.map((_, i) => `[s${i}]`).join("");
chain.push(`${concatIn}concat=n=${segments.length}:v=1:a=0[vout]`);

const filtergraph = chain.join(";\n");

if (DEBUG) {
  console.error("=== filtergraph ===");
  console.error(filtergraph);
}

const r = spawnSync("ffmpeg", [
  "-y",
  "-i", INPUT,
  "-filter_complex", filtergraph,
  "-map", "[vout]",
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
// captions already remapped explicitly; meta carries over as-is.
propagateSidecars(INPUT, OUTPUT, { skipCaptions: true });
console.log(`Speedups → ${OUTPUT}`);

// ---------------------------------------------------------------------------

function round(n) { return Math.round(n * 1000) / 1000; }

function remapCaptionsIfPresent(warp) {
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
  console.log(`Captions remapped → ${outCap}`);
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
