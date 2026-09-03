import { IconPalette } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPE_COUNT,
  type BotAvatarPreset,
  botAvatarPresetForSeed,
} from "@/lib/avatar-preset";
import { cn } from "@/lib/utils";
import { GeneratedBotAvatar } from "./generated-bot-avatar";

const SHAPE_NAMES = [
  "Circle",
  "Oval",
  "Rounded square",
  "Pill",
  "Triangle",
  "Hexagon",
  "Cloud",
  "Droplet",
] as const;

const COLOR_NAMES = [
  "Black",
  "Brown",
  "Coral",
  "Orange",
  "Amber",
  "Green",
  "Teal",
  "Blue",
  "Purple",
  "Pink",
  "Gray",
] as const;

/** Keep selection and keyboard focus inside the swatch so a scrolling dialog cannot clip them. */
export function avatarColorSwatchClass(selected: boolean) {
  return cn(
    "size-8 rounded-full border-2 border-popover outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    selected && "border-foreground/70 ring-2 ring-inset ring-popover",
  );
}

export function BotAvatarPresetPicker({
  seed,
  value,
  onChange,
  disabled = false,
}: {
  seed: string;
  value?: BotAvatarPreset | null;
  onChange: (preset: BotAvatarPreset | null) => Promise<unknown>;
  disabled?: boolean;
}) {
  const fallback = useMemo(() => botAvatarPresetForSeed(seed), [seed]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BotAvatarPreset>(value ?? fallback);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(value ?? fallback);
      setError(null);
    }
  }, [fallback, open, value]);

  const save = async (preset: BotAvatarPreset | null) => {
    setSaving(true);
    setError(null);
    try {
      await onChange(preset);
      setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save the preset.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        disabled={disabled}
        render={<Button size="sm" variant="outline" />}
      >
        <IconPalette />
        Preset
      </DialogTrigger>
      <DialogContent
        className="max-w-sm"
        overlayClassName="bg-black/20 backdrop-blur-sm"
      >
        <DialogHeader>
          <DialogTitle>Bot avatar preset</DialogTitle>
          <DialogDescription>
            Choose the transparent animated shape and color for this Bot.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <fieldset className="grid grid-cols-4 gap-2">
            <legend className="sr-only">Avatar shape</legend>
            {Array.from({ length: BOT_AVATAR_SHAPE_COUNT }, (_, shape) => (
              <button
                aria-label={SHAPE_NAMES[shape]}
                aria-pressed={draft.shape === shape}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-lg border border-transparent bg-muted/60 outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  draft.shape === shape && "border-foreground/40 bg-muted",
                )}
                key={SHAPE_NAMES[shape]}
                onClick={() => setDraft((current) => ({ ...current, shape }))}
                type="button"
              >
                <span className="size-12">
                  <GeneratedBotAvatar
                    preset={{ ...draft, shape }}
                    seed={`${seed}:${shape}`}
                    size={48}
                  />
                </span>
              </button>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Avatar color</legend>
            {BOT_AVATAR_COLORS.map((color, index) => (
              <button
                aria-label={COLOR_NAMES[index]}
                aria-pressed={draft.color === index}
                className={avatarColorSwatchClass(draft.color === index)}
                key={color}
                onClick={() =>
                  setDraft((current) => ({ ...current, color: index }))
                }
                style={{ backgroundColor: color }}
                type="button"
              />
            ))}
          </fieldset>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="justify-between">
          <Button
            disabled={saving || value == null}
            onClick={() => void save(null)}
            variant="ghost"
          >
            Reset
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => setOpen(false)} variant="secondary">
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void save(draft)}>
              {saving ? "Saving…" : "Set avatar"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
