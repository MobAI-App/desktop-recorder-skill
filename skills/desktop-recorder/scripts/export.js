#!/usr/bin/env node
// One-shot end-user CLI. Loads the editor context once, calls each stage's
// `generate()` to collect filter fragments, assembles them into one
// filter_complex, and runs ffmpeg ONCE to produce the final mp4 in a single
// decode→filter→encode pass.
//
// CLI:
//   node scripts/export.js <recordingDir> <screenplay> <timeline> <out.mp4> [format]
//       [--quality standard|high|h264|pro]   default: high
//       [--width N --height N]               explicit output dims (override format)
//       [--skip compose|highlights|zoom|captions|speedups]  (repeatable)
//       [--dry-run]                                   prints assembled ffmpeg cmd
//       [--debug]                                     also prints filtergraph
//
// `format` is optional. When omitted, the export sizes to the user's main
// display's native pixel resolution (so QuickTime plays the result 1:1 on
// this machine). Named formats:
//   display | horizontal_16_9 | square_1_1 | vertical_9_16 | hd_720 | uhd_4k
// --width/--height override any format choice with an exact pixel size.

const { loadContext } = require("./lib/screenplay");
const { joinFilters } = require("./lib/filtergraph");
const { encoderArgs, formatSize, runFfmpeg } = require("./lib/ffmpeg");

const compose    = require("./stages/compose");
const highlights = require("./stages/highlights");
const zoom       = require("./stages/zoom");
const captions   = require("./stages/captions");
const speedups   = require("./stages/speedups");

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    console.error("usage: export.js <recordingDir> <screenplay> <timeline> <out.mp4> [format] [--quality Q] [--width N --height N] [--skip stage]... [--dry-run] [--debug]");
    process.exit(2);
  }
  const [recordingDir, screenplay, timeline, outMp4] = argv.slice(0, 4);
  // 5th positional is optional (format name). If it looks like a flag, treat it as flags-only.
  const maybeFormat = argv[4];
  const formatPositional = (maybeFormat && !maybeFormat.startsWith("--")) ? maybeFormat : null;
  const flagsStart = formatPositional ? 5 : 4;
  const opts = parseFlags(argv.slice(flagsStart));
  // Precedence: --width/--height override > format positional > display default.
  const format = formatPositional;

  const ctx = loadContext({ recordingDir, screenplayPath: screenplay, timelinePath: timeline });

  const fragments = [];

  // compose provides the clip inputs every other stage chains off, so it
  // can't be skipped.
  if (opts.skip.has("compose")) {
    console.error("error: --skip compose is not supported (compose provides the per-source clip inputs every other stage chains off of)");
    process.exit(2);
  }

  let lastOut = null;
  {
    const f = compose.generate(ctx);
    fragments.push({ name: "compose", f });
    lastOut = f.outputs;
  }
  function chainStage(name, mod) {
    if (opts.skip.has(name)) return;
    const f = mod.generate(ctx, { inputLabel: lastOut });
    fragments.push({ name, f });
    lastOut = f.outputs;
  }
  chainStage("highlights", highlights);
  chainStage("zoom",       zoom);
  chainStage("captions",   captions);
  chainStage("speedups",   speedups);

  if (fragments.length === 0) {
    console.error("error: every stage was --skip'd; nothing to do");
    process.exit(2);
  }

  // Output size precedence: --width/--height > positional format > display native.
  let fmtW, fmtH;
  if (opts.width != null && opts.height != null) {
    fmtW = opts.width; fmtH = opts.height;
  } else {
    [fmtW, fmtH] = formatSize(format);
  }
  const lastLabel = lastOut.replace(/^\[|\]$/g, "");
  const finalFilters = [
    `[${lastLabel}]scale=${fmtW}:${fmtH}:force_original_aspect_ratio=decrease,` +
    `pad=${fmtW}:${fmtH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[final]`,
  ];

  // ${capInput<N>} → absolute ffmpeg input index: prior stages' extraInputs
  // are added to argv before this stage's, so offset by their running count.
  let runningOffset = 0;
  const allFilters = [];
  for (const { name, f } of fragments) {
    const offset = runningOffset;
    const localCount = f.extraInputs?.length ?? 0;
    // A declared-but-unreferenced extraInput is a dangling -i: decoded, wasted.
    const filterJoined = (f.filters ?? []).join(";");
    for (let i = 0; i < localCount; i++) {
      if (!filterJoined.includes(`\${capInput${i}}`)) {
        process.stderr.write(`warn: stage "${name}" declared extraInputs[${i}] but no filter references \${capInput${i}} - input will be loaded but unused\n`);
      }
    }
    const localFilters = f.filters.map((s) => substituteInputs(s, offset, localCount));
    allFilters.push(...localFilters);
    runningOffset += localCount;
  }
  allFilters.push(...finalFilters);

  const args = ["-y"];
  for (const { f } of fragments) {
    for (const e of f.extraInputs ?? []) args.push(...e.argv);
  }
  args.push("-filter_complex", joinFilters(allFilters));
  args.push("-map", "[final]");
  const finalDuration = computeFinalDuration(ctx, fragments);
  if (finalDuration != null) args.push("-t", finalDuration.toFixed(3));
  args.push(...encoderArgs(opts.quality));
  args.push(outMp4);

  if (opts.debug) {
    process.stderr.write("=== filtergraph ===\n" + joinFilters(allFilters) + "\n");
  }
  const r = runFfmpeg(args, { dryRun: opts.dryRun });
  if (!opts.dryRun) {
    process.stderr.write(`\nstages: ${fragments.map((x) => x.name).join(" → ")} → encode(${opts.quality})\n`);
    process.stderr.write(`output: ${outMp4}\n`);
  }
  process.exit(r.status ?? 0);
}

