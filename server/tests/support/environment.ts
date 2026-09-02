/**
 * The minimum environment a deployment is allowed to boot with, for tests that need a config but are
 * not testing configuration itself.
 *
 * It lives in one place because authentication and encryption are shared prerequisites. Tests that
 * assert on configuration should keep building their environment inline; everything else should
 * spread this.
 */
export function testEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    // Required whenever a provider is configured: nothing else grants the administrator role.
    INITIAL_ADMIN_EMAILS: "admin@openbot.test",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    MANAGED_AGENT_TOKEN: "managed-agent-token",
    ...overrides,
  };
}
