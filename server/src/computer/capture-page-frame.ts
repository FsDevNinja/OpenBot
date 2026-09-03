import type { ComputerGateway } from "./gateway";
import type { PageFrameStore } from "./page-frames";

export type CapturedPageFrame = { id: string; url: string; title?: string };

/** Save an immutable, bot-scoped frame while the browser action still owns the screen. */
export async function captureProviderPageFrame(
  gateway: ComputerGateway,
  store: PageFrameStore | undefined,
  computerId: string,
  page?: { url?: string; title?: string },
): Promise<CapturedPageFrame | undefined> {
  if (!store) return undefined;
  try {
    if (gateway.provider.isolation === "shared" && !page?.url) return undefined;
    if ((await gateway.status(computerId)).state !== "ready") return undefined;
    const shot = await gateway.screenshot(computerId);
    if (Buffer.byteLength(shot.base64, "utf8") > 4 * 1024 * 1024)
      return undefined;
    // Old shared images cannot identify whose page is showing. Do not file another bot's screen.
    const url =
      shot.url ??
      (gateway.provider.isolation === "per-bot" ? page?.url : undefined);
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    if (page?.url && new URL(url).href !== new URL(page.url).href)
      return undefined;
    const frame = {
      id: `browser-frame-${crypto.randomUUID()}`,
      url,
      ...(page?.title ? { title: page.title } : {}),
    };
    await store.save({
      computerId,
      toolCallId: frame.id,
      url,
      title: frame.title,
      frame: shot.base64,
    });
    return frame;
  } catch (error) {
    // A preview is optional. Do not turn a successful browser action into a tool failure.
    console.warn(
      "[computer] Could not retain provider browser frame:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export const PROVIDER_BROWSER_TOOLS = new Set([
  "openbot_computer_navigate",
  "openbot_computer_read",
  "openbot_computer_snapshot",
  "openbot_computer_click",
  "openbot_computer_type",
  "openbot_computer_key",
  "openbot_computer_scroll",
  "openbot_computer_request_help",
]);
