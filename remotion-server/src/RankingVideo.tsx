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

// A shared cinematic grade so every clip (AI image, stock photo, video) reads as
// one consistent look instead of a stitched-together mix.
const GRADE = "saturate(1.12) contrast(1.08) brightness(1.02)";

// Vignette + top/bottom scrims: adds depth and guarantees the rank badge (top)
// and caption (bottom) stay legible over any image. Applied to every scene.
const GradeOverlay: React.FC = () => (
  <>
    <AbsoluteFill style={{ background: "radial-gradient(125% 85% at 50% 42%, transparent 52%, rgba(0,0,0,0.5) 100%)", pointerEvents: "none" }} />
    <AbsoluteFill style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 20%)", pointerEvents: "none" }} />
    <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0) 32%)", pointerEvents: "none" }} />
  </>
);

// Slow zoom + drift on a still image so it reads as motion b-roll. The motion
// VARIES per scene (variant) so consecutive scenes don't feel like the same
// static slideshow — alternating zoom-in / zoom-out and pan direction.
const KenBurnsImage: React.FC<{ src: string; variant?: number }> = ({ src, variant = 0 }) => {
  const frame = useCurrentFrame();
  const W = 210; // motion window (frames)
  let scale: number, tx = 0, ty = 0;
  switch (variant % 4) {
    case 1: // zoom OUT, drift down
      scale = interpolate(frame, [0, W], [1.26, 1.08], { extrapolateRight: "clamp" });
      ty = interpolate(frame, [0, W], [-20, 12], { extrapolateRight: "clamp" });
      break;
    case 2: // zoom in, pan LEFT
      scale = interpolate(frame, [0, W], [1.08, 1.24], { extrapolateRight: "clamp" });
      tx = interpolate(frame, [0, W], [24, -24], { extrapolateRight: "clamp" });
      break;
    case 3: // zoom in, pan RIGHT
      scale = interpolate(frame, [0, W], [1.08, 1.24], { extrapolateRight: "clamp" });
      tx = interpolate(frame, [0, W], [-24, 24], { extrapolateRight: "clamp" });
      break;
    default: // zoom in, drift UP
      scale = interpolate(frame, [0, W], [1.06, 1.26], { extrapolateRight: "clamp" });
      ty = interpolate(frame, [0, W], [12, -22], { extrapolateRight: "clamp" });
  }
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "black" }}>
      <Img
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "cover", filter: GRADE, transform: `scale(${scale}) translate(${tx}px, ${ty}px)` }}
      />
    </AbsoluteFill>
  );
};

// Full-bleed background for the hook/CTA (Img or Video), with a slow push-in so
// it never sits dead-still. Blur softens the hook bg so the text reads.
const BackgroundMedia: React.FC<{ src: string; type?: string; blur?: number }> = ({ src, type, blur = 0 }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 120], [1.12, 1.22], { extrapolateRight: "clamp" });
  const style: React.CSSProperties = {
    width: "100%", height: "100%", objectFit: "cover",
    filter: `${GRADE}${blur ? ` blur(${blur}px)` : ""}`,
    transform: `scale(${scale})`,
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "black" }}>
      {type === "video" ? <Video src={src} style={style} muted loop /> : <Img src={src} style={style} />}
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

// Drops "(...)" qualifiers so leaderboard rows stay compact.
const shortName = (n: string): string => n.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();

// ── Accumulating leaderboard: a compact tally of the items revealed so far so
//    viewers always see the ranking building up. Rows are UNIFORM size — the
//    current item is simply gold, not a second giant headline competing with
//    the big rank badge (which already owns the "current item" job). ──────────
const Leaderboard: React.FC<{ items: { rank: number; name: string }[]; currentRank: number }> = ({ items, currentRank }) => (
  <div style={{ position: "absolute", top: 480, right: 20, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9 }}>
    {items.map((it) => {
      const active = it.rank === currentRank;
      return (
        <div
          key={it.rank}
          style={{
            display: "flex", alignItems: "baseline", gap: 8, maxWidth: 470,
            background: active ? "rgba(245,197,24,0.96)" : "rgba(0,0,0,0.5)",
            color: active ? "#111" : "#fff",
            fontFamily: "Arial, sans-serif",
            fontWeight: active ? 900 : 700,
            fontSize: 30,
            padding: "7px 15px",
            borderRadius: 12,
            boxShadow: active ? "0 3px 12px rgba(0,0,0,0.35)" : "none",
          }}
        >
          <span style={{ fontWeight: 900, flexShrink: 0 }}>#{it.rank}</span>
          <span style={{
            maxWidth: 380, textAlign: "right",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            overflow: "hidden", lineHeight: 1.15,
          }}>{shortName(it.name)}</span>
        </div>
      );
    })}
  </div>
);

