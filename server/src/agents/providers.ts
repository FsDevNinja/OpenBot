export const AGENT_PROVIDER_CATALOG = [
  {
    id: "codex",
    name: "Codex",
    description: "Uses the ChatGPT account signed in on this machine.",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Uses an OpenAI API-backed agent runtime.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Uses Claude through an Anthropic-backed agent runtime.",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Uses Grok through an xAI-backed agent runtime.",
  },
  {
    id: "google",
    name: "Google",
    description: "Uses Gemini through a Google-backed agent runtime.",
  },
] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_CATALOG)[number]["id"];

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
