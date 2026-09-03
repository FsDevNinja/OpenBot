import type { CSSProperties } from "react";
import {
  BOT_AVATAR_COLORS,
  type BotAvatarPreset,
  botAvatarPresetForSeed,
} from "@/lib/avatar-preset";

const SHAPES = [
  <circle cx="50" cy="52" key="circle" r="37" />,
  <ellipse cx="50" cy="52" key="oval" rx="41" ry="29" />,
  <rect height="72" key="squircle" rx="20" width="72" x="14" y="16" />,
  <rect height="54" key="pill" rx="27" width="88" x="6" y="25" />,
  <path d="M50 10 91 84H9Z" key="peak" />,
  <path d="M50 9 84 29 84 70 50 91 16 70 16 29Z" key="hex" />,
  <path
    d="M15 72c0-12 8-21 20-22 2-15 31-17 34 1 11 1 18 9 18 20 0 12-9 20-21 20H35c-12 0-20-7-20-19Z"
    key="cloud"
  />,
  <path
    d="M50 7c8 15 31 36 31 55 0 18-13 30-31 30S19 80 19 62C19 43 42 22 50 7Z"
    key="drop"
  />,
] as const;

function hashSeed(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic OpenBot face with quiet, code-rendered motion.
 *
 * Identity comes from the seed, while animation is deliberately independent from run state:
 * eyes wander and blink even at rest; working remains the separate status badge in the roster.
 */
export function GeneratedBotAvatar({
  seed,
  size,
  preset,
}: {
  seed: string;
  size: number;
  preset?: BotAvatarPreset | null;
}) {
  const hash = hashSeed(seed);
  const chosen = preset ?? botAvatarPresetForSeed(seed);
  const shapeIndex = chosen.shape;
  const color = BOT_AVATAR_COLORS[chosen.color];
  const style = {
    "--avatar-breathe-duration": `${5.5 + ((hash >>> 8) % 20) / 10}s`,
    "--avatar-gaze-duration": `${6.5 + ((hash >>> 12) % 26) / 10}s`,
    "--avatar-blink-duration": `${4.4 + ((hash >>> 16) % 31) / 10}s`,
    "--avatar-blink-delay": `${-((hash >>> 20) % 50) / 10}s`,
  } as CSSProperties;

  return (
    <svg
      aria-hidden="true"
      className="openbot-generated-avatar size-full"
      data-avatar-background="transparent"
      data-avatar-motion="gaze-and-blink"
      data-avatar-shape={shapeIndex}
      height={size}
      preserveAspectRatio="xMidYMid slice"
      style={style}
      viewBox="0 0 100 100"
      width={size}
    >
      <g className="openbot-avatar-silhouette" fill={color}>
        {SHAPES[shapeIndex]}
      </g>
      <g className="openbot-avatar-gaze">
        <g className="openbot-avatar-eye openbot-avatar-eye-left">
          <rect
            fill="white"
            height="17"
            rx="4"
            transform="rotate(-12 37 51)"
            width="8"
            x="33"
            y="42.5"
          />
        </g>
        <g className="openbot-avatar-eye openbot-avatar-eye-right">
          <rect
            fill="white"
            height="17"
            rx="4"
            transform="rotate(-8 63 51)"
            width="8"
            x="59"
            y="42.5"
          />
        </g>
      </g>
    </svg>
  );
}
