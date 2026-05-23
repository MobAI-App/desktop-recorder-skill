// ffmpeg invocation helpers and final-encode presets. Stages don't run
// ffmpeg themselves - the orchestrator (export.js) and per-stage --apply
// debug runners do.

const { spawnSync } = require("child_process");

// Named formats; "display" is a sentinel resolved at runtime to the
// user's main display in device pixels via NSScreen.
const FORMATS = {
  display:         "display",
  horizontal_16_9: [1920, 1080],
  square_1_1:      [1080, 1080],
  vertical_9_16:   [1080, 1920],
  hd_720:          [1280, 720],
  uhd_4k:          [3840, 2160],
};

// Encoder presets for the FINAL output mp4. ProRes 4444 intermediates run
// lossless through the filtergraph; this is the one encode pass.
function encoderArgs(quality) {
  switch (quality) {
    case "standard":
      // HEVC ~50 Mbps at 1440p60.
      return [
        "-c:v", "hevc_videotoolbox",
        "-b:v", "50M",
        "-pix_fmt", "yuv420p",
        "-tag:v", "hvc1",
        "-movflags", "+faststart",
      ];
    case "high":
      // HEVC ~200 Mbps at 1440p60.
      return [
        "-c:v", "hevc_videotoolbox",
        "-b:v", "200M",
        "-pix_fmt", "yuv420p",
        "-tag:v", "hvc1",
        "-movflags", "+faststart",
      ];
    case "h264":
      return [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
      ];
    case "pro":
      return [
        "-c:v", "prores_ks",
        "-profile:v", "3",   // ProRes 422 HQ
        "-pix_fmt", "yuv422p10le",
      ];
    default:
      throw new Error(`unknown quality: ${quality} (try standard | high | h264 | pro)`);
  }
}

function formatSize(format) {
  if (format == null || format === "display") return mainDisplayPixelSize();
  const size = FORMATS[format];
  if (!size) throw new Error(`unknown format: ${format} (try ${Object.keys(FORMATS).join(", ")})`);
  if (size === "display") return mainDisplayPixelSize();
  return size;
}

// NSScreen.mainScreen physical pixels = frame.size × backingScaleFactor.
// Cached after first call; spawned via JXA on macOS. On non-macOS this
// falls back to 1920×1080 with a one-line warning.
let _displaySize = null;
function mainDisplayPixelSize() {
  if (_displaySize) return _displaySize;
  if (process.platform !== "darwin") {
    console.error(`warn: display auto-detect needs macOS (NSScreen via osascript); falling back to 1920×1080 on ${process.platform}`);
    _displaySize = [1920, 1080];
    return _displaySize;
  }
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", `
    ObjC.import("AppKit");
    const s = $.NSScreen.mainScreen;
    const f = s.frame;
    const scale = s.backingScaleFactor;
    JSON.stringify({ w: Math.round(f.size.width * scale), h: Math.round(f.size.height * scale) })
  `], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) {
    console.error("warn: osascript NSScreen probe failed; falling back to 1920×1080");
    _displaySize = [1920, 1080];
    return _displaySize;
  }
  try {
    const { w, h } = JSON.parse(r.stdout.trim());
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error(`bad dims w=${w} h=${h}`);
    }
    _displaySize = [w, h];
    return _displaySize;
  } catch (e) {
    console.error(`warn: could not parse NSScreen JSON (${e.message}); falling back to 1920×1080`);
    _displaySize = [1920, 1080];
    return _displaySize;
  }
}

// Spawns ffmpeg with the given args. Inherits stdio so progress is visible.
function runFfmpeg(args, { dryRun = false } = {}) {
  if (dryRun) {
    process.stderr.write("ffmpeg " + args.map(quoteArg).join(" ") + "\n");
    return { status: 0 };
  }
  const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (r.error) throw r.error;
  return r;
}

function quoteArg(s) {
  if (/^[A-Za-z0-9_\-:.\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { FORMATS, encoderArgs, formatSize, runFfmpeg, quoteArg };
