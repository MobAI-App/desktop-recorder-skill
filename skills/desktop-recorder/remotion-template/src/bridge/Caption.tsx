import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {RecCaption} from './loadRecording';

// Output-canvas captions (not inside the stage): positioned by `y` fraction +
// `align`, springing in at startFrame, gone at endFrame.
export const Caption: React.FC<{captions: RecCaption[]; accent?: string}> = ({
  captions, accent = '#7c5cff',
}) => {
  const frame = useCurrentFrame();
  const {fps, height} = useVideoConfig();
  return (
    <>
      {captions
        .filter((c) => frame >= c.startFrame && frame < c.endFrame)
        .map((c, i) => {
          const pop = spring({frame: frame - c.startFrame, fps, config: {damping: 12}});
          const justify = c.align === 'left' ? 'flex-start' : c.align === 'right' ? 'flex-end' : 'center';
          return (
            <div
              key={i}
              style={{
                position: 'absolute', left: 0, right: 0, top: height * c.y,
                display: 'flex', justifyContent: justify, padding: '0 6%',
                transform: `translateY(${interpolate(pop, [0, 1], [24, 0])}px)`,
                opacity: interpolate(pop, [0, 1], [0, 1]),
              }}
            >
              <span style={{
                fontSize: 38, fontWeight: 700, color: 'white', fontFamily: 'Inter, system-ui, sans-serif',
                background: 'rgba(124,92,255,0.22)', border: `1px solid ${accent}88`,
                padding: '12px 30px', borderRadius: 999, backdropFilter: 'blur(8px)',
              }}>
                {c.text}
              </span>
            </div>
          );
        })}
    </>
  );
};
