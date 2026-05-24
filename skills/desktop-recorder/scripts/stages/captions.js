#!/usr/bin/env node
// Stage 4: captions - burns top-level screenplay.captions[] entries onto a
// single centered bottom strip, one PNG per entry (via deskagent text-png).
// Entries may not overlap in time (single shared strip).
// Schema reference: references/desktop.md#captions.
// Input [afterZoom] → Output [afterCaptions].

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadContext } = require("../lib/screenplay");
const { runFfmpeg } = require("../lib/ffmpeg");

const CAPTION_Y_FRACTION = 0.88;     // single bottom strip, canvas Y
const FONT_SIZE_FRACTION = 0.038;
const MIN_FONT_SIZE      = 28;
const DESKAGENT          = process.env.DESKAGENT || "deskagent";

function generate(ctx, { inputLabel = "[afterZoom]" } = {}) {
  const captions = resolveCaptions(ctx);
  if (captions.length === 0) {
    return passThrough(inputLabel, "[afterCaptions]");
  }
  const H = ctx.composition.canvasH;
  const fontSize = Math.max(MIN_FONT_SIZE, Math.round(H * FONT_SIZE_FRACTION));
  const bottomY = Math.round(H * CAPTION_Y_FRACTION);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskagent-captions-"));
  registerTmpCleanup(tmpDir);
  const pngByText = new Map();
  for (const c of captions) {
    if (pngByText.has(c.text)) continue;
    const png = path.join(tmpDir, `cap-${pngByText.size}.png`);
    renderTextPng(c.text, fontSize, png);
    pngByText.set(c.text, png);
  }

  const extraInputs = [];
  const inputIndexByPng = new Map();
  for (const [, png] of pngByText.entries()) {
    inputIndexByPng.set(png, extraInputs.length);
    extraInputs.push({ argv: ["-loop", "1", "-i", png] });
  }

  // ${capInput<N>} is resolved to an absolute ffmpeg input index by export.js.
  let last = inputLabel.replace(/^\[|\]$/g, "");
  const filters = [];
  captions.forEach((c, i) => {
    const png = pngByText.get(c.text);
    const idx = inputIndexByPng.get(png);
    const next = `cap${i}`;
    filters.push(
      `[${last}][\${capInput${idx}}:v]overlay=x='(W-w)/2':y='${bottomY}-h':` +
      `enable='between(t,${c.startSec.toFixed(3)},${c.endSec.toFixed(3)})'[${next}]`,
    );
    last = next;
  });
  filters.push(`[${last}]null[afterCaptions]`);

  return {
    filters,
    inputs: [inputLabel],
    outputs: "[afterCaptions]",
    extraInputs,
    sidecars: { captions },
  };
}

function resolveCaptions(ctx) {
  const entries = ctx.screenplay.captions;
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const out = [];
  entries.forEach((c, i) => {
    const label = `captions[${i}]`;
    if (typeof c.text !== "string" || c.text.length === 0) fatal(`${label}: text required`);
    if (!c.fromAction) fatal(`${label}: fromAction required`);
    const fromRec = ctx.actionEvents.get(c.fromAction);
    if (!fromRec) fatal(`${label}: fromAction "${c.fromAction}" not found in timeline`);
    const startSec = fromRec.tStart + Number(c.startDelayMs || 0) / 1000;
    let endSec;
    if (c.toAction != null) {
      const toRec = ctx.actionEvents.get(c.toAction);
      if (!toRec) fatal(`${label}: toAction "${c.toAction}" not found in timeline`);
      endSec = toRec.tStart + Number(c.endDelayMs || 0) / 1000;
    } else if (c.durationMs != null) {
      endSec = startSec + Number(c.durationMs) / 1000;
    } else {
      fatal(`${label}: provide either toAction or durationMs`);
    }
    if (endSec <= startSec) fatal(`${label}: end (${endSec.toFixed(3)}s) <= start (${startSec.toFixed(3)}s)`);
    // Non-fatal (speedups may shift timing) but usually a mistuned duration.
    const sharedEnd = ctx.shared?.durationSec;
    if (Number.isFinite(sharedEnd) && endSec > sharedEnd + 0.5) {
      process.stderr.write(
        `warn: ${label} "${c.text}" ends at ${endSec.toFixed(2)}s but the shared recording window is ${sharedEnd.toFixed(2)}s; caption may be truncated.\n`,
      );
    }
    out.push({ text: c.text, startSec, endSec, index: i });
  });
  // Single shared strip - overlapping entries would stack illegibly, so
  // refuse rather than render a mess.
  const sorted = [...out].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.startSec < prev.endSec - 1e-3) {
      fatal(
        `captions[${prev.index}] "${prev.text}" [${prev.startSec.toFixed(2)}s..${prev.endSec.toFixed(2)}s] ` +
        `overlaps captions[${cur.index}] "${cur.text}" [${cur.startSec.toFixed(2)}s..${cur.endSec.toFixed(2)}s]. ` +
        `Shorten the first with endDelayMs/durationMs or push the second with startDelayMs.`,
      );
    }
  }
  return out;
}

const _tmpDirs = new Set();
let _tmpCleanupRegistered = false;
function registerTmpCleanup(dir) {
  _tmpDirs.add(dir);
  if (_tmpCleanupRegistered) return;
  _tmpCleanupRegistered = true;
  const cleanup = () => {
    for (const d of _tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    _tmpDirs.clear();
  };
  process.on("exit", cleanup);
  process.on("SIGINT",  () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

function renderTextPng(text, fontSize, outPath) {
  const r = spawnSync(DESKAGENT, [
    "text-png", "--text", text, "--font-size", String(fontSize), "--out", outPath,
    "--padding", "32,16", "--radius", "16",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) {
    console.error(`error: ${DESKAGENT} text-png failed for "${text}" (exit ${r.status}). ` +
                  `Put deskagent on PATH or set DESKAGENT env var.`);
    process.exit(5);
  }
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
  const offset = 1;
  const args = ["-y", "-i", inputMov];
  for (const e of f.extraInputs) args.push(...e.argv);
  let filterStr = f.filters.join(";");
  for (let i = 0; i < f.extraInputs.length; i++) {
    filterStr = filterStr.split(`\${capInput${i}}`).join(String(offset + i));
  }
  args.push("-filter_complex", filterStr);
  args.push("-map", f.outputs);
  args.push("-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le");
  args.push(outputMov);
  return runFfmpeg(args, { dryRun });
}

function fatal(msg) { console.error(`error: ${msg}`); process.exit(5); }

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd !== "generate") {
    console.error("usage: captions.js generate <recordingDir> <screenplay> <timeline> [--apply <in.mov> <out.mov>]");
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
