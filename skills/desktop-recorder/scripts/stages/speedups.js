#!/usr/bin/env node
// Stage 5: speedups
//
// Time-warp via setpts. Each screenplay.speed[] entry compresses or expands
// its range by `factor`. Outside any entry, factor=1.
//
// Input  label: [afterCaptions]
// Output label: [afterSpeedups]
//
// sidecars.timewarp: piecewise src↔dst seconds map (for export.js trim math).

const { loadContext } = require("../lib/screenplay");
const { runFfmpeg } = require("../lib/ffmpeg");

function generate(ctx, { inputLabel = "[afterCaptions]" } = {}) {
  const entries = Array.isArray(ctx.screenplay.speed) ? ctx.screenplay.speed : [];
  if (entries.length === 0) {
    return passThrough(inputLabel, "[afterSpeedups]");
  }

  const segments = entries.map((s, i) => {
    const label = `speed[${i}]`;
    const factor = Number(s.factor);
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) {
      fatal(`${label}: factor must be > 0 and != 1 (got ${s.factor})`);
    }
    const range = ctx.resolveActionRange({
      fromAction: s.fromAction, toAction: s.toAction,
      startDelayMs: s.startDelayMs, endDelayMs: s.endDelayMs,
      label,
    });
    return { tStart: range.tStart, tEnd: range.tEnd, factor };
  }).sort((a, b) => a.tStart - b.tStart);

  // Overlap check
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1], cur = segments[i];
    if (cur.tStart < prev.tEnd - 1e-3) {
      fatal(
        `screenplay.speed[${i - 1}] [${prev.tStart.toFixed(2)}s..${prev.tEnd.toFixed(2)}s] ` +
        `overlaps screenplay.speed[${i}] [${cur.tStart.toFixed(2)}s..${cur.tEnd.toFixed(2)}s]. ` +
        `Shorten the first with endDelayMs or push the second with startDelayMs.`,
      );
    }
  }

  // Map source seconds T → dst seconds. Each segment [a,b] with factor f
  // compresses by (1 − 1/f): segments fully before T contribute their whole
  // length, the segment containing T contributes its elapsed part.
  //   dst(T) = T − Σ if(T>a, if(T>b, (b−a)(1−1/f), (min(T,b)−a)(1−1/f)), 0)
  let dst = `T`;
  segments.forEach((s, i) => {
    const len = s.tEnd - s.tStart;
    const fullContribution = len * (1 - 1 / s.factor);
    const partial = `((min(T,${s.tEnd})-${s.tStart})*(1-1/${s.factor}))`;
    dst = `${dst}-if(gt(T,${s.tStart}),if(gt(T,${s.tEnd}),${fullContribution},${partial}),0)`;
  });

  const inLabel = inputLabel.replace(/^\[|\]$/g, "");
  // Zero-base PTS first so T matches canvas seconds even if an upstream
  // filter leaks a non-zero start PTS - otherwise the warp slips.
  const filters = [
    `[${inLabel}]setpts=PTS-STARTPTS,setpts='(${dst})/TB'[afterSpeedups]`,
  ];

  return {
    filters,
    inputs: [inputLabel],
    outputs: "[afterSpeedups]",
    extraInputs: [],
    sidecars: { timewarp: buildTimewarp(segments) },
  };
}

function buildTimewarp(segments) {
  // Piecewise [{srcStart, srcEnd, dstStart, dstEnd, factor}] for trim math.
  const out = [];
  let dstCursor = 0;
  let srcCursor = 0;
  for (const s of segments) {
    if (s.tStart > srcCursor) {
      const len = s.tStart - srcCursor;
      out.push({ srcStart: srcCursor, srcEnd: s.tStart, dstStart: dstCursor, dstEnd: dstCursor + len, factor: 1 });
      dstCursor += len;
      srcCursor = s.tStart;
    }
    const len = s.tEnd - s.tStart;
    const dstLen = len / s.factor;
    out.push({ srcStart: s.tStart, srcEnd: s.tEnd, dstStart: dstCursor, dstEnd: dstCursor + dstLen, factor: s.factor });
    dstCursor += dstLen;
    srcCursor = s.tEnd;
  }
  return out;
}

function passThrough(inputLabel, outputLabel) {
  return {
    filters: [`[${inputLabel.replace(/^\[|\]$/g, "")}]null${outputLabel}`],
    inputs: [inputLabel],
    outputs: outputLabel,
    extraInputs: [],
    sidecars: {},
  };
}

function apply(ctx, inputMov, outputMov, { dryRun = false } = {}) {
  const f = generate(ctx, { inputLabel: "[0:v]" });
  const args = [
    "-y", "-i", inputMov,
    "-filter_complex", f.filters.join(";"),
    "-map", f.outputs,
    "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
    outputMov,
  ];
  return runFfmpeg(args, { dryRun });
}

function fatal(msg) { console.error(`error: ${msg}`); process.exit(5); }

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd !== "generate") {
    console.error("usage: speedups.js generate <recordingDir> <screenplay> <timeline> [--apply <in.mov> <out.mov>]");
    process.exit(2);
  }
  const applyIdx = argv.indexOf("--apply");
  let applyIn = null, applyOut = null;
  if (applyIdx >= 0) {
    applyIn  = argv[applyIdx + 1];
    applyOut = argv[applyIdx + 2];
    argv.splice(applyIdx, 3);
  }
  const [recordingDir, screenplay, timeline] = argv;
  const ctx = loadContext({ recordingDir, screenplayPath: screenplay, timelinePath: timeline });
  if (applyIn && applyOut) {
    const r = apply(ctx, applyIn, applyOut, { dryRun: process.argv.includes("--dry-run") });
    process.exit(r.status ?? 0);
  } else {
    process.stdout.write(JSON.stringify(generate(ctx), null, 2) + "\n");
  }
}

module.exports = { generate, apply };
