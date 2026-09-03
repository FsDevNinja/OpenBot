export type BotAvatarPreset = {
  shape: number;
  color: number;
};

export const BOT_AVATAR_SHAPE_COUNT = 8;

export const BOT_AVATAR_COLORS = [
  "#050505",
  "#b18a62",
  "#ff4055",
  "#ff7417",
  "#ffae38",
  "#05c97d",
  "#1eb8aa",
  "#2d8df5",
  "#9878f8",
  "#f35ab0",
  "#969696",
] as const;

/** The same stable fallback used by the renderer before somebody chooses a preset. */
export function botAvatarPresetForSeed(seed: string): BotAvatarPreset {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  return {
    shape: unsigned % BOT_AVATAR_SHAPE_COUNT,
    color: (unsigned >>> 4) % BOT_AVATAR_COLORS.length,
  };
}

export function isBotAvatarPreset(value: unknown): value is BotAvatarPreset {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { shape?: unknown; color?: unknown };
  return (
    Number.isInteger(candidate.shape) &&
    Number.isInteger(candidate.color) &&
    Number(candidate.shape) >= 0 &&
    Number(candidate.shape) < BOT_AVATAR_SHAPE_COUNT &&
    Number(candidate.color) >= 0 &&
    Number(candidate.color) < BOT_AVATAR_COLORS.length
  );
}
