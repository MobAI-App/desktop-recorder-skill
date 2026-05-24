import React from 'react';

// Sets up the recording's coordinate space (window CG points). Place
// <RecordingCard>, <Cursor>, <ClickRipple> inside it - they share these coords,
// so the creative composition can scale/position/animate the stage as one unit
// and everything stays aligned with the footage.
export const RecordingStage: React.FC<{
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({width, height, children}) => {
  return <div style={{position: 'relative', width, height}}>{children}</div>;
};
