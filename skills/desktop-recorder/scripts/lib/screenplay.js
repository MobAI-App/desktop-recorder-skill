// Editor context loader. Reads a recording.manifest.json + screenplay.json +
// timeline.json and produces a single object that every stage's generate()
// function consumes. Pure parsing/derivation; no ffmpeg work here.

const fs   = require("fs");
const path = require("path");

const SUPPORTED_SCREENPLAY_VERSIONS = [2];
const SUPPORTED_MANIFEST_VERSIONS   = [1];

function fatal(msg) { console.error(`error: ${msg}`); process.exit(5); }

function loadContext({ recordingDir, screenplayPath, timelinePath }) {
  if (!recordingDir) fatal("recordingDir is required");
  if (!fs.existsSync(recordingDir)) fatal(`recording dir not found: ${recordingDir}`);
  const manifestPath = path.join(recordingDir, "recording.manifest.json");
  if (!fs.existsSync(manifestPath)) fatal(`manifest not found: ${manifestPath}`);
  if (!screenplayPath || !fs.existsSync(screenplayPath)) fatal(`screenplay not found: ${screenplayPath}`);
  if (!timelinePath   || !fs.existsSync(timelinePath))   fatal(`timeline not found: ${timelinePath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
    fatal(`unsupported manifest version ${manifest.version} (need ${SUPPORTED_MANIFEST_VERSIONS.join("/")})`);
  }
  if (!Array.isArray(manifest.clips) || manifest.clips.length === 0) {
    fatal(`manifest has no clips: ${manifestPath}`);
  }

  const screenplay = JSON.parse(fs.readFileSync(screenplayPath, "utf8"));
  if (!SUPPORTED_SCREENPLAY_VERSIONS.includes(screenplay.schema_version)) {
    fatal(`unsupported screenplay schema_version ${screenplay.schema_version}`);
  }
  if (!Array.isArray(screenplay.scenes)) fatal(`screenplay missing "scenes" array`);

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  if (!Array.isArray(timeline)) fatal(`timeline must be a JSON array of events`);

  const composition = resolveComposition(manifest.clips, screenplay.composition ?? null);
  const shared      = resolveSharedWindow(manifest.clips);

  // Build sceneRanges / actionEvents in canvas-output seconds. Canvas t=0 is
  // the shared time window's start, so every per-clip head trim maps the same
  // scene_start event to the same canvas time.
  const t0WallMs = shared.useHostTime
    ? wallclockOfHostNs(manifest.clips, shared.t0)
    : shared.t0 / 1e6;

  const sceneRanges  = new Map();
  const actionEvents = new Map();
  const sceneActions = new Map();
  const sceneStart   = new Map();
  let videoStart = Infinity;
  let videoEnd   = 0;

  for (const e of timeline) {
    if (e.type === "scene_start") {
      sceneStart.set(e.scene_id, e.startedAtWallclockMs);
    } else if (e.type === "scene_end") {
      const startMs = sceneStart.get(e.scene_id);
      if (startMs == null) fatal(`scene_end "${e.scene_id}" without matching scene_start`);
      const tStart = (startMs - t0WallMs) / 1000;
      const tEnd   = (e.endedAtWallclockMs - t0WallMs) / 1000;
      sceneRanges.set(e.scene_id, { sceneIndex: e.scene_index, tStart, tEnd });
      if (tStart < videoStart) videoStart = tStart;
      if (tEnd   > videoEnd)   videoEnd   = tEnd;
    } else if (e.type === "action") {
      const rec = {
        actionId:    e.action_id,
        sceneId:     e.scene_id,
        sceneIndex:  e.scene_index,
        actionIndex: e.action_index,
        action:      e.action,
        x: e.x, y: e.y,
        coordinateSpace: e.coordinate_space,
        tStart: (e.startedAtWallclockMs - t0WallMs) / 1000,
        tEnd:   (e.endedAtWallclockMs   - t0WallMs) / 1000,
      };
      actionEvents.set(e.action_id, rec);
      if (!sceneActions.has(e.scene_id)) sceneActions.set(e.scene_id, []);
      sceneActions.get(e.scene_id).push(e.action_id);
    }
  }
  if (!isFinite(videoStart)) videoStart = 0;

  function placementForClip(clip) {
    return composition.placements.find((p) => p.clip === clip) ?? null;
  }

  // Map a per-scene windowId from the screenplay. Each scene may pin which
  // window its actions target; falls back to the first window placement.
  const sceneWindowId = new Map();
  for (const scene of screenplay.scenes) {
    if (scene.windowId != null) sceneWindowId.set(scene.id, Number(scene.windowId));
  }

  function pointToCanvasPixel(e) {
    let placement = null;
    const wid = e.windowId != null ? Number(e.windowId) : sceneWindowId.get(e.sceneId);
    const isScreenSpace = e.coordinate_space === "screen" || e.coordinateSpace === "screen";

    // Placement priority: explicit windowId, then (for screen-space clicks)
    // the window whose frame contains the point, then the sole window, then
    // anything. A screen click must map to the window it actually landed in.
    if (wid != null) {
      placement = composition.placements.find((p) => p.clip.kind === "window" && p.clip.id === wid);
    }
    if (!placement && isScreenSpace) {
      placement = composition.placements.find((p) => {
        const f = p.clip.frameCG;
        if (!f) return false;
        const [fx, fy, fw, fh] = f;
        return e.x >= fx && e.x <= fx + fw && e.y >= fy && e.y <= fy + fh;
      }) ?? null;
    }
    const windowPlacements = composition.placements.filter((p) => p.clip.kind === "window");
    if (!placement && windowPlacements.length === 1) placement = windowPlacements[0];
    // Ambiguous: a window-space point in a multi-window comp with no way to
    // tell which window it belongs to. Guessing the first placement silently
    // maps clicks (and zoom/pan centers) onto the wrong window. Fail with a
    // fix instead. Clicks carry sceneId; editing directives carry source.
    if (!placement && !isScreenSpace && windowPlacements.length > 1) {
      const ids = windowPlacements.map((p) => p.clip.id).join(", ");
      const what = e.source ? `the ${e.source} center` : `a window-space click in scene "${e.sceneId}"`;
      const remedy = e.source ? `Set "windowId" on the ${e.source} entry` : `Set "windowId" on that scene`;
      fatal(
        `cannot resolve which window ${what} targets (candidates: ${ids}). ` +
        `${remedy}, or use coordinate_space "screen" so the screen position picks the window.`,
      );
    }
    if (!placement) placement = composition.placements[0];
    if (!placement) return [e.x, e.y];

    let x = e.x, y = e.y;
    const frameCG = placement.clip.frameCG; // [x, y, w, h] in CG points
    if (frameCG && isScreenSpace) {
      x -= frameCG[0]; y -= frameCG[1];
    }
    const fit = placement.fit;
    const winW = frameCG ? frameCG[2] : (placement.clip.pixelSize?.[0] ?? 1);
    const winH = frameCG ? frameCG[3] : (placement.clip.pixelSize?.[1] ?? 1);
    return [fit.ox + (x / winW) * fit.fitW, fit.oy + (y / winH) * fit.fitH];
  }

  function resolveActionRange({ fromAction, toAction, startDelayMs = 0, endDelayMs = 0, label = "directive" }) {
    if (!fromAction) fatal(`${label}: fromAction is required`);
    if (!toAction)   fatal(`${label}: toAction is required`);
    const fromRec = actionEvents.get(fromAction);
    if (!fromRec) fatal(`${label}: fromAction "${fromAction}" not found in timeline`);
    const toRec   = actionEvents.get(toAction);
    if (!toRec)   fatal(`${label}: toAction "${toAction}" not found in timeline`);
    const tStart = fromRec.tStart + Number(startDelayMs || 0) / 1000;
    const tEnd   = toRec.tStart   + Number(endDelayMs   || 0) / 1000;
    if (tEnd <= tStart) fatal(`${label}: empty range after offsets (${tStart.toFixed(3)}s >= ${tEnd.toFixed(3)}s)`);
    return { tStart, tEnd, fromActionRec: fromRec, toActionRec: toRec };
  }

  function clickEventsInCanvasSeconds() {
    return [...actionEvents.values()]
      .filter((e) => e.action === "click" && e.x != null && e.y != null)
      .map((e) => {
        const [px, py] = pointToCanvasPixel(e);
        return { ...e, canvasX: px, canvasY: py };
      })
      .sort((a, b) => a.tStart - b.tStart);
  }

  return {
    recordingDir,
    manifest,
    screenplay,
    timeline,
    composition,
    shared,
    sceneRanges,
    actionEvents,
    sceneActions,
    videoStart,
    videoEnd,
    pointToCanvasPixel,
    placementForClip,
    resolveActionRange,
    clickEventsInCanvasSeconds,
  };
}

// ----------------------------------------------------------------------------
// composition resolution: canvas, background, layout-or-explicit element rects,
// aspect-fit per element. Mirrors the previous compose.js logic.
// ----------------------------------------------------------------------------

function resolveComposition(clips, composition) {
  if (composition == null) {
    if (clips.length === 1) {
      const c = clips[0];
      const [w, h] = c.pixelSize;
      return makeComposition(w, h, "none", [
        { clip: c, rect: [0, 0, w, h] },
      ], { upscale: false });
    }
    fatal(
      `manifest has ${clips.length} clips but screenplay has no \`composition\` block. ` +
      `Add screenplay.composition with canvas + elements.`,
    );
  }

  const canvas = composition.canvas;
  if (!Array.isArray(canvas) || canvas.length !== 2) {
    fatal(`composition.canvas must be [W, H] (got ${JSON.stringify(canvas)})`);
  }
  const [canvasW, canvasH] = canvas.map(Number);
  if (!Number.isFinite(canvasW) || !Number.isFinite(canvasH) || canvasW <= 0 || canvasH <= 0) {
    fatal(`composition.canvas dimensions must be positive (got ${canvas})`);
  }

  const elements = Array.isArray(composition.elements) ? composition.elements : null;
  if (!elements || elements.length === 0) fatal(`composition.elements is required`);

  const layoutMode = typeof composition.layout === "string" ? composition.layout : null;
  const padding = Number(composition.padding ?? 60);
  if (!Number.isFinite(padding) || padding < 0) {
    fatal(`composition.padding must be >= 0 (got ${composition.padding})`);
  }
  const autoSlots = layoutMode
    ? computeLayoutSlots(elements, [canvasW, canvasH], layoutMode, padding)
    : null;

  const placements = elements.map((el, idx) => {
    const clip = findClip(clips, el);
    if (!clip) {
      fatal(
        `composition.elements[${idx}] does not match any clip in manifest. ` +
        `Available: ${clips.map((c) => `${c.kind}:${c.id}`).join(", ")}`,
      );
    }
    const rect = el.rect ?? autoSlots?.[idx];
    if (!Array.isArray(rect) || rect.length !== 4) {
      fatal(`composition.elements[${idx}] needs a rect [x,y,w,h] (or set composition.layout)`);
    }
    return { clip, rect: rect.map(Number), upscale: el.upscale };
  });

  return makeComposition(canvasW, canvasH, composition.background ?? "none", placements, {
    upscale: composition.upscale,
  });
}

