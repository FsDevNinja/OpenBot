import { expect, test } from "bun:test";
import { join } from "node:path";

/** Spawn the real entrypoint with only the environment Compose would hand it. */

async function startBot(environment: Record<string, string>) {
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "agent-bot", "src", "index.ts")],
    {
      // Every variable the repository's `.env` could inject is named explicitly: bun loads that
      // file into the child, and a leaked token or key would let a configuration under test pass
      // a check it is supposed to fail.
      env: {
        PATH: process.env.PATH ?? "",
        MANAGED_AGENT_TOKEN: "",
        OPENAI_API_KEY: "",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Both configurations under test exit before the server listens. If one reaches `serve` anyway,
  // kill it so the test fails on the missing refusal rather than on bun's test timeout.
  const killer = setTimeout(() => proc.kill(), 5_000);
  const exitCode = await proc.exited;
  clearTimeout(killer);
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

test("agent-bot has no deployment-key fallback for a user's run", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop();
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "agent-bot", "src", "index.ts")],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(port),
        MANAGED_AGENT_TOKEN: "test-token",
        OPENAI_API_KEY: "deployment-key-that-must-not-be-read",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let response: Response | undefined;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
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

test("agent-bot still refuses to start without its server token", async () => {
  const { exitCode, stderr } = await startBot({
    OPENAI_API_KEY: "sk-test",
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("MANAGED_AGENT_TOKEN is not set");
});