function substituteInputs(filterStr, offset, localInputCount) {
  return filterStr.replace(/\$\{capInput(\d+)\}/g, (_, n) => {
    const local = Number(n);
    if (local >= localInputCount) {
      throw new Error(`stage referenced capInput${local} but only declared ${localInputCount} extraInputs`);
    }
    return String(offset + local);
  });
}

function computeFinalDuration(ctx, fragments) {
  // Source time after the last warp segment still plays at 1× and adds to
  // the final length, so account for that tail beyond last.dstEnd.
  let dur = ctx.shared.durationSec;
  for (const { f } of fragments) {
    const tw = f.sidecars?.timewarp;
    if (Array.isArray(tw) && tw.length > 0) {
      const last = tw[tw.length - 1];
      const tailSrc = Math.max(0, ctx.shared.durationSec - last.srcEnd);
      dur = last.dstEnd + tailSrc;
    }
  }
  return dur;
}

function parseFlags(rest) {
  const opts = { quality: "high", skip: new Set(), dryRun: false, debug: false, width: null, height: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--quality") { opts.quality = rest[++i]; continue; }
    if (a === "--width")   { opts.width  = Number(rest[++i]); continue; }
    if (a === "--height")  { opts.height = Number(rest[++i]); continue; }
    if (a === "--skip")    { opts.skip.add(rest[++i]); continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--debug")   { opts.debug = true; continue; }
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
  if (!["standard", "high", "h264", "pro"].includes(opts.quality)) {
    console.error(`unknown --quality: ${opts.quality}`);
    process.exit(2);
  }
  if ((opts.width != null) !== (opts.height != null)) {
    console.error(`--width and --height must be set together`);
    process.exit(2);
  }
  if (opts.width != null && (!Number.isFinite(opts.width) || opts.width <= 0 || !Number.isFinite(opts.height) || opts.height <= 0)) {
    console.error(`--width/--height must be positive integers`);
    process.exit(2);
  }
  return opts;
}

if (require.main === module) main();
