import { expect, test } from "bun:test";
import { join } from "node:path";

test("agent-langgraph has no deployment-key fallback for a user's run", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop();
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "agent-langgraph", "src", "index.ts")],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(port),
        MANAGED_AGENT_TOKEN: "test-token",
        BOT_PROVIDER: "openai",
        OPENAI_API_KEY: "deployment-key-that-must-not-be-read",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let response: Response | undefined;
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        response = await fetch(`http://localhost:${port}/ag-ui`, {
          method: "POST",
          headers: { "x-openbot-agent-token": "test-token" },
          body: "{}",
        });
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
  } finally {
    proc.kill();
    await proc.exited;
  }

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({
    error: "This runtime serves openai.",
  });
});