function makeComposition(canvasW, canvasH, background, placements, opts = {}) {
  // Never upscale by default: a clip smaller than its slot stays native and
  // centered, so screen recordings stay pixel-sharp. Opt in via upscale.
  const defaultUpscale = !!opts.upscale;
  for (const p of placements) {
    const [rx, ry, rw, rh] = p.rect;
    const [srcW, srcH] = p.clip.pixelSize && p.clip.pixelSize[0] > 0 && p.clip.pixelSize[1] > 0
      ? p.clip.pixelSize
      : [rw, rh];
    const upscale = p.upscale != null ? !!p.upscale : defaultUpscale;
    const srcAR  = srcW / srcH;
    const rectAR = rw / rh;
    let fitW, fitH;
    if (!upscale && srcW <= rw && srcH <= rh) {
      fitW = srcW;
      fitH = srcH;
    } else if (srcAR > rectAR) {
      fitW = rw;
      fitH = Math.round(rw / srcAR);
    } else {
      fitH = rh;
      fitW = Math.round(rh * srcAR);
    }
    p.fit = {
      fitW,
      fitH,
      ox: Math.round(rx + (rw - fitW) / 2),
      oy: Math.round(ry + (rh - fitH) / 2),
    };
  }
  return { canvasW, canvasH, background, placements };
}

