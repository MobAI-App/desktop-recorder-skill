#!/usr/bin/env node
// Stage 2: highlights
//
// Draws everything synthetic on top of the composed canvas:
//   1. A cursor sprite (arrow) at the synthetic cursor path.
//   2. A pointer sprite (pointing hand) layered on top during each click
//      window so the cursor visibly "presses".
//   3. A soft expanding-ring ripple at each click moment.
//
// Per-scene windowId on the screenplay routes each click to its correct
// window's canvas region (via ctx.pointToCanvasPixel), so a multi-window
// composition gets a cursor that crosses between windows naturally.
//
// User overrides on the screenplay:
//   "highlights": {
//     "ripple": {
//       "sprite": "/path/to/anim.mov",   // optional; .mov w/alpha (qtrle/prores4444), APNG, transparent webm
//       "color":  "RRGGBB" | "RRGGBBAA", // procedural ring color; default "FFFFFF"
//       "size":   160,                   // procedural sprite size px
//       "durationMs": 520                // procedural sprite duration ms
//     },
//     "cursor": {
//       "arrow":    "/path/to/arrow.png",    // optional; default = deskagent cursor-png --type arrow
//       "pointing": "/path/to/pointing.png", // optional; default = deskagent cursor-png --type pointing
//       "size":     64                       // longest edge in canvas px
//     }
//   }
//
// Input  label: [afterCompose]
// Output label: [afterHighlights]

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadContext } = require("../lib/screenplay");
const { runFfmpeg } = require("../lib/ffmpeg");
const { cursorPathExpressions } = require("../lib/cursor-path");

const DESKAGENT = process.env.DESKAGENT || "deskagent";

const DEFAULT_RIPPLE_SIZE    = 160;
const DEFAULT_RIPPLE_DUR_MS  = 520;
const DEFAULT_RIPPLE_COLOR   = "FFFFFF";
const DEFAULT_CURSOR_SIZE    = 64;
const POINTER_WINDOW_MS      = 220;  // how long pointer sprite is shown around click

