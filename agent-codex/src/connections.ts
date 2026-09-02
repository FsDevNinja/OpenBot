import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CodexAppServerClient,
  type CodexLoginStatus,
  launchCodex,
} from "./codex-client";

const CONNECTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One isolated Codex app-server and CODEX_HOME for each OpenBot user's connection. */
export class CodexConnectionManager {
  private readonly clients = new Map<string, Promise<CodexAppServerClient>>();

  constructor(
    private readonly authRoot: string,
    private readonly workspace: string,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  async startLogin(connectionId: string) {
    const client = await this.client(connectionId);
    return client.startDeviceLogin();
  }

  async loginStatus(
    connectionId: string,
    loginId: string,
  ): Promise<CodexLoginStatus> {
    return (await this.client(connectionId)).loginStatus(loginId);
  }

  async cancelLogin(connectionId: string, loginId: string): Promise<void> {
    const client = await this.client(connectionId);
    await client.cancelLogin(loginId);
    client.stop();
    this.clients.delete(connectionId);
    await rm(this.home(connectionId), { recursive: true, force: true });
  }

  async authenticatedClient(
    connectionId: string,
  ): Promise<CodexAppServerClient> {
    const client = await this.client(connectionId);
    await client.requireAuthenticated();
    return client;
  }

  async disconnect(connectionId: string): Promise<void> {
    const client = await this.client(connectionId);
    try {
      if (client.accountSummary()) await client.logout();
    } finally {
      client.stop();
      this.clients.delete(connectionId);
      await rm(this.home(connectionId), { recursive: true, force: true });
    }
  }

  private client(connectionId: string): Promise<CodexAppServerClient> {
    assertConnectionId(connectionId);
    const existing = this.clients.get(connectionId);
    if (existing) return existing;

    const created = this.createClient(connectionId);
    this.clients.set(connectionId, created);
    void created.catch(() => this.clients.delete(connectionId));
    return created;
  }

  private async createClient(
    connectionId: string,
  ): Promise<CodexAppServerClient> {
    const home = this.home(connectionId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const client = new CodexAppServerClient(() =>
      launchCodex(
        {
          ...process.env,
          CODEX_AGENT_WORKSPACE: this.workspace,
        },
        home,
      ),
    );
    await client.start();
    return client;
  }

  private home(connectionId: string): string {
    assertConnectionId(connectionId);
    return resolve(this.authRoot, connectionId);
  }
}

export function assertConnectionId(connectionId: string): void {
  if (!CONNECTION_ID.test(connectionId)) {
    throw new Error("That Codex connection id is invalid.");
  }
}