function findClip(clips, el) {
  if (el.windowId != null)  return clips.find((c) => c.kind === "window"  && c.id === Number(el.windowId));
  if (el.displayId != null) return clips.find((c) => c.kind === "display" && c.id === Number(el.displayId));
  return null;
}

function computeLayoutSlots(elements, canvas, layoutMode, padding) {
  const [W, H] = canvas;
  const n = elements.length;
  if (n === 0) return [];
  const mode = layoutMode === "auto"
    ? (n === 1 ? "single" : n === 2 ? "side-by-side" : "grid")
    : layoutMode;
  if (mode === "single") return [[0, 0, W, H]];

  let cols, rows;
  switch (mode) {
    case "side-by-side": cols = n; rows = 1; break;
    case "stack":        cols = 1; rows = n; break;
    case "grid":         cols = n === 1 ? 1 : 2; rows = Math.ceil(n / cols); break;
    default: fatal(`unknown composition.layout: ${layoutMode}`);
  }
  const colWeights = (mode === "side-by-side")
    ? elements.slice(0, cols).map((e) => Number(e.weight ?? 1))
    : Array(cols).fill(1);
  const rowWeights = (mode === "stack")
    ? elements.slice(0, rows).map((e) => Number(e.weight ?? 1))
    : Array(rows).fill(1);
  const widths  = proportional(Math.max(0, W - padding * (cols + 1)), colWeights);
  const heights = proportional(Math.max(0, H - padding * (rows + 1)), rowWeights);
  if (widths.some((w) => w <= 0) || heights.some((h) => h <= 0)) {
    fatal(`composition.padding=${padding} is too large for canvas ${W}x${H} with ${n} element(s)`);
  }

  const slots = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = padding * (col + 1) + sumPrefix(widths,  col);
    const y = padding * (row + 1) + sumPrefix(heights, row);
    slots.push([Math.round(x), Math.round(y), Math.round(widths[col]), Math.round(heights[row])]);
  }
  return slots;
}

