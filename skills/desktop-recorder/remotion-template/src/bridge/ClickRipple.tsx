import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {RecEvent} from './loadRecording';

// Expanding-ring ripple at each click. Place inside <RecordingStage>.
export const ClickRipple: React.FC<{events: RecEvent[]; durationMs?: number; color?: string}> = ({
  events, durationMs = 550, color = 'rgba(255,255,255,0.9)',
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const dur = (durationMs / 1000) * fps;
  return (
    <>
      {events
        .filter((e) => e.kind === 'click' && frame >= e.frame && frame < e.frame + dur)
        .map((e, i) => {
          const local = frame - e.frame;
          const r = interpolate(local, [0, dur], [6, 70]);
          const opacity = interpolate(local, [0, dur], [0.8, 0]);
          return (
            <div
              key={i}
              style={{
                position: 'absolute', left: e.x - r, top: e.y - r, width: r * 2, height: r * 2,
                borderRadius: '50%', border: `3px solid ${color}`, opacity,
              }}
            />
          );
        })}
    </>
  );
};