function generate(ctx, { inputLabel = "[afterCompose]" } = {}) {
  const clicks = ctx.clickEventsInCanvasSeconds();        // ripple + pointer-hand
  const waypoints = ctx.cursorWaypointsInCanvasSeconds(); // cursor glide path (clicks + moves)
  if (waypoints.length === 0) {
    return passThrough(inputLabel, "[afterHighlights]");
  }

  const opts = ctx.screenplay.highlights || {};
  const rippleCfg = opts.ripple || {};
  const cursorCfg = opts.cursor || {};
  // Tmp dir for non-cacheable assets (cursor PNGs depend on the deskagent
  // binary state). Registered for cleanup on process exit.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskagent-hl-"));
  registerTmpCleanup(tmpDir);

  // Ripple sprite: user-supplied OR procedurally generated (cached).
  const rippleDurMs  = Number(rippleCfg.durationMs ?? DEFAULT_RIPPLE_DUR_MS);
  const rippleDurSec = rippleDurMs / 1000;
  const rippleSize   = Number(rippleCfg.size ?? DEFAULT_RIPPLE_SIZE);
  const rippleColor  = String(rippleCfg.color ?? DEFAULT_RIPPLE_COLOR);
  const ripplePath = rippleCfg.sprite
    ? validateSpritePath(rippleCfg.sprite)
    : cachedProceduralRipple(rippleSize, rippleDurSec, rippleColor);

  // Cursor sprites.
  const cursorSize = Number(cursorCfg.size ?? DEFAULT_CURSOR_SIZE);
  const arrowPath    = cursorCfg.arrow    ?? renderCursorPng(path.join(tmpDir, "arrow.png"),    "arrow",    cursorSize);
  const pointingPath = cursorCfg.pointing ?? renderCursorPng(path.join(tmpDir, "pointing.png"), "pointing", cursorSize);

  // Hotspots: the sprite pixel that should land EXACTLY on the click point.
  // Default (0, 0) matches the arrow sprite whose tip sits at top-left.
  // Custom PNGs with off-corner hotspots should set both.
  const hotspotArrow    = validateHotspot(cursorCfg.hotspotArrow,    "hotspotArrow",    [0, 0]);
  const hotspotPointing = validateHotspot(cursorCfg.hotspotPointing, "hotspotPointing", hotspotArrow);
  const [haX, haY] = hotspotArrow;
  const [hpX, hpY] = hotspotPointing;

  // Inputs: one `-i ripple.mov` per click via -itsoffset (the ripple plays
  // from its own PTS=0 starting at click.t), plus the two cursor PNGs.
  // Each click adds a decoder; loud-but-bearable up to ~100 clicks. Warn
  // beyond that - the user likely wants to consolidate ripples or use a
  // custom sprite.
  if (clicks.length > 100) {
    process.stderr.write(
      `warn: highlights stage has ${clicks.length} clicks; ` +
      `each adds an ffmpeg input. Consider screenplay.highlights.ripple.sprite ` +
      `or fewer clicks if the encode runs hot.\n`,
    );
  }
  const extraInputs = [];
  const RIPPLE_BASE = extraInputs.length;
  clicks.forEach((c) => {
    extraInputs.push({ argv: ["-itsoffset", c.tStart.toFixed(3), "-i", ripplePath] });
  });
  const ARROW_IDX = extraInputs.length;
  extraInputs.push({ argv: ["-loop", "1", "-i", arrowPath] });
  const POINTING_IDX = extraInputs.length;
  extraInputs.push({ argv: ["-loop", "1", "-i", pointingPath] });

  // Probe sprite sizes so we can offset overlays to the click center.
  const rippleProbe = probeWH(ripplePath);

  const inputLabelClean = inputLabel.replace(/^\[|\]$/g, "");
  const filters = [];

  // 1. Per-click ripple overlays (sprite plays from PTS=0 starting at its
  // input's -itsoffset, which we set to the click's canvas time).
  let last = inputLabelClean;
  clicks.forEach((c, i) => {
    const sx = Math.round(c.canvasX - rippleProbe.w / 2);
    const sy = Math.round(c.canvasY - rippleProbe.h / 2);
    const tIn  = c.tStart;
    const tOut = c.tStart + rippleDurSec;
    const next = `hl${i}`;
    filters.push(
      `[${last}][\${capInput${RIPPLE_BASE + i}}:v]overlay=x=${sx}:y=${sy}:` +
      `enable='between(t,${tIn.toFixed(3)},${tOut.toFixed(3)})':shortest=0[${next}]`,
    );
    last = next;
  });

  // 2. Cursor sprites. The pointing-hand replaces (not stacks on top of)
  // the arrow during each click window so the cursor visibly swaps.
  //   arrow enable    = NOT in any click window AND NOT inside a pan range
  //   pointing enable = in some click window
  // Pan ranges are cinematic camera moves over no-click sections; the
  // cursor would otherwise sit parked (often off the panned view) and
  // distract. Hide it there. (follow_cursor zoom is the tool for
  // click-driven camera; pan and clicks shouldn't overlap.)
  const cp = cursorPathExpressions(waypoints.map((c) => ({
    tStart: c.tStart, canvasX: c.canvasX, canvasY: c.canvasY,
  })));
  // Pointer-hand fires only at clicks, never at plain moves. "0" (never) keeps
  // the enable expressions valid when a demo has moves but no clicks.
  const pointerWindows = clicks.length
    ? clicks.map((c) =>
        `between(t,${(c.tStart - POINTER_WINDOW_MS / 2000).toFixed(3)},${(c.tStart + POINTER_WINDOW_MS / 2000).toFixed(3)})`
      ).join("+")
    : "0";
  const panRanges = collectPanRanges(ctx);
  const panEnable = panRanges.length
    ? panRanges.map((r) => `between(t,${r.tStart.toFixed(3)},${r.tEnd.toFixed(3)})`).join("+")
    : null;
  // Optional cursor visibility control via screenplay.cursor:
  //   hide: [...]  cursor invisible inside these action ranges (e.g. a scroll)
  //   show: [...]  whitelist - if present, cursor visible ONLY in these ranges
  // Both compose with the automatic pan-range hiding. End a hide range a beat
  // before the next click so the cursor reappears already gliding toward it.
  const visGates = [];
  const showEnable = rangesEnable(collectCursorRanges(ctx, "show"));
  const hideEnable = rangesEnable(collectCursorRanges(ctx, "hide"));
  if (showEnable) visGates.push(`(${showEnable})`);
  if (hideEnable) visGates.push(`not(${hideEnable})`);
  const arrowParts = [`not(${pointerWindows})`];
  if (panEnable) arrowParts.push(`not(${panEnable})`);
  arrowParts.push(...visGates);
  const arrowEnable = arrowParts.join("*");
  const pointerEnable = [`(${pointerWindows})`, ...visGates].join("*");
  // Subtract hotspot from cursor position so the sprite's hotspot pixel
  // lands on the click coord, not its top-left.
  filters.push(
    `[${last}][\${capInput${ARROW_IDX}}:v]overlay=x='${cp.xExpr}-${haX}':y='${cp.yExpr}-${haY}':` +
    `enable='${arrowEnable}'[afterArrow]`,
  );
  filters.push(
    `[afterArrow][\${capInput${POINTING_IDX}}:v]overlay=x='${cp.xExpr}-${hpX}':y='${cp.yExpr}-${hpY}':` +
    `enable='${pointerEnable}'[afterHighlights]`,
  );

  return {
    filters,
    inputs: [inputLabel],
    outputs: "[afterHighlights]",
    extraInputs,
    sidecars: {},
  };
}

// ---------- helpers ----------

function validateSpritePath(p) {
  if (!fs.existsSync(p)) {
    console.error(`error: highlights.ripple.sprite not found: ${p}`);
    process.exit(5);
  }
  return p;
}

