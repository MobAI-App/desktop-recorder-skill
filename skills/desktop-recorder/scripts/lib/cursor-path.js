// Shared cursor-path math. Both the highlights stage (cursor sprite) and
// the zoom stage (follow_cursor center) consume the SAME piecewise
// expression so the zoom camera tracks the synthetic cursor exactly.
//
// Waypoints are { tStart, canvasX, canvasY, glideSec?, linear? } in canvas
// seconds. Per destination waypoint b:
//
//   • linear (a point along a move.path / shape): constant-speed lerp over the
//     whole inter-sample interval, so the polyline traces smoothly.
//   • glideSec set (a `move` with a duration): glide over the move's own window
//     - hold at a until b.tStart, ease to b over glideSec (author-set speed).
//   • neither (a click): glide BEFORE arrival - hold at a until
//     b.tStart - travel, ease in, arrive exactly at b.tStart so the ripple
//     lands on a stationary cursor. travel = min(dist/SPEED, gap*0.9, MAX).
//
// The expression is a FLAT SUM, not nested ifs: position = pts[0] + Σ
// segmentDelta * ramp(t). Each ramp goes 0 before the segment, 1 after, so
// completed segments contribute their full delta and the rest contribute 0 -
// exactly piecewise position, but with no nesting depth. A nested form grows
// one level per waypoint and blows ffmpeg's expression parser on dense paths
// (a 48-point circle); the flat sum stays shallow. Windows are clamped to not
// overlap, so the terms never double-count.
//
// Before pts[0].tStart: hold at pts[0]. After the last: hold at last.

const TRAVEL_SPEED_PXPS = 1400;
const TRAVEL_DUR_MAX    = 0.55;

function cursorPathExpressions(pts) {
  if (pts.length === 0) return { xExpr: "0", yExpr: "0" };
  if (pts.length === 1) {
    return {
      xExpr: String(Math.round(pts[0].canvasX)),
      yExpr: String(Math.round(pts[0].canvasY)),
    };
  }

  // Pass 1: each segment's glide window + easing kind.
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const gap = Math.max(0.001, b.tStart - a.tStart);
    let gs, ge, linear = false;
    if (b.linear) {
      gs = a.tStart; ge = b.tStart; linear = true;
    } else if (b.glideSec != null && b.glideSec > 0.001) {
      gs = b.tStart; ge = b.tStart + Math.max(0.05, b.glideSec);
    } else {
      const dx = b.canvasX - a.canvasX, dy = b.canvasY - a.canvasY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const travel = Math.max(0.001, Math.min(dist / TRAVEL_SPEED_PXPS, gap * 0.9, TRAVEL_DUR_MAX));
      gs = b.tStart - travel; ge = b.tStart;
    }
    seg.push({ a, b, gs, ge, linear });
  }

  // Pass 2: clamp each window to end no later than the next one starts, so the
  // ramps never overlap (which the flat sum would otherwise double-count).
  for (let i = 0; i < seg.length - 1; i++) {
    if (seg[i].ge > seg[i + 1].gs) seg[i].ge = seg[i + 1].gs;
    if (seg[i].ge <= seg[i].gs) seg[i].ge = seg[i].gs + 0.001;
  }

  // Pass 3: flat sum of ramped deltas.
  const xTerms = [String(pts[0].canvasX)];
  const yTerms = [String(pts[0].canvasY)];
  for (const s of seg) {
    const dur = Math.max(0.001, s.ge - s.gs);
    const u = `min(1,max(0,(t-${s.gs.toFixed(3)})/${dur.toFixed(3)}))`;
    const ramp = s.linear ? u : `(if(lt(${u},0.5),4*pow(${u},3),1-pow(-2*${u}+2,3)/2))`;
    const dx = s.b.canvasX - s.a.canvasX;
    const dy = s.b.canvasY - s.a.canvasY;
    if (dx !== 0) xTerms.push(`(${dx.toFixed(2)})*${ramp}`);
    if (dy !== 0) yTerms.push(`(${dy.toFixed(2)})*${ramp}`);
  }
  return { xExpr: xTerms.join("+"), yExpr: yTerms.join("+") };
}

module.exports = { cursorPathExpressions, TRAVEL_SPEED_PXPS, TRAVEL_DUR_MAX };
