import React from 'react';
import {useCurrentFrame} from 'remotion';
import {cursorAt, RecEvent} from './loadRecording';

// Synthetic cursor that follows the pointer track (clicks + moves) in stage
// coords. Place inside <RecordingStage>. Pure JS per frame - none of the
// ffmpeg-expression limits of the built-in pipeline.
export const Cursor: React.FC<{events: RecEvent[]; size?: number}> = ({events, size = 26}) => {
  const frame = useCurrentFrame();
  const pos = cursorAt(events, frame);
  if (!pos) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{position: 'absolute', left: pos.x, top: pos.y, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))'}}
    >
      <path d="M3 2 L3 20 L8 15 L11.5 22 L14 21 L10.5 14 L17 14 Z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
};
