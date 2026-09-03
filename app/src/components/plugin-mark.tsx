import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconPlug,
} from "@tabler/icons-react";
import { type ComponentType, useState } from "react";
import { RowMark } from "@/components/layout/row-mark";

const MARKS: Record<string, ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

/** A provider logo from the live catalogue, with a local mark if it cannot be loaded. */
export function PluginMark({
  logoUrl,
  pluginKey,
}: {
  logoUrl: string | null | undefined;
  pluginKey: string;
}) {
  const [failed, setFailed] = useState(false);
  const Mark = MARKS[pluginKey] ?? IconPlug;

  return (
    <RowMark>
      {logoUrl && !failed ? (
        <img
          alt=""
          className="size-5 object-contain"
          onError={() => setFailed(true)}
          src={logoUrl}
        />
      ) : (
        <Mark className="size-4" />
      )}
    </RowMark>
  );
}
