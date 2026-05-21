#!/usr/bin/env node
// export_video.js <input.mp4> <screenplay.json> <timeline.json> <out.mp4> <format>
//
// format in { vertical_9_16, horizontal_16_9, square_1_1 }.
// Trim bounds come from screenplay.trim (scene ids); a <input>.timewarp.json
// next to the input maps source-time bounds to dst-time before cutting.

const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadContext } = require("./lib/screenplay");

const argv = process.argv.slice(2);
if (argv.length < 5) {
  console.error("usage: export_video.js <input.mp4> <screenplay.json> <timeline.json> <out.mp4> <format> [flags]");
  process.exit(2);
}
const [INPUT, SCREENPLAY, TIMELINE, OUTPUT, FORMAT] = argv.slice(0, 5);

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
const TARGET_WINDOW = (() => { const v = flag("--target-window", null); return v == null ? null : Number(v); })();

const FORMATS = {
  vertical_9_16:   { w: 1080, h: 1920 },
  horizontal_16_9: { w: 1920, h: 1080 },
  square_1_1:      { w: 1080, h: 1080 },
};
if (!FORMATS[FORMAT]) {
  console.error(`unknown format "${FORMAT}". Valid: ${Object.keys(FORMATS).join(", ")}`);
  process.exit(2);
}
const { w: TW, h: TH } = FORMATS[FORMAT];

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadContext({
  inputMp4: INPUT, screenplayPath: SCREENPLAY, timelinePath: TIMELINE,
  targetWindowId: TARGET_WINDOW,
});

const sceneIds = ctx.screenplay.scenes.map((s) => s.id);
if (sceneIds.length === 0) { console.error(`screenplay has no scenes; nothing to export`); process.exit(2); }

const trim = ctx.screenplay.trim || {};
const headScene = trim.beforeScene ?? sceneIds[0];
const tailScene = trim.afterScene  ?? sceneIds[sceneIds.length - 1];

const headRange = ctx.sceneRanges.get(headScene);
const tailRange = ctx.sceneRanges.get(tailScene);
if (!headRange) { console.error(`trim.beforeScene "${headScene}" not in timeline`); process.exit(2); }
if (!tailRange) { console.error(`trim.afterScene "${tailScene}" not in timeline`);   process.exit(2); }

const srcStart = Math.max(0, headRange.tStart);
const srcEnd   = tailRange.tEnd + 0.6;

const warpPath = INPUT + ".timewarp.json";
let dstStart = srcStart, dstEnd = srcEnd;
if (fs.existsSync(warpPath)) {
  const warp = JSON.parse(fs.readFileSync(warpPath, "utf8"));
  dstStart = srcSecondsToDst(srcStart, warp);
  dstEnd   = srcSecondsToDst(srcEnd,   warp);
  console.log(`Trim (src ${srcStart.toFixed(2)}s..${srcEnd.toFixed(2)}s) -> (dst ${dstStart.toFixed(2)}s..${dstEnd.toFixed(2)}s)`);
} else {
  console.log(`Trim (${srcStart.toFixed(2)}s..${srcEnd.toFixed(2)}s)  format=${FORMAT}  ${TW}x${TH}`);
}

const vf = `scale=w='if(gt(a,${TW}/${TH}),${TW},-2)':h='if(gt(a,${TW}/${TH}),-2,${TH})',` +
           `pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

const r = spawnSync("ffmpeg", [
  "-y", "-ss", dstStart.toFixed(3), "-to", dstEnd.toFixed(3), "-i", INPUT,
  "-vf", vf,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", "-an",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
console.log(`Exported -> ${OUTPUT}`);

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
