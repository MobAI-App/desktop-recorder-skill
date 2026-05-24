#!/usr/bin/env node
// Stage 1: compose - places per-source clips on the canvas background.
// Output label: [afterCompose] (carries alpha).
//
//   node stages/compose.js generate <recordingDir> <screenplay> <timeline> [--apply <out.mov>]

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadContext } = require("../lib/screenplay");
const { runFfmpeg } = require("../lib/ffmpeg");

function generate(ctx) {
  const { composition, shared, manifest, recordingDir } = ctx;
  const placements = composition.placements;

  const filters = [];
  const extraInputs = [];
  const W = composition.canvasW, H = composition.canvasH;

  // Clips occupy input indices 0..N-1; the background (if an image) is
  // appended AFTER so these indices stay stable.
  placements.forEach((p) => {
    const headTrim = shared.headTrimsByPath[p.clip.path] ?? 0;
    const inputArgv = [];
    if (headTrim > 0) inputArgv.push("-ss", headTrim.toFixed(3));
    inputArgv.push("-t", shared.durationSec.toFixed(3));
    inputArgv.push("-i", path.join(recordingDir, p.clip.path));
    extraInputs.push({ argv: inputArgv });
  });

  const bg = resolveBackground(composition.background, W, H);
  if (bg.imagePath) {
    const bgInputIdx = extraInputs.length;
    extraInputs.push({ argv: ["-loop", "1", "-i", bg.imagePath] });
    filters.push(
      `[${bgInputIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},format=yuva420p,fps=${manifest.fps},setpts=PTS-STARTPTS[bg0]`,
    );
  } else {
    filters.push(`color=c=${bg.colorHex}:s=${W}x${H}:r=${manifest.fps}[bg0]`);
  }

  let lastLabel = "bg0";
  placements.forEach((p, i) => {
    const { fitW, fitH, ox, oy } = p.fit;
    const scaled = `c${i}s`;
    filters.push(`[${i}:v]scale=${fitW}:${fitH},setpts=PTS-STARTPTS[${scaled}]`);
    const isLast = (i === placements.length - 1);
    const out = isLast ? "afterCompose" : `bg${i + 1}`;
    // No shortest= on overlay: the bg color source is infinite and export.js
    // bounds length via -t. shortest=1 would clip a frame early when the
    // last clip's reported duration is just under the shared window.
    filters.push(`[${lastLabel}][${scaled}]overlay=${ox}:${oy}[${out}]`);
    lastLabel = out;
  });

  return {
    filters,
    inputs: [],
    outputs: "[afterCompose]",
    extraInputs,
    sidecars: {},
  };
}

function apply(ctx, outPath, { dryRun = false } = {}) {
  const fragment = generate(ctx);
  const args = ["-y"];
  for (const e of fragment.extraInputs) args.push(...e.argv);
  args.push("-filter_complex", fragment.filters.join(";"));
  args.push("-map", fragment.outputs);
  args.push("-t", ctx.shared.durationSec.toFixed(3));
  args.push("-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le");
  args.push(outPath);
  return runFfmpeg(args, { dryRun });
}

function resolveBackground(spec, W, H) {
  if (typeof spec !== "string" || spec === "" || spec === "none") {
    return { colorHex: "0x000000@1.0" };
  }
  if (spec.startsWith("color:")) {
    const hex = spec.slice("color:".length).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
      throw new Error(`invalid background color (expected color:RRGGBB): ${spec}`);
    }
    return { colorHex: `0x${hex.toLowerCase()}` };
  }
  if (spec === "dark" || spec === "light") {
    return { imagePath: cachedGradient(spec, W, H) };
  }
  if (spec.startsWith("image:")) {
    const p = spec.slice("image:".length);
    if (!fs.existsSync(p)) {
      throw new Error(`composition.background image not found: ${p}`);
    }
    return { imagePath: p };
  }
  throw new Error(`unsupported composition.background: ${spec} (try color:RRGGBB, dark, light, image:PATH, none)`);
}

// Cached so repeated exports skip the per-pixel geq render.
function cachedGradient(kind, W, H) {
  const cache = path.join(process.env.HOME || os.tmpdir(), ".cache", "deskagent-skill");
  fs.mkdirSync(cache, { recursive: true });
  const target = path.join(cache, `gradient-${kind}-${W}x${H}.png`);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  const [top, bot] = kind === "dark"
    ? [[26, 26, 33], [10, 11, 16]]
    : [[246, 247, 250], [221, 224, 236]];
  const expr = (i) => `(${top[i]}+(${bot[i]}-${top[i]})*Y/H)`;
  const args = [
    "-y", "-f", "lavfi",
    "-i", `color=c=black:s=${W}x${H}:r=1:d=0.04`,
    "-vf", `format=rgba,geq=r='${expr(0)}':g='${expr(1)}':b='${expr(2)}':a=255`,
    "-frames:v", "1",
    target,
  ];
  const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`failed to render ${kind} gradient bg`);
  return target;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd !== "generate") {
    console.error("usage: compose.js generate <recordingDir> <screenplay> <timeline> [--apply <out.mov>] [--debug]");
    process.exit(2);
  }
  const applyIdx = argv.indexOf("--apply");
  const dryRun = argv.includes("--dry-run");
  let applyOut = null;
  if (applyIdx >= 0) {
    applyOut = argv[applyIdx + 1];
    argv.splice(applyIdx, 2);
  }
  if (argv.length < 3) {
    console.error("missing positional args: <recordingDir> <screenplay> <timeline>");
    process.exit(2);
  }
  const [recordingDir, screenplay, timeline] = argv;
  const ctx = loadContext({ recordingDir, screenplayPath: screenplay, timelinePath: timeline });
  if (applyOut) {
    const r = apply(ctx, applyOut, { dryRun });
    process.exit(r.status ?? 0);
  } else {
    const f = generate(ctx);
    process.stdout.write(JSON.stringify(f, null, 2) + "\n");
  }
}

module.exports = { generate, apply };