function proportional(available, weights) {
  const total = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (total <= 0) return weights.map(() => available / Math.max(1, weights.length));
  return weights.map((w) => (Math.max(0, w) / total) * available);
}

function sumPrefix(arr, end) { let s = 0; for (let i = 0; i < end; i++) s += arr[i]; return s; }

// ----------------------------------------------------------------------------
// shared time window across clips (alignment anchor t=0).
// ----------------------------------------------------------------------------

function resolveSharedWindow(clips) {
  const useHostTime = clips.every((c) => Number.isFinite(c.startHostNs) && Number.isFinite(c.endHostNs)
                                       && c.startHostNs > 0 && c.endHostNs > c.startHostNs);
  let t0Ns, tEndNs;
  if (useHostTime) {
    t0Ns   = Math.max(...clips.map((c) => c.startHostNs));
    tEndNs = Math.min(...clips.map((c) => c.endHostNs));
  } else {
    const startsMs = clips.map((c) => c.startWallclockMs);
    const endsMs   = clips.map((c) => Number.isFinite(c.endWallclockMs) && c.endWallclockMs > 0
      ? c.endWallclockMs
      : c.startWallclockMs + (c.lastFramePtsNs / 1e6));
    t0Ns   = Math.max(...startsMs) * 1e6;
    tEndNs = Math.min(...endsMs)   * 1e6;
  }
  const headTrimsByPath = Object.fromEntries(clips.map((c) => {
    const clipStartNs = useHostTime ? c.startHostNs : c.startWallclockMs * 1e6;
    return [c.path, Math.max(0, (t0Ns - clipStartNs) / 1e9)];
  }));
  const durationSec = Math.max(0, (tEndNs - t0Ns) / 1e9);
  return { useHostTime, t0: t0Ns, tEnd: tEndNs, durationSec, headTrimsByPath };
}

function wallclockOfHostNs(clips, hostNs) {
  // Convert the host-time anchor to wallclock via the anchor clip, so
  // timeline events (which are wallclock) map to canvas seconds.
  let best = null;
  for (const c of clips) {
    if (Math.abs(c.startHostNs - hostNs) < 1e3) { best = c; break; }
  }
  if (!best) {
    best = clips.reduce((a, b) => (a.startHostNs > b.startHostNs ? a : b));
  }
  const deltaMs = (hostNs - best.startHostNs) / 1e6;
  return best.startWallclockMs + deltaMs;
}

module.exports = { loadContext, SUPPORTED_SCREENPLAY_VERSIONS, SUPPORTED_MANIFEST_VERSIONS };
