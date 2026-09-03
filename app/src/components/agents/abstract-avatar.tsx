import type { BotAvatarPreset } from "@/lib/avatar-preset";
import { GeneratedBotAvatar } from "./generated-bot-avatar";

export function AbstractAvatar({
  name,
  seed,
  image,
  preset,
  size = 40,
}: {
  name: string;
  seed: string;
  image?: string | null;
  preset?: BotAvatarPreset | null;
  size?: number;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {image ? (
        <img alt="" className="size-full object-cover" src={image} />
      ) : (
        <GeneratedBotAvatar preset={preset} seed={seed} size={size} />
      )}
    </span>
  );
}
