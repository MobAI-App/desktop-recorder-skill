// Shared cursor-path math. Both the highlights stage (cursor sprite) and
// the zoom stage (follow_cursor center) consume the SAME piecewise
// expression so the zoom camera tracks the synthetic cursor exactly,
// not the raw click events.
//
// Model: at each transition click[i] → click[i+1], hold at click[i] until
//   moveStart = click[i+1].t - travelDur
// then ease cubic-in/out to click[i+1] arriving exactly at click[i+1].t.
//   travelDur = min(distance / TRAVEL_SPEED_PXPS, gap * 0.9, TRAVEL_DUR_MAX)
// Before clicks[0].t: hold at clicks[0]. After clicks[last].t: hold at last.

const TRAVEL_SPEED_PXPS = 1400;
const TRAVEL_DUR_MAX    = 0.55;

// `clicks` is an array of { tStart, canvasX, canvasY } in canvas seconds.
// Returns { xExpr, yExpr } - ffmpeg expressions over t.
function cursorPathExpressions(clicks) {
  if (clicks.length === 0) return { xExpr: "0", yExpr: "0" };
  if (clicks.length === 1) {
    return {
      xExpr: String(Math.round(clicks[0].canvasX)),
      yExpr: String(Math.round(clicks[0].canvasY)),
    };
  }

  // Build right-to-left; "after last click" hold falls through as the
  // outer-else case.
  let xExpr = String(clicks[clicks.length - 1].canvasX);
  let yExpr = String(clicks[clicks.length - 1].canvasY);
  for (let i = clicks.length - 2; i >= 0; i--) {
    const a = clicks[i];
    const b = clicks[i + 1];
    const dx = b.canvasX - a.canvasX;
    const dy = b.canvasY - a.canvasY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const gap  = Math.max(0.001, b.tStart - a.tStart);
    // Floor travel so coincident clicks (dist=0) don't divide by zero below.
    const travel = Math.max(0.001, Math.min(dist / TRAVEL_SPEED_PXPS, gap * 0.9, TRAVEL_DUR_MAX));
    const moveStart = b.tStart - travel;
    const u     = `((t-${moveStart})/${travel})`;
    const eased = `if(lt(${u},0.5),4*pow(${u},3),1-pow(-2*${u}+2,3)/2)`;
    const xLerp = `(${a.canvasX}+(${b.canvasX}-${a.canvasX})*(${eased}))`;
    const yLerp = `(${a.canvasY}+(${b.canvasY}-${a.canvasY})*(${eased}))`;
    xExpr = `if(lt(t,${b.tStart}),if(lt(t,${moveStart}),${a.canvasX},${xLerp}),${xExpr})`;
    yExpr = `if(lt(t,${b.tStart}),if(lt(t,${moveStart}),${a.canvasY},${yLerp}),${yExpr})`;
  }
  xExpr = `if(lt(t,${clicks[0].tStart}),${clicks[0].canvasX},${xExpr})`;
  yExpr = `if(lt(t,${clicks[0].tStart}),${clicks[0].canvasY},${yExpr})`;
  return { xExpr, yExpr };
}

module.exports = { cursorPathExpressions, TRAVEL_SPEED_PXPS, TRAVEL_DUR_MAX };
