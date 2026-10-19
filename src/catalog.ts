import type { Api, Model } from "@earendil-works/pi-ai";

type RecordValue = Record<string, unknown>;
export interface Exclusion { id: string; reason: string }
export interface Catalog {
  models: Model<Api>[];
  excluded: Exclusion[];
  invalid: number;
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
const endpoints = new Map<string, Api>([
  ["/v1/messages", "anthropic-messages"],
  ["/responses", "openai-responses"],
  ["/chat/completions", "openai-completions"],
]);

function selectApi(raw: unknown, known?: Model<Api>): Api | undefined {
  // Absent endpoint metadata is acceptable only for a model Pi already knows.
  if (raw === undefined) return known?.api;
  const supported = new Set(strings(raw).map((path) => endpoints.get(path)));
  if (known && supported.has(known.api)) return known.api;
  for (const api of endpoints.values()) if (supported.has(api)) return api;
  return undefined;
}

function thinkingMap(raw: unknown): Model<Api>["thinkingLevelMap"] {
  const efforts = new Set(strings(raw));
  const map: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    map[level] = efforts.has(level) ? level : null;
  }
  if (efforts.has("none")) map.off = "none";
  return map;
}

/** Untrusted tenant data is normalized here. No network or policy mutations. */
export function buildCatalog(raw: unknown, baseline: readonly Model<Api>[], baseUrl: string): Catalog {
  const data = record(raw).data;
  if (!Array.isArray(data)) throw new Error("Copilot returned an invalid model catalog.");
  const knownModels = new Map(baseline.map((model) => [model.id, model]));
  const counts = new Map<string, number>();
  for (const item of data) {
    const id = record(item).id;
    if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const result: Catalog = { models: [], excluded: [], invalid: 0 };
  const processed = new Set<string>();
  for (const item of data) {
    const row = record(item);
    const id = row.id;
    // Keep status output safe for terminal display and bounded per identifier.
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id)) {
      result.invalid++;
      continue;
    }
    if (processed.has(id)) continue;
    processed.add(id);
    const reject = (reason: string) => result.excluded.push({ id, reason });
    if (counts.get(id) !== 1) { reject("duplicate catalog ID"); continue; }
    const policy = record(row.policy).state;
    // Copilot can omit policy metadata on picker-enabled models. Absence is not a denial.
    // Explicit malformed/unknown states still fail closed; picker enablement is required below.
    const policyMissing = row.policy === undefined ||
      (row.policy !== null && typeof row.policy === "object" && !Array.isArray(row.policy) && !Object.hasOwn(row.policy, "state"));
    if (!policyMissing && policy !== "enabled") {
      reject(policy === "disabled" ? "policy disabled" : policy === "unconfigured" ? "policy unconfigured" : "policy unknown");
      continue;
    }
    if (row.model_picker_enabled !== true) { reject("not enabled in model picker"); continue; }
    const capabilities = record(row.capabilities);
    const supports = record(capabilities.supports);
    if (capabilities.type !== "chat") { reject("not a chat model"); continue; }
    const known = knownModels.get(id);
    if (supports.tool_calls === false || (!known && supports.tool_calls !== true)) {
      reject("tool calling not verified"); continue;
    }
    if (supports.streaming === false) { reject("streaming unavailable"); continue; }
    const api = selectApi(row.supported_endpoints, known);
    if (!api) { reject("no verified supported API"); continue; }
    // Compatibility flags must never cross API implementations.
    const compatibleKnown = known?.api === api ? known : undefined;
    const limits = record(capabilities.limits);
    const contextWindow = positiveInteger(limits.max_context_window_tokens)
      ?? positiveInteger(limits.max_prompt_tokens) ?? compatibleKnown?.contextWindow;
    const maxTokens = positiveInteger(limits.max_output_tokens) ?? compatibleKnown?.maxTokens;
    if (!contextWindow || !maxTokens) { reject("token limits unknown"); continue; }
    const efforts = strings(supports.reasoning_effort);
    const knownReasoning = compatibleKnown?.reasoning ?? false;
    const reasoning = knownReasoning || (api === "openai-responses" && efforts.some((e) => e !== "none"));
    const safeName = typeof row.name === "string" && row.name.length <= 200 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(row.name)
      ? row.name : id;
    result.models.push({
      ...compatibleKnown,
      id,
      name: safeName,
      provider: "github-copilot",
      baseUrl,
      api,
      reasoning,
      thinkingLevelMap: efforts.length > 0 && api === "openai-responses"
        ? thinkingMap(efforts) : compatibleKnown?.thinkingLevelMap,
      input: supports.vision === true ? ["text", "image"]
        : supports.vision === false ? ["text"] : compatibleKnown?.input ?? ["text"],
      contextWindow,
      maxTokens: Math.min(maxTokens, contextWindow),
      // These are Pi estimates, not Copilot premium-request accounting.
      cost: compatibleKnown?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  return result;
}
