import type { Api, Credential, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";

export const credential = {
  type: "oauth" as const,
  refresh: "fixture-refresh-not-a-real-token",
  access: "fixture-access-not-a-real-token",
  expires: Date.now() + 3_600_000,
};
export const known: Model<Api> = {
  id: "known-model", name: "Known model", api: "openai-responses", provider: "github-copilot",
  baseUrl: "https://api.individual.githubcopilot.com", reasoning: true,
  thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: null },
  compat: { supportsMidConvoSystemMessages: true },
  headers: { "Editor-Version": "fixture-editor/1", "Copilot-Integration-Id": "fixture" },
  input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000,
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
};
export function row(id = "new-model", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, name: id, policy: { state: "enabled" }, model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat", supports: { tool_calls: true, streaming: true, vision: true },
      limits: { max_context_window_tokens: 100_000, max_output_tokens: 8_000 },
    }, ...extra,
  };
}
export function builtin(): Provider {
  return {
    id: "github-copilot", name: "GitHub Copilot", baseUrl: known.baseUrl,
    auth: { apiKey: {
      name: "Copilot token",
      resolve: async ({ credential: c }) => c?.key ? { auth: { apiKey: c.key } } : undefined,
    }, oauth: {
      name: "GitHub Copilot",
      login: async () => credential,
      refresh: async (c) => c,
      toAuth: async (c) => ({ apiKey: c.access, baseUrl: "https://api.business.githubcopilot.com" }),
    } },
    getModels: () => [known], getAllModels: () => [known],
    filterModels: (models) => models.filter((model) => model.id === known.id),
    stream: () => { throw new Error("No inference in unit tests"); },
    streamSimple: () => { throw new Error("No inference in unit tests"); },
  };
}
export function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    credential, allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async (publication) => { publication.update?.(); return true; },
    ...overrides,
  };
}
export function store(initial: Credential | undefined = credential) {
  let current: Credential | undefined = initial;
  return {
    read: async () => current,
    list: async () => current ? [{ providerId: "github-copilot", type: current.type }] : [],
    modify: async (_id: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>) => {
      current = (await fn(current)) ?? current;
      return current;
    },
    delete: async () => { current = undefined; },
  };
}
