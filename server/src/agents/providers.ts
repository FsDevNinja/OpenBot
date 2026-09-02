export const AGENT_PROVIDER_CATALOG = [
  {
    id: "codex",
    name: "Codex",
    description: "Uses the ChatGPT account you authorize for your agents.",
    authentication: "oauth",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Uses your OpenAI API account.",
    authentication: "api-key",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Uses Claude through your Anthropic API account.",
    authentication: "api-key",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Uses Grok through your xAI API account.",
    authentication: "api-key",
  },
  {
    id: "google",
    name: "Google",
    description: "Uses Gemini through your Google AI API account.",
    authentication: "api-key",
  },
] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_CATALOG)[number]["id"];
export type AgentProviderAuthentication =
  (typeof AGENT_PROVIDER_CATALOG)[number]["authentication"];

export type AgentProviderRuntime = {
  id: AgentProviderId;
  name: string;
  description: string;
  endpoint: URL;
  /** Secret sent only to this provider runtime. Never stored on an agent row. */
  token: string;
};

export function agentProviderDefinition(id: string) {
  return AGENT_PROVIDER_CATALOG.find((provider) => provider.id === id);
}

export function isAgentProviderId(value: string): value is AgentProviderId {
  return AGENT_PROVIDER_CATALOG.some((provider) => provider.id === value);
}
