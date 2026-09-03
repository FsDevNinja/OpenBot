import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { avatarColorSwatchClass } from "@/components/agents/bot-avatar-preset-picker";
import { UserAvatar } from "@/components/people/user-avatar";
import { AvatarUploadActions } from "@/components/ui/avatar-upload-actions";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("an uploaded coworker image replaces the generated avatar", () => {
  const { getByRole } = render(
    <AbstractAvatar
      image="data:image/png;base64,chosen"
      name="Researcher"
      seed="researcher"
    />,
  );

  expect(
    getByRole("img", { name: "Researcher" }).querySelector("img")?.src,
  ).toBe("data:image/png;base64,chosen");
});

test("a generated coworker face exposes transparent idle-motion hooks", () => {
  const { getByRole } = render(
    <AbstractAvatar name="Researcher" seed="researcher" />,
  );

  const generated = getByRole("img", { name: "Researcher" }).querySelector(
    '[data-avatar-motion="gaze-and-blink"]',
  );
  expect(generated).toBeTruthy();
  expect(generated?.getAttribute("data-avatar-background")).toBe("transparent");
  expect(
    generated?.querySelector(".openbot-avatar-eye rect")?.getAttribute("width"),
  ).toBe("8");
  expect(
    generated
      ?.querySelector(".openbot-avatar-eye rect")
      ?.getAttribute("height"),
  ).toBe("17");
});

test("a chosen Bot preset controls the transparent silhouette and color", () => {
  const { getByRole } = render(
    <AbstractAvatar
      name="Researcher"
      preset={{ shape: 7, color: 9 }}
      seed="researcher"
    />,
  );

  const generated = getByRole("img", { name: "Researcher" }).querySelector(
    '[data-avatar-shape="7"]',
  );
  expect(generated).toBeTruthy();
  expect(
    generated
      ?.querySelector(".openbot-avatar-silhouette")
      ?.getAttribute("fill"),
  ).toBe("#f35ab0");
});

test("a selected avatar color keeps its selection treatment inside its clipped container", () => {
  const selected = avatarColorSwatchClass(true);

  expect(selected).toContain("ring-inset");
  expect(selected).toContain("border-foreground/70");
  expect(selected).not.toContain("ring-offset");
});

test("an uploaded GIF owns its motion instead of receiving generated animation", () => {
  const { getByRole } = render(
    <AbstractAvatar
      image="data:image/gif;base64,animated"
      name="Researcher"
      seed="researcher"
    />,
  );

  const avatar = getByRole("img", { name: "Researcher" });
  expect(avatar.querySelector("img")?.src).toBe(
    "data:image/gif;base64,animated",
  );
  expect(avatar.querySelector("[data-avatar-motion]")).toBeNull();
});

test("a person without an image gets readable initials", () => {
  const { getByRole } = render(
    <UserAvatar email="ninja@example.test" name="Ninja Builder" />,
  );

  expect(getByRole("img", { name: "Ninja Builder" }).textContent).toBe("NB");
});

test("only a custom image offers removal", () => {
  const { getByRole, queryByRole, rerender } = render(
    <AvatarUploadActions
      hasCustomImage={false}
      hasImage
      label="your avatar"
      onChange={async () => {}}
    />,
  );
  expect(queryByRole("button", { name: "Remove your avatar" })).toBeNull();

  rerender(
    <AvatarUploadActions
      hasCustomImage
      hasImage
      label="your avatar"
      onChange={async () => {}}
    />,
  );
  expect(getByRole("button", { name: "Remove your avatar" })).toBeTruthy();
});
