// Shared cursor-path math. Both the highlights stage (cursor sprite) and
// the zoom stage (follow_cursor center) consume the SAME piecewise
// expression so the zoom camera tracks the synthetic cursor exactly.
//
// Waypoints are { tStart, canvasX, canvasY, glideSec? } in canvas seconds.
// Two transition models, chosen per destination waypoint b:
//
//   • glideSec set (a `move` carrying an explicit duration): glide DURING the
//     move's own window - hold at a until b.tStart, ease to b over glideSec.
//     This is what the move action exposes, so the author controls the speed.
//
//   • glideSec absent (a click): glide BEFORE arrival - hold at a until
//     b.tStart - travel, then ease in, arriving exactly at b.tStart so the
//     ripple/pointer-hand land on a stationary cursor. travel is auto:
//     min(distance / TRAVEL_SPEED, gap*0.9, TRAVEL_DUR_MAX).
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

  let xExpr = String(pts[pts.length - 1].canvasX);
  let yExpr = String(pts[pts.length - 1].canvasY);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    const gap = Math.max(0.001, b.tStart - a.tStart);

    let glideStart, glideEnd, linear = false;
    if (b.linear) {
      // A point along a trajectory (move.path / shape): constant-speed lerp
      // over the whole inter-sample interval, so the polyline traces smoothly.
      glideStart = a.tStart;
      glideEnd = b.tStart;
      linear = true;
    } else if (b.glideSec != null && b.glideSec > 0.001) {
      // Glide over the move's own window: hold at a until b starts, then ease
      // to b over the move's duration.
      glideStart = b.tStart;
      glideEnd = b.tStart + Math.max(0.05, b.glideSec);
    } else {
      const dx = b.canvasX - a.canvasX;
      const dy = b.canvasY - a.canvasY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const travel = Math.max(0.001, Math.min(dist / TRAVEL_SPEED_PXPS, gap * 0.9, TRAVEL_DUR_MAX));
      glideStart = b.tStart - travel;
      glideEnd = b.tStart;
    }

    const dur = Math.max(0.001, glideEnd - glideStart);
    const u     = `((t-${glideStart.toFixed(3)})/${dur.toFixed(3)})`;
    const eased = linear
      ? `min(1,max(0,${u}))`
      : `if(lt(${u},0.5),4*pow(${u},3),1-pow(-2*${u}+2,3)/2)`;
    const xLerp = `(${a.canvasX}+(${b.canvasX}-${a.canvasX})*(${eased}))`;
    const yLerp = `(${a.canvasY}+(${b.canvasY}-${a.canvasY})*(${eased}))`;
    xExpr = `if(lt(t,${glideEnd.toFixed(3)}),if(lt(t,${glideStart.toFixed(3)}),${a.canvasX},${xLerp}),${xExpr})`;
    yExpr = `if(lt(t,${glideEnd.toFixed(3)}),if(lt(t,${glideStart.toFixed(3)}),${a.canvasY},${yLerp}),${yExpr})`;
  }
  xExpr = `if(lt(t,${pts[0].tStart.toFixed(3)}),${pts[0].canvasX},${xExpr})`;
  yExpr = `if(lt(t,${pts[0].tStart.toFixed(3)}),${pts[0].canvasY},${yExpr})`;
  return { xExpr, yExpr };
}

module.exports = { cursorPathExpressions, TRAVEL_SPEED_PXPS, TRAVEL_DUR_MAX };
