import React from "react";
import {
  AbsoluteFill,
  Sequence,
  Video,
  Img,
  Audio,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
} from "remotion";

// ── Types matching the job payload Assembly.js (Apps Script) sends. Note:
//    server.js splits the raw scenes[] by "type" (hook/rank/cta) before
//    building these props — this composition only ever sees "rank" scenes
//    plus hook/cta audio pulled out separately. ──────────────────────────────
export type Scene = {
  rank: number;
  name: string;
  onScreenText: string;
  clipUrl: string;
  mediaType?: "image" | "video"; // "image" → Ken Burns still; default video clip
  audioUrl: string;
  audioDurationSec: number;
};

// Slow zoom + drift on a still image so it reads as motion b-roll (used for
// free AI-generated images instead of a video clip).
const KenBurnsImage: React.FC<{ src: string }> = ({ src }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 240], [1.05, 1.28], { extrapolateRight: "clamp" });
  const translateY = interpolate(frame, [0, 240], [0, -28], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "black" }}>
      <Img
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale}) translateY(${translateY}px)` }}
      />
    </AbsoluteFill>
  );
};

export type RankingVideoProps = {
  title: string;
  hook: string;
  hookAudioUrl: string;
  ctaAudioUrl: string;
  hookAudioDurationSec?: number;
  ctaAudioDurationSec?: number;
  scenes: Scene[];
};

const FPS = 30;

// Frames a scene should last to fit its audio, with a floor so silent/short
// scenes still hold long enough to read. +15 frames of tail padding.
const framesFor = (sec: number | undefined, minFrames: number): number =>
  Math.max(minFrames, Math.round((sec || 0) * FPS) + 15);

// ── Rank number that pops in with a spring ────────────────────────────────────
const RankBadge: React.FC<{ rank: number }> = ({ rank }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12, stiffness: 180 } });

  return (
    <div
      style={{
        position: "absolute",
        top: 80,
        left: 40,
        fontSize: 140,
        fontWeight: 900,
        color: "white",
        WebkitTextStroke: "6px black",
        transform: `scale(${scale})`,
        fontFamily: "Arial Black, sans-serif",
      }}
    >
      #{rank}
    </div>
  );
};

// ── Item name — the WHAT of the ranking. Sits under the rank badge and stays
//    on screen the whole scene so viewers always see what's ranked. ───────────
const NameTitle: React.FC<{ name: string }> = ({ name }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [2, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const translateX = interpolate(frame, [2, 14], [-40, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        top: 235,
        left: 40,
        right: 40,
        opacity,
        transform: `translateX(${translateX}px)`,
      }}
    >
      <span
        style={{
          display: "inline-block",
          background: "rgba(0,0,0,0.7)",
          color: "white",
          fontSize: 66,
          fontWeight: 900,
          fontFamily: "Arial Black, sans-serif",
          lineHeight: 1.1,
          padding: "14px 26px",
          borderRadius: 18,
          WebkitBoxDecorationBreak: "clone",
          boxDecorationBreak: "clone",
        }}
      >
        {name}
      </span>
    </div>
  );
};

// ── Bottom-third animated caption (the on-screen text / fact) ────────────────
const Caption: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const translateY = interpolate(frame, [0, 10], [30, 0], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        bottom: 160,
        left: 40,
        right: 40,
        opacity,
        transform: `translateY(${translateY}px)`,
        background: "rgba(0,0,0,0.65)",
        borderRadius: 24,
        padding: "24px 32px",
      }}
    >
      <p style={{ color: "white", fontSize: 52, fontWeight: 700, fontFamily: "Arial, sans-serif", margin: 0, lineHeight: 1.25 }}>
        {text}
      </p>
    </div>
  );
};

// ── One ranked item: background clip + rank badge + caption + synced audio ──
const RankScene: React.FC<{ scene: Scene }> = ({ scene }) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    {scene.clipUrl ? (
      scene.mediaType === "image"
        ? <KenBurnsImage src={scene.clipUrl} />
        : <Video src={scene.clipUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted />
    ) : null}
    <RankBadge rank={scene.rank} />
    {scene.name ? <NameTitle name={scene.name} /> : null}
    <Caption text={scene.onScreenText} />
    {scene.audioUrl ? <Audio src={scene.audioUrl} /> : null}
  </AbsoluteFill>
);

// ── Hook screen: big bold text, no video needed, just motion + audio ────────
const HookScene: React.FC<{ hook: string; audioUrl: string }> = ({ hook, audioUrl }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 15], [1.1, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#111", justifyContent: "center", alignItems: "center", padding: 60 }}>
      <p
        style={{
          color: "white",
          fontSize: 88,
          fontWeight: 900,
          textAlign: "center",
          fontFamily: "Arial Black, sans-serif",
          transform: `scale(${scale})`,
        }}
      >
        {hook}
      </p>
      {audioUrl ? <Audio src={audioUrl} /> : null}
    </AbsoluteFill>
  );
};

const CtaScene: React.FC<{ audioUrl: string }> = ({ audioUrl }) => (
  <AbsoluteFill style={{ backgroundColor: "#111", justifyContent: "center", alignItems: "center" }}>
    <p style={{ color: "white", fontSize: 60, fontWeight: 800, fontFamily: "Arial, sans-serif", textAlign: "center" }}>
      Which one surprised you? 👇
    </p>
    {audioUrl ? <Audio src={audioUrl} /> : null}
  </AbsoluteFill>
);

// ── Top-level composition: stitches hook → scenes (high rank to #1) → CTA ───
export const RankingVideo: React.FC<RankingVideoProps> = ({ hook, hookAudioUrl, ctaAudioUrl, hookAudioDurationSec, ctaAudioDurationSec, scenes }) => {
  const hookDurationFrames = framesFor(hookAudioDurationSec, 60); // adapts to the hook voiceover length
  let cursor = hookDurationFrames;

  const sceneSequences = scenes
    .slice()
    .sort((a, b) => b.rank - a.rank) // countdown: highest number first, #1 last
    .map((scene) => {
      const durationFrames = framesFor(scene.audioDurationSec, 60);
      const from = cursor;
      cursor += durationFrames;
      return (
        <Sequence key={scene.rank} from={from} durationInFrames={durationFrames}>
          <RankScene scene={scene} />
        </Sequence>
      );
    });

  const ctaDurationFrames = framesFor(ctaAudioDurationSec, 90); // adapts to the CTA voiceover length
  const ctaFrom = cursor;

  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={hookDurationFrames}>
        <HookScene hook={hook} audioUrl={hookAudioUrl} />
      </Sequence>
      {sceneSequences}
      <Sequence from={ctaFrom} durationInFrames={ctaDurationFrames}>
        <CtaScene audioUrl={ctaAudioUrl} />
      </Sequence>
    </AbsoluteFill>
  );
};

// Computes total duration from real hook/scene/CTA audio lengths — called by
// calculateMetadata in Root.tsx so the render isn't hardcoded to one length.
export function computeDurationInFrames(
  scenes: Scene[],
  hookAudioDurationSec?: number,
  ctaAudioDurationSec?: number
): number {
  const hookFrames = framesFor(hookAudioDurationSec, 60);
  const ctaFrames = framesFor(ctaAudioDurationSec, 90);
  const sceneFrames = scenes.reduce((sum, s) => sum + framesFor(s.audioDurationSec, 60), 0);
  return hookFrames + sceneFrames + ctaFrames;
}

export const VIDEO_FPS = FPS;
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
