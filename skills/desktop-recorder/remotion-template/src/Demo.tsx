// The creative composition - this is the file the agent edits. All the
// recording plumbing (parsing the contract, frame/coord mapping, cursor,
// ripples, captions) comes from ./bridge; here we only do the look.
import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {Recording, RecordingStage, RecordingCard, Cursor, ClickRipple, Caption} from './bridge';

const ACCENT = '#7c5cff';

const Blob: React.FC<{x: number; y: number; size: number; color: string; speed: number; phase: number}> = ({x, y, size, color, speed, phase}) => {
  const f = useCurrentFrame();
  return (
    <div style={{
      position: 'absolute', left: x + Math.sin(f * speed + phase) * 80, top: y + Math.cos(f * speed * 0.8 + phase) * 60,
      width: size, height: size, borderRadius: '50%', background: color, filter: 'blur(90px)', opacity: 0.5,
    }} />
  );
};

export const Demo: React.FC<{rec?: Recording}> = ({rec}) => {
  const frame = useCurrentFrame();
  const {fps, width, height, durationInFrames} = useVideoConfig();
  if (!rec) return null;

  const hue = interpolate(frame, [0, durationInFrames], [230, 320]);
  const bg = `radial-gradient(circle at 30% 20%, hsl(${hue},45%,18%), hsl(${hue + 40},55%,7%))`;

  // Fit the recording into the canvas, then spring it in and let it float/tilt.
  const margin = 150;
  const fit = Math.min((width - margin * 2) / rec.stageWidth, (height - margin * 2) / rec.stageHeight);
  const enter = spring({frame, fps, config: {damping: 14, mass: 0.9}});
  const scale = fit * interpolate(enter, [0, 1], [0.7, 1]);
  const floatY = Math.sin(frame / 22) * 12;
  const tiltY = Math.sin(frame / 40) * 6;

  const titleOut = interpolate(frame, [50, 70], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const titleIn = spring({frame: frame - 4, fps, config: {damping: 16}});

  return (
    <AbsoluteFill style={{background: bg, fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden'}}>
      <Blob x={-100} y={-120} size={620} color={ACCENT} speed={0.012} phase={0} />
      <Blob x={width - 500} y={height - 520} size={680} color="#21d4fd" speed={0.01} phase={2} />

      <div style={{
        position: 'absolute', top: 64, width: '100%', textAlign: 'center',
        opacity: interpolate(titleIn, [0, 1], [0, 1]) * titleOut,
        transform: `translateY(${interpolate(titleIn, [0, 1], [40, 0])}px)`,
      }}>
        <div style={{fontSize: 70, fontWeight: 800, color: 'white', letterSpacing: -2}}>
          deskagent <span style={{color: ACCENT}}>×</span> Remotion
        </div>
      </div>

      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div style={{perspective: 1600}}>
          <div style={{transform: `scale(${scale}) translateY(${floatY}px) rotateY(${tiltY}deg)`}}>
            <RecordingStage width={rec.stageWidth} height={rec.stageHeight}>
              <RecordingCard src={rec.videoSrc} width={rec.stageWidth} height={rec.stageHeight} />
              <ClickRipple events={rec.events} color={ACCENT} />
              <Cursor events={rec.events} size={30} />
            </RecordingStage>
          </div>
        </div>
      </AbsoluteFill>

      <Caption captions={rec.captions} accent={ACCENT} />
    </AbsoluteFill>
  );
};
