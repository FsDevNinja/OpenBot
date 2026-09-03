import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("takeover shows pending feedback, prevents duplicate requests, and reports failure", async () => {
  let finishTake!: (response: Response) => void;
  let takes = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async (input) => {
      if (String(input).endsWith("/control/take")) {
        takes++;
        return new Promise<Response>((resolve) => {
          finishTake = resolve;
        });
      }
      return new Response(
        JSON.stringify({ holder: "bot", requested: false, since: "now" }),
      );
    },
  );
  try {
    const view = render(
      <ComputerView computerId="take-feedback" active sessionControls />,
    );
    fireEvent.click(view.getByRole("button", { name: "Take control" }));
    const pending = view.getByRole("button", {
      name: "Taking control…",
    }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(takes).toBe(1);
    finishTake(new Response("unavailable", { status: 503 }));
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "Could not take control",
      ),
    );
    expect(view.queryByRole("dialog")).toBeNull();
  } finally {
    cleanup();
    fetchSpy.mockRestore();
  }
});

test("live sessions expose controls even between tool calls", () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/control")
            ? { holder: "bot", requested: false, since: "now" }
            : {
                base64: "PNG",
                url: "https://example.com",
                width: 1280,
                height: 800,
              },
        ),
      );
    },
  );
  try {
    const view = render(
      <ComputerView
        computerId="test-live"
        active
        finished={false}
        sessionControls
      />,
    );
    expect(view.getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Take control" })).toBeTruthy();
    expect(view.getByText("Browser · Live")).toBeTruthy();
  } finally {
    cleanup();
    fetchSpy.mockRestore();
  }
});

test("remounted history restores its saved image without polling today's screen or offering control", async () => {
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          frame: {
            frame: "SAVED",
            url: "https://example.com/then",
            title: "Then",
          },
        }),
      );
    },
  );
  try {
    const props = {
      computerId: "test-history",
      active: false,
      finished: true,
      sessionControls: true,
      toolCallId: "saved-history-1",
      page: { url: "https://example.com/then" },
    };
    const first = render(<ComputerView {...props} />);
    await waitFor(() =>
      expect(first.getByRole("img").getAttribute("src")).toBe(
        "data:image/png;base64,SAVED",
      ),
    );
    first.unmount();
    const second = render(<ComputerView {...props} />);
    expect(second.getByRole("img").getAttribute("src")).toBe(
      "data:image/png;base64,SAVED",
    );
    expect(second.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(second.getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(requests).toEqual([
      "/api/computers/test-history/page-frame/saved-history-1",
    ]);
  } finally {
    cleanup();
    fetchSpy.mockRestore();
  }
});
