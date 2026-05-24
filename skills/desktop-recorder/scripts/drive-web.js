#!/usr/bin/env node
// Web-driver adapter: drives a Chrome page over the DevTools Protocol and emits
// a timeline.json in the same contract as `deskagent control`, so the editor
// (export.js) aligns the synthetic cursor / zoom / captions to web actions.
//
// CDP injects input at the renderer level: no OS focus, no foreground, the real
// cursor never moves. That's the whole point - Chrome can sit unfocused (even
// behind other windows) and still be driven while `deskagent record` captures
// its window.
//
// Zero dependencies: speaks CDP over Node's built-in WebSocket (Node >= 22).
//
// Coordinates written to the timeline are window-space CG points - viewport CSS
// pixels plus the browser chrome height - matching pointToCanvasPixel() in
// lib/screenplay.js (which normalizes window-space x/y by the clip's CG-point
// dimensions). CSS px == CG points at 100% page zoom on the captured window.
//
// Usage:
//   node drive-web.js <screenplay.json> \
//     --cdp-port 9222 \
//     --window-frame "x,y,w,h"   (CG points, from `deskagent list`) \
//     --timeline out/timeline.json \
//     [--url-match github.com]   (substring to pick the page target)

const http = require("http");
const fs = require("fs");

function fatal(msg) { console.error(`error: ${msg}`); process.exit(5); }
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { cdpPort: 9222, urlMatch: null, screenplay: null, timeline: null, windowFrame: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--cdp-port") a.cdpPort = Number(argv[++i]);
    else if (t === "--url-match") a.urlMatch = argv[++i];
    else if (t === "--timeline") a.timeline = argv[++i];
    else if (t === "--window-frame") a.windowFrame = argv[++i];
    else rest.push(t);
  }
  a.screenplay = rest[0];
  if (!a.screenplay) fatal("screenplay path is required");
  if (!a.timeline) fatal("--timeline <path> is required");
  if (!a.windowFrame) fatal('--window-frame "x,y,w,h" is required (CG points from `deskagent list`)');
  const wf = a.windowFrame.split(",").map(Number);
  if (wf.length !== 4 || wf.some((n) => !Number.isFinite(n))) fatal(`bad --window-frame: ${a.windowFrame}`);
  a.frame = { x: wf[0], y: wf[1], w: wf[2], h: wf[3] };
  return a;
}

// ---------------------------------------------------------------------------
// minimal CDP client over the built-in WebSocket
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error(`CDP socket error: ${e.message || e}`)));
      this.ws.addEventListener("message", (ev) => this._onMessage(ev.data));
    });
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      const cbs = this.listeners.get(msg.method);
      if (cbs) for (const cb of cbs) cb(msg.params);
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      const cb = (p) => { clearTimeout(to); resolve(p); };
      this.on(method, cb);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    // Don't override the Host header: Chrome echoes it back into the
    // webSocketDebuggerUrl, so a portless Host yields a portless ws:// URL.
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function discoverPage(port, urlMatch) {
  const targets = await httpGetJSON(`http://127.0.0.1:${port}/json/list`);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (pages.length === 0) fatal(`no page targets on CDP port ${port} (is Chrome launched with --remote-debugging-port=${port}?)`);
  const pick = urlMatch ? pages.find((p) => (p.url || "").includes(urlMatch)) : pages[0];
  if (!pick) fatal(`no page target whose URL matches "${urlMatch}" (have: ${pages.map((p) => p.url).join(", ")})`);
  // Normalize the ws authority to the known loopback:port - Chrome derives it
  // from the request Host header, which can come back without the port.
  const u = new URL(pick.webSocketDebuggerUrl);
  u.host = `127.0.0.1:${port}`;
  pick.webSocketDebuggerUrl = u.toString();
  return pick;
}