// Cached on (size, durSec, colorHex) so repeated exports skip the geq
// render - the slowest part of this stage (~3–5 s cold).
function cachedProceduralRipple(size, durSec, colorHex) {
  const home  = process.env.HOME || os.tmpdir();
  const cache = path.join(home, ".cache", "deskagent-skill");
  fs.mkdirSync(cache, { recursive: true });
  const key = `ripple-${size}-${durSec.toFixed(3)}-${colorHex.toUpperCase()}.mov`;
  const target = path.join(cache, key);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  return renderProceduralRipple(target, size, durSec, colorHex);
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

function renderProceduralRipple(outPath, size, durSec, colorHex) {
  const SIZE = size;
  const HALF = SIZE / 2;
  const MAX_R = Math.floor(SIZE * 0.42);
  const W = Math.max(2, Math.round(SIZE * 0.025));
  const FPS = 60;

  const [r, g, b] = hexToRgb(colorHex);

  // Gaussian ring at radius MAX_R·t/dur, width W, fading with (1−t/dur)².
  const alphaExpr =
    `255 * exp(-pow((sqrt(pow(X-${HALF},2)+pow(Y-${HALF},2)) - ${MAX_R}*T/${durSec})/${W},2))` +
    ` * pow(max(0\\,1-T/${durSec}),2)`;

  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=0x000000@0:s=${SIZE}x${SIZE}:d=${durSec}:r=${FPS}`,
    "-vf", `format=yuva420p,geq=r=${r}:g=${g}:b=${b}:a='${alphaExpr}'`,
    "-c:v", "qtrle",
    outPath,
  ];
  const res = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  if (res.status !== 0) {
    console.error("error: failed to generate procedural ripple sprite");
    process.exit(5);
  }
  return outPath;
}

function renderCursorPng(outPath, type, size) {
  const r = spawnSync(DESKAGENT, [
    "cursor-png", "--type", type, "--size", String(size), "--out", outPath,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) {
    console.error(`error: ${DESKAGENT} cursor-png --type ${type} failed (exit ${r.status}). ` +
                  `Put deskagent on PATH or set DESKAGENT env var.`);
    process.exit(5);
  }
  return outPath;
}

function probeWH(file) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0", file,
  ]);
  if (r.status !== 0) { console.error("ffprobe failed for", file); process.exit(5); }
  const [w, h] = r.stdout.toString().trim().split(",").map(Number);
  return { w, h };
}

// Resolve [tStart, tEnd] (canvas seconds) for each zoom entry that uses pan
// waypoints. Used to suppress the cursor sprite during cinematic pans.
function rangesEnable(ranges) {
  return ranges.length
    ? ranges.map((r) => `between(t,${r.tStart.toFixed(3)},${r.tEnd.toFixed(3)})`).join("+")
    : null;
}

// Resolve screenplay.cursor.{hide,show}[] action ranges to canvas-second spans.
function collectCursorRanges(ctx, key) {
  const cur = ctx.screenplay.cursor;
  const arr = cur && Array.isArray(cur[key]) ? cur[key] : [];
  return arr.map((r, i) => {
    const x = ctx.resolveActionRange({
      fromAction: r.fromAction, toAction: r.toAction,
      startDelayMs: r.startDelayMs, endDelayMs: r.endDelayMs,
      label: `cursor.${key}[${i}]`,
    });
    return { tStart: x.tStart, tEnd: x.tEnd };
  });
}

function collectPanRanges(ctx) {
  const entries = Array.isArray(ctx.screenplay.zoom) ? ctx.screenplay.zoom : [];
  const out = [];
  entries.forEach((z, i) => {
    if (!Array.isArray(z.pan) || z.pan.length === 0) return;
    const r = ctx.resolveActionRange({
      fromAction: z.fromAction, toAction: z.toAction,
      startDelayMs: z.startDelayMs, endDelayMs: z.endDelayMs,
      label: `zoom[${i}]`,
    });
    out.push({ tStart: r.tStart, tEnd: r.tEnd });
  });
  return out;
}

function validateHotspot(raw, name, fallback) {
  if (raw == null) return fallback;
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => Number.isFinite(Number(n)))) {
    console.error(`error: highlights.cursor.${name} must be [x, y] in canvas px (got ${JSON.stringify(raw)})`);
    process.exit(5);
  }
  return [Number(raw[0]), Number(raw[1])];
}

function hexToRgb(hex) {
  const s = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6,8}$/.test(s)) {
    console.error(`error: bad highlights.ripple.color: ${hex} (want RRGGBB)`); process.exit(5);
  }
  return [parseInt(s.slice(0,2), 16), parseInt(s.slice(2,4), 16), parseInt(s.slice(4,6), 16)];
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

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd !== "generate") {
    console.error("usage: highlights.js generate <recordingDir> <screenplay> <timeline> [--apply <in.mov> <out.mov>]");
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
