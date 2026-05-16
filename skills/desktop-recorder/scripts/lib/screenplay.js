/**
 * Shared screenplay/timeline/meta loader used by every editing script.
 *
 * Resolves scene/action IDs to wall-clock-anchored video seconds, exposes a
 * canvas-pixel coordinate transform, and hard-errors on missing references.
 *
 * Usage:
 *   const { loadContext } = require("./lib/screenplay");
 *   const ctx = loadContext({
 *     inputMp4: "/tmp/demo.mp4",         // used to find <inputMp4>.meta.json
 *     screenplayPath: "screenplay.json",
 *     timelinePath:   "timeline.json",
 *     targetWindowId: 245663,            // required for multi-window meta
 *   });
 *   const range = ctx.resolveActionRange({ sceneId: "open", fromAction: ..., toAction: ... });
 */

const fs = require("fs");
const SUPPORTED_SCHEMA_VERSION = 1;

function loadContext({ inputMp4, screenplayPath, timelinePath, targetWindowId }) {
  if (!screenplayPath || !fs.existsSync(screenplayPath)) {
    fatal(`screenplay not found: ${screenplayPath}`);
  }
  if (!timelinePath || !fs.existsSync(timelinePath)) {
    fatal(`timeline not found: ${timelinePath}`);
  }
  const metaPath = inputMp4 + ".meta.json";
  if (!fs.existsSync(metaPath)) {
    fatal(`meta sidecar not found: ${metaPath}`);
  }

  const screenplay = JSON.parse(fs.readFileSync(screenplayPath, "utf8"));
  if ((screenplay.schema_version ?? 1) !== SUPPORTED_SCHEMA_VERSION) {
    fatal(`screenplay schema_version ${screenplay.schema_version} not supported (expected ${SUPPORTED_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(screenplay.scenes)) {
    fatal(`screenplay missing "scenes" array`);
  }

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  if (!Array.isArray(timeline)) {
    fatal(`timeline must be a JSON array of events`);
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (!meta.windows || meta.windows.length === 0) {
    fatal(`meta sidecar has no windows`);
  }

  const firstFrameWallclockMs = meta.firstFrameWallclockMs;
  if (firstFrameWallclockMs == null) {
    fatal(`meta sidecar missing firstFrameWallclockMs — recording incomplete?`);
  }

  let target;
  if (targetWindowId != null) {
    target = meta.windows.find((w) => w.id === targetWindowId);
    if (!target) {
      fatal(
        `--target-window ${targetWindowId} not in meta. Available:\n` +
        meta.windows.map((w) => `  id=${w.id}  ${w.app}`).join("\n")
      );
    }
  } else if (meta.windows.length > 1) {
    fatal(
      `meta sidecar has ${meta.windows.length} windows; pass --target-window <id>. Available:\n` +
      meta.windows.map((w) => `  id=${w.id}  ${w.app}  canvasRect=[${(w.canvasRect||[]).join(",")}]`).join("\n")
    );
  } else {
    target = meta.windows[0];
  }

  // Index timeline events: scene ranges + action lookups.
  const sceneRanges  = new Map(); // sceneId → { tStart, tEnd, sceneIndex }
  const actionEvents = new Map(); // actionId → resolved event record
  const sceneActions = new Map(); // sceneId → [actionId, ...] in order

  const sceneStart = new Map(); // sceneId → wallclock ms
  for (const e of timeline) {
    if (e.type === "scene_start") {
      sceneStart.set(e.scene_id, e.startedAtWallclockMs);
    } else if (e.type === "scene_end") {
      const startMs = sceneStart.get(e.scene_id);
      if (startMs == null) fatal(`scene_end "${e.scene_id}" without matching scene_start`);
      sceneRanges.set(e.scene_id, {
        sceneIndex: e.scene_index,
        tStart: secondsFromWallclock(startMs, firstFrameWallclockMs),
        tEnd:   secondsFromWallclock(e.endedAtWallclockMs, firstFrameWallclockMs),
      });
    } else if (e.type === "action") {
      const rec = {
        actionId:    e.action_id,
        sceneId:     e.scene_id,
        sceneIndex:  e.scene_index,
        actionIndex: e.action_index,
        action:      e.action,
        x: e.x, y: e.y,
        coordinateSpace: e.coordinate_space,
        tStart: secondsFromWallclock(e.startedAtWallclockMs, firstFrameWallclockMs),
        tEnd:   secondsFromWallclock(e.endedAtWallclockMs,   firstFrameWallclockMs),
      };
      actionEvents.set(e.action_id, rec);
      if (!sceneActions.has(e.scene_id)) sceneActions.set(e.scene_id, []);
      sceneActions.get(e.scene_id).push(e.action_id);
    }
  }

  function pointToCanvasPixel(e) {
    const [winX, winY, winW, winH] = target.frameCG;
    let x = e.x, y = e.y;
    if (e.coordinate_space === "screen" || e.coordinateSpace === "screen") {
      x -= winX; y -= winY;
    }
    const [cx, cy, cw, ch] = target.canvasRect;
    return [cx + (x / winW) * cw, cy + (y / winH) * ch];
  }

  /**
   * Resolve a directive's action range to [tStart, tEnd) in video seconds.
   * Half-open: toAction names the first EXCLUDED action.
   * Omitted fromAction → scene's first action. Omitted toAction → scene end.
   */
  function resolveActionRange({ sceneId, fromAction, toAction }) {
    if (!sceneId) fatal(`resolveActionRange: sceneId is required`);
    const range = sceneRanges.get(sceneId);
    if (!range) fatal(`scene "${sceneId}" not in timeline`);

    const ids = sceneActions.get(sceneId) || [];
    let tStart = range.tStart;
    let tEnd   = range.tEnd;

    if (fromAction) {
      const rec = actionEvents.get(fromAction);
      if (!rec) fatal(`fromAction "${fromAction}" not found. Available in "${sceneId}": ${ids.join(", ")}`);
      tStart = rec.tStart;
    }
    if (toAction) {
      const rec = actionEvents.get(toAction);
      if (!rec) fatal(`toAction "${toAction}" not found. Available in "${sceneId}": ${ids.join(", ")}`);
      tEnd = rec.tStart;   // half-open: toAction is excluded
    }
    if (tEnd <= tStart) fatal(`empty range for scene "${sceneId}" (${tStart} >= ${tEnd})`);
    return { tStart, tEnd };
  }

  function clickEventsInVideoSeconds() {
    return [...actionEvents.values()]
      .filter((e) => e.action === "click" && e.x != null && e.y != null)
      .map((e) => {
        const [px, py] = pointToCanvasPixel(e);
        return { ...e, canvasX: px, canvasY: py };
      })
      .sort((a, b) => a.tStart - b.tStart);
  }

  return {
    screenplay,
    timeline,
    meta,
    target,
    firstFrameWallclockMs,
    sceneRanges,
    actionEvents,
    sceneActions,
    pointToCanvasPixel,
    resolveActionRange,
    clickEventsInVideoSeconds,
  };
}

function secondsFromWallclock(wallclockMs, firstFrameWallclockMs) {
  return (wallclockMs - firstFrameWallclockMs) / 1000;
}

function fatal(msg) {
  console.error(`error: ${msg}`);
  process.exit(5);
}

/**
 * Auto-propagate the meta sidecar (and optionally a captions sidecar) from
 * one stage's input to its output, so users don't have to `cp` between
 * pipeline scripts. Skipped silently if the input sidecar is missing.
 */
function propagateSidecars(inputMp4, outputMp4, { skipCaptions = false } = {}) {
  const inMeta = inputMp4 + ".meta.json";
  const outMeta = outputMp4 + ".meta.json";
  if (fs.existsSync(inMeta) && inMeta !== outMeta) {
    fs.copyFileSync(inMeta, outMeta);
  }
  if (!skipCaptions) {
    const inCap  = inputMp4.replace(/\.[^.]+$/, "")  + ".captions.json";
    const outCap = outputMp4.replace(/\.[^.]+$/, "") + ".captions.json";
    if (fs.existsSync(inCap) && inCap !== outCap) {
      fs.copyFileSync(inCap, outCap);
    }
  }
}

module.exports = { loadContext, propagateSidecars, SUPPORTED_SCHEMA_VERSION };
