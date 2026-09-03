import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PluginMark } from "@/components/plugin-mark";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("uses the live catalogue logo and falls back when it cannot be loaded", () => {
  const { container } = render(
    <PluginMark
      logoUrl="https://cdn.example/github.svg"
      pluginKey="composio-github"
    />,
  );
  const image = container.querySelector("img");

  expect(image?.src).toBe("https://cdn.example/github.svg");
  fireEvent.error(image as HTMLImageElement);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeTruthy();
});
