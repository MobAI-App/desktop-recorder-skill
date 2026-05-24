import React from 'react';
import {OffthreadVideo} from 'remotion';

// The recording itself, filling the stage, framed as a rounded card.
export const RecordingCard: React.FC<{
  src: string;
  width: number;
  height: number;
  radius?: number;
  playbackRate?: number;
}> = ({src, width, height, radius = 18, playbackRate = 1}) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: radius,
        overflow: 'hidden',
        boxShadow: '0 50px 120px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
        background: '#0b1020',
      }}
    >
      <OffthreadVideo src={src} playbackRate={playbackRate} style={{width, height, display: 'block'}} />
    </div>
  );
};
