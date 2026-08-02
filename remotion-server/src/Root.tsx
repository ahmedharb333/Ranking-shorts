import React from "react";
import { Composition, registerRoot } from "remotion";
import {
  RankingVideo,
  RankingVideoProps,
  computeDurationInFrames,
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
} from "./RankingVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="RankingVideo"
      component={RankingVideo}
      durationInFrames={300} // placeholder — overridden per-render via calculateMetadata
      fps={VIDEO_FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
      defaultProps={{
        title: "Sample",
        hook: "You've been ranking this wrong",
        hookAudioUrl: "",
        ctaAudioUrl: "",
        scenes: [],
      } as RankingVideoProps}
      calculateMetadata={async ({ props }) => {
        return { durationInFrames: computeDurationInFrames(props.scenes) };
      }}
    />
  );
};

registerRoot(RemotionRoot);