// Build a polyline (array of window-space {x,y}) from an action's path/shape.
// Returns null for a plain single-point action. Shapes are authoring sugar
// that compile down to a polyline - the timeline only ever carries points.
function buildPath(act) {
  if (Array.isArray(act.path)) return act.path.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  if (act.shape === "circle") {
    const cx = Number(act.cx), cy = Number(act.cy), r = Number(act.r);
    const seg = Math.max(8, Number(act.points ?? 48));
    const turns = Number(act.turns ?? 1);
    const start = Number(act.startDeg ?? -90) * Math.PI / 180;
    const dir = act.ccw ? -1 : 1;
    const total = Math.max(1, Math.round(seg * turns));
    const pts = [];
    for (let i = 0; i <= total; i++) {
      const a = start + dir * (i / seg) * 2 * Math.PI;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  }
  if (act.shape === "line") {
    return [{ x: Number(act.x1), y: Number(act.y1) }, { x: Number(act.x2), y: Number(act.y2) }];
  }
  return null;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const screenplay = JSON.parse(fs.readFileSync(args.screenplay, "utf8"));
  if (!Array.isArray(screenplay.scenes)) fatal(`screenplay missing "scenes" array`);

  const page = await discoverPage(args.cdpPort, args.urlMatch);
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");

  // Force 100% page zoom so CSS px == CG points for the coord mapping.
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }).catch(() => {});

  const eval_ = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate threw");
    return r.result.value;
  };

  const viewport = await eval_("({iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio})");
  // Browser chrome (tabs + toolbar) height in CG points: total window minus
  // the web content viewport. Content is flush-left, so x offset is ~0.
  const chromeH = args.frame.h - viewport.ih;
  const winPoint = (cssX, cssY) => [cssX, chromeH + cssY];

  // Pointer state for down -> move -> up gestures, and last cursor position.
  let buttons = 0;
  let lastCss = [Math.round(viewport.iw / 2), Math.round(viewport.ih / 2)];
  // Resolve an action's target to viewport CSS px (selector/text/raw/last).
  async function resolveCss(act) {
    let c;
    if (act.selector || act.text != null) {
      const b = await boxOf(act, { scroll: act.scroll !== false, smooth: act.smooth !== false });
      c = [b.x + b.w / 2, b.y + b.h / 2];
    } else if (act.x != null) {
      c = [act.x, act.y - chromeH];
    } else {
      c = lastCss;
    }
    lastCss = c;
    return c;
  }
  // Carries the current button state, so a held button makes this a drag.
  // Densify ~6px between consecutive points: a sparse path (e.g. a 2-point
  // line) must emit enough move events for the page to draw incrementally,
  // otherwise the stroke jumps straight to the end and pops in fully drawn.
  async function hoverAlong(path, durationMs) {
    const dense = [[path[0].x, path[0].y - chromeH]];
    for (let i = 1; i < path.length; i++) {
      const prev = [path[i - 1].x, path[i - 1].y - chromeH];
      const cur  = [path[i].x, path[i].y - chromeH];
      const steps = Math.max(1, Math.round(Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) / 6));
      for (let s = 1; s <= steps; s++) {
        dense.push([prev[0] + (cur[0] - prev[0]) * s / steps, prev[1] + (cur[1] - prev[1]) * s / steps]);
      }
    }
    const stepMs = durationMs / Math.max(1, dense.length - 1);
    for (const css of dense) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: css[0], y: css[1], buttons });
      lastCss = css;
      await sleep(stepMs);
    }
  }

  // --- per-action primitives ----------------------------------------------
  // A locator is { selector } (CSS) or { text, tag? } (element whose text
  // matches; tag defaults to headings). Returns a JS expression yielding the
  // element or null.
  function elementJS(loc) {
    if (loc.selector) return `document.querySelector(${JSON.stringify(loc.selector)})`;
    if (loc.text != null) {
      const tag = JSON.stringify(loc.tag || "h1,h2,h3,h4,h5,h6");
      const t = JSON.stringify(String(loc.text));
      // Visible only: GitHub renders duplicate mobile/desktop rows, and a
      // hidden duplicate has a zero box -> clicking it would miss.
      return `(() => { const els = [...document.querySelectorAll(${tag})]`
        + `.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });`
        + ` return els.find(e => e.textContent.trim() === ${t})`
        + ` || els.find(e => e.textContent.trim().includes(${t})) || null; })()`;
    }
    return "null";
  }
  const locDesc = (loc) => loc.selector ? `selector "${loc.selector}"` : `text "${loc.text}"`;

  async function mouseClick(cssX, cssY) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cssX, y: cssY, buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cssX, y: cssY, button: "left", buttons: 1, clickCount: 1 });
    await sleep(35);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cssX, y: cssY, button: "left", buttons: 0, clickCount: 1 });
  }
  // Resolve a locator's on-screen box (CSS px, viewport-relative). Optionally
  // scroll it into view (smooth) first, settling so the recording catches it.
  async function boxOf(loc, { scroll = false, smooth = true } = {}) {
    const E = elementJS(loc);
    const found = await eval_(`!!(${E})`);
    if (!found) throw new Error(`element not found by ${locDesc(loc)}`);
    if (scroll) {
      await eval_(`(${E}).scrollIntoView({behavior: ${smooth ? "'smooth'" : "'auto'"}, block: 'center', inline: 'center'})`);
      // settle: poll the element's own viewport top until stable. Works whether
      // the page scrolls window or an inner container (GitHub blob view does).
      let lastTop = NaN;
      for (let i = 0; i < 60; i++) {
        const top = await eval_(`(() => { const e = ${E}; return e ? e.getBoundingClientRect().top : 0; })()`);
        if (Number.isFinite(lastTop) && Math.abs(top - lastTop) < 0.5) break;
        lastTop = top; await sleep(40);
      }
      await sleep(150);
    }
    return eval_(`(() => { const e = ${E}; const b = e.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; })()`);
  }
  async function waitFor(loc, timeoutMs = 8000) {
    const E = elementJS(loc);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await eval_(`!!(${E})`)) return;
      if (Date.now() > deadline) throw new Error(`wait_for timed out: ${locDesc(loc)}`);
      await sleep(120);
    }
  }

  // --- timeline -------------------------------------------------------------
  const t0 = Date.now();
  const events = [];
  const elapsed = () => Date.now() - t0;
  const SPACE = "window";
  const pushScene = (kind, sceneId, sceneIndex) => {
    const ms = elapsed(), wall = Date.now();
    events.push({
      type: kind, scene_id: sceneId, scene_index: sceneIndex,
      action_id: null, action_index: null, action: null,
      startedAtMs: ms, endedAtMs: ms,
      startedAtWallclockMs: wall, endedAtWallclockMs: wall,
      x: null, y: null, coordinate_space: SPACE,
    });
  };

  // --- dispatch one action, return { x, y, path? } in window space ---------
  async function runAction(act) {
    switch (act.action) {
      case "wait":
        await sleep(act.ms ?? 0);
        return { x: null, y: null };
      case "navigate": {
        const loaded = cdp.once("Page.loadEventFired", act.timeoutMs ?? 15000).catch(() => {});
        await cdp.send("Page.navigate", { url: act.url });
        await loaded;
        await sleep(300);
        return { x: null, y: null };
      }
      case "wait_for":
        await waitFor(act, act.timeoutMs);
        return { x: null, y: null };
      case "scroll_to": {
        const b = await boxOf(act, { scroll: true, smooth: act.smooth !== false });
        const [x, y] = winPoint(b.x + b.w / 2, b.y + b.h / 2);
        return { x, y };
      }
      case "scroll": {
        // relative scroll in CSS px; dy>0 scrolls down (content up)
        await eval_(`window.scrollBy({top: ${Number(act.dy ?? 0)}, left: ${Number(act.dx ?? 0)}, behavior: 'smooth'})`);
        await sleep(act.settleMs ?? 500);
        return { x: null, y: null };
      }
      case "scroll_page": {
        // Cinematic rAF-driven scroll over durationMs (easeInOutQuad). dy = px
        // to travel; omit dy to scroll to the bottom. Smoothness depends on the
        // window compositing at full rate (launch Chrome with the
        // --disable-*backgrounding* / throttling flags when recording unfocused).
        const dur = Number(act.durationMs ?? 4000);
        const dyExpr = act.dy != null ? `Math.min(max, start + ${Number(act.dy)})` : `max`;
        await eval_(`new Promise((res) => {
          const dur = ${dur};
          const start = window.scrollY;
          const max = document.documentElement.scrollHeight - window.innerHeight;
          const target = ${dyExpr};
          const dist = target - start;
          const t0 = performance.now();
          function step(now) {
            const p = Math.min(1, (now - t0) / dur);
            const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
            window.scrollTo(0, start + dist * e);
            if (p < 1) requestAnimationFrame(step); else res();
          }
          requestAnimationFrame(step);
        })`);
        await sleep(150);
        return { x: null, y: null };
      }
      case "click": {
        const [cssX, cssY] = await resolveCss(act);
        await mouseClick(cssX, cssY);
        await sleep(act.settleMs ?? 200);
        const [x, y] = winPoint(cssX, cssY);
        return { x, y };
      }
      case "move": {
        // Cursor waypoint to draw the viewer's eye. A `path`/`shape` traces a
        // trajectory (the editor follows the polyline); otherwise it glides to
        // a single element/point over durationMs.
        const path = buildPath(act);
        if (path) {
          await hoverAlong(path, Number(act.durationMs ?? Math.max(600, path.length * 35)));
          const last = path[path.length - 1];
          return { x: last.x, y: last.y, path };
        }
        const [cssX, cssY] = await resolveCss(act);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cssX, y: cssY, buttons });
        // The action's duration becomes the glide time (editor eases the cursor
        // to this point over it). durationMs controls speed.
        await sleep(act.durationMs ?? 700);
        const [x, y] = winPoint(cssX, cssY);
        return { x, y };
      }
      case "pointer_down": {
        const [cssX, cssY] = await resolveCss(act);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cssX, y: cssY, button: "left", buttons: 1, clickCount: 1 });
        buttons = 1;
        await sleep(act.settleMs ?? 120);
        const [x, y] = winPoint(cssX, cssY);
        return { x, y };
      }
      case "pointer_move": {
        // A held button makes this a drag, so down/move/up composes a gesture.
        const path = buildPath(act);
        if (path) {
          await hoverAlong(path, Number(act.durationMs ?? Math.max(400, path.length * 35)));
          const last = path[path.length - 1];
          return { x: last.x, y: last.y, path };
        }
        const [cssX, cssY] = await resolveCss(act);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cssX, y: cssY, buttons });
        await sleep(act.durationMs ?? 500);
        const [x, y] = winPoint(cssX, cssY);
        return { x, y };
      }
      case "pointer_up": {
        const [cssX, cssY] = await resolveCss(act);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cssX, y: cssY, button: "left", buttons: 0, clickCount: 1 });
        buttons = 0;
        await sleep(act.settleMs ?? 150);
        const [x, y] = winPoint(cssX, cssY);
        return { x, y };
      }
      case "key": {
        const vk = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33 };
        const k = String(act.key || "");
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk[k] || 0 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk[k] || 0 });
        await sleep(act.settleMs ?? 250);
        return { x: null, y: null };
      }
      case "type": {
        if (act.selector) await eval_(`document.querySelector(${JSON.stringify(act.selector)}).focus()`);
        for (const ch of String(act.text ?? "")) {
          await cdp.send("Input.insertText", { text: ch });
          await sleep(act.perCharMs ?? 40);
        }
        return { x: null, y: null };
      }
      default:
        fatal(`unknown web action: ${act.action}`);
    }
  }

  // --- walk scenes ----------------------------------------------------------
  for (const [sceneIndex, scene] of screenplay.scenes.entries()) {
    pushScene("scene_start", scene.id, sceneIndex);
    for (const [actionIndex, act] of (scene.actions || []).entries()) {
      const startMs = elapsed(), startWall = Date.now();
      let res = { x: null, y: null };
      try {
        res = await runAction(act);
      } catch (e) {
        fatal(`scene "${scene.id}" action ${actionIndex} (${act.action}): ${e.message}`);
      }
      const endMs = elapsed(), endWall = Date.now();
      events.push({
        type: "action", scene_id: scene.id, scene_index: sceneIndex,
        action_id: `${scene.id}/${actionIndex}`, action_index: actionIndex,
        action: act.action,
        startedAtMs: startMs, endedAtMs: endMs,
        startedAtWallclockMs: startWall, endedAtWallclockMs: endWall,
        x: res.x, y: res.y, coordinate_space: SPACE,
        ...(res.path ? { path: res.path } : {}),
      });
    }
    pushScene("scene_end", scene.id, sceneIndex);
  }

  fs.writeFileSync(args.timeline, JSON.stringify(events, null, 2));
  cdp.close();
  console.log(JSON.stringify({ status: "ok", events: events.length, timeline: args.timeline, chromeHeightPts: chromeH, viewport }, null, 2));
}

main().catch((e) => fatal(e.stack || e.message));