// ── One ranked item: background clip + grade + rank badge + caption + leaderboard + audio ──
const RankScene: React.FC<{ scene: Scene; revealed: { rank: number; name: string }[]; variant: number }> = ({ scene, revealed, variant }) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    {scene.clipUrl ? (
      scene.mediaType === "image"
        ? <KenBurnsImage src={scene.clipUrl} variant={variant} />
        : <Video src={scene.clipUrl} style={{ width: "100%", height: "100%", objectFit: "cover", filter: GRADE }} muted />
    ) : null}
    <GradeOverlay />
    <RankBadge rank={scene.rank} />
    {scene.name ? <NameTitle name={scene.name} /> : null}
    <Leaderboard items={revealed} currentRank={scene.rank} />
    <Caption text={scene.onScreenText} />
    {scene.audioUrl ? <Audio src={scene.audioUrl} /> : null}
  </AbsoluteFill>
);

// ── Hook screen: full-bleed hero image (the #1 payoff, blurred so it teases
//    without spoiling) behind a dark scrim + big bold text. No more black void. ─
const HookScene: React.FC<{ hook: string; audioUrl: string; heroSrc?: string; heroType?: string }> = ({ hook, audioUrl, heroSrc, heroType }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 15], [1.1, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0D0D", justifyContent: "center", alignItems: "center", padding: 60 }}>
      {heroSrc ? <BackgroundMedia src={heroSrc} type={heroType} blur={14} /> : null}
      <AbsoluteFill style={{ background: "rgba(0,0,0,0.5)", pointerEvents: "none" }} />
      <GradeOverlay />
      <p
        style={{
          position: "relative",
          color: "white",
          fontSize: 90,
          fontWeight: 900,
          textAlign: "center",
          lineHeight: 1.12,
          fontFamily: "Arial Black, sans-serif",
          textShadow: "0 4px 24px rgba(0,0,0,0.85)",
          transform: `scale(${scale})`,
        }}
      >
        {hook}
      </p>
      {audioUrl ? <Audio src={audioUrl} /> : null}
    </AbsoluteFill>
  );
};

// ── CTA: the #1 image back on screen (the payoff) with a scrim + prompt. ──────
const CtaScene: React.FC<{ audioUrl: string; heroSrc?: string; heroType?: string }> = ({ audioUrl, heroSrc, heroType }) => (
  <AbsoluteFill style={{ backgroundColor: "#0D0D0D", justifyContent: "center", alignItems: "center", padding: 60 }}>
    {heroSrc ? <BackgroundMedia src={heroSrc} type={heroType} blur={4} /> : null}
    <AbsoluteFill style={{ background: "rgba(0,0,0,0.55)", pointerEvents: "none" }} />
    <GradeOverlay />
    <p style={{
      position: "relative", color: "white", fontSize: 66, fontWeight: 900,
      fontFamily: "Arial Black, sans-serif", textAlign: "center", lineHeight: 1.15,
      textShadow: "0 4px 24px rgba(0,0,0,0.85)",
    }}>
      Which one surprised you? 👇
    </p>
    {audioUrl ? <Audio src={audioUrl} /> : null}
  </AbsoluteFill>
);

// ── Top-level composition: stitches hook → scenes (high rank to #1) → CTA ───
export const RankingVideo: React.FC<RankingVideoProps> = ({ hook, hookAudioUrl, ctaAudioUrl, hookAudioDurationSec, ctaAudioDurationSec, scenes }) => {
  const hookDurationFrames = framesFor(hookAudioDurationSec, 60); // adapts to the hook voiceover length
  let cursor = hookDurationFrames;

  const sorted = scenes.slice().sort((a, b) => b.rank - a.rank); // countdown: #5 first, #1 last

  // The #1 item's image is the payoff — reuse it as the hook/CTA background so
  // those scenes are never a blank screen. Fall back to any scene with a clip.
  const hero = sorted.find((s) => s.rank === 1 && s.clipUrl) || sorted.find((s) => s.clipUrl);
  const heroSrc = hero?.clipUrl || "";
  const heroType = hero?.mediaType || "image";

  const sceneSequences = sorted
    .map((scene, i) => {
      const durationFrames = framesFor(scene.audioDurationSec, 60);
      const from = cursor;
      cursor += durationFrames;
      // Items revealed so far (this scene included), for the accumulating leaderboard.
      const revealed = sorted.slice(0, i + 1).map((s) => ({ rank: s.rank, name: s.name }));
      return (
        <Sequence key={scene.rank} from={from} durationInFrames={durationFrames}>
          <RankScene scene={scene} revealed={revealed} variant={i} />
        </Sequence>
      );
    });

  const ctaDurationFrames = framesFor(ctaAudioDurationSec, 90); // adapts to the CTA voiceover length
  const ctaFrom = cursor;

  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={hookDurationFrames}>
        <HookScene hook={hook} audioUrl={hookAudioUrl} heroSrc={heroSrc} heroType={heroType} />
      </Sequence>
      {sceneSequences}
      <Sequence from={ctaFrom} durationInFrames={ctaDurationFrames}>
        <CtaScene audioUrl={ctaAudioUrl} heroSrc={heroSrc} heroType={heroType} />
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
