import { createHmac } from "node:crypto";
import type { Api, Credential, Model, ModelAuth, ModelsStoreEntry, OAuthCredential, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { buildCatalog, type Catalog } from "./catalog.ts";

export const PROVIDER_ID = "github-copilot";
const CACHE_PREFIX = "pi-copilot-enterprise-models:v1:";
type OwnedCache = ModelsStoreEntry & { copilotEnterpriseOwner?: string };
const FRESH_MS = 60_000;
export interface DiscoveryStatus {
  phase: "pending" | "ready";
  source?: "native" | "cached" | "live";
  updatedAt?: string;
  catalog?: Catalog;
}
interface Snapshot { owner: string; catalog: Catalog; checkedAt?: number; source: "native" | "cached" | "live" }

function owner(credential: Credential | undefined): string | undefined {
  if (credential?.type !== "oauth" || !credential.refresh) return undefined;
  return createHmac("sha256", credential.refresh)
    .update(`${CACHE_PREFIX}owner\0${String(credential.enterpriseUrl ?? "")}`).digest("hex");
}

function endpoint(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw new Error("Copilot discovery requires a valid HTTPS base URL without credentials, query, or fragment.");
  }
}

/** Wrap only catalog discovery. Authentication and request streaming stay with Pi. */
export function createEnterpriseProvider(
  builtin: Provider,
  fetcher: typeof fetch = fetch,
  options: { waitForAuthResolver?: boolean } = {},
): { provider: Provider; status: () => DiscoveryStatus; useAuthResolver: (resolver: (credential: OAuthCredential) => Promise<ModelAuth>) => void } {
  if (builtin.id !== PROVIDER_ID || !builtin.auth.oauth) throw new Error("Pi's native GitHub Copilot OAuth provider is required.");
  const baseline = builtin.getModels();
  let resolveAuth = (credential: OAuthCredential) => builtin.auth.oauth!.toAuth(credential);
  let resolverBound = !options.waitForAuthResolver;
  let releaseResolver!: () => void;
  const resolverReady = new Promise<void>((resolve) => { releaseResolver = resolve; });
  const clientHeaders: Record<string, string> = {};
  const allowedHeaders = new Set(["user-agent", "editor-version", "editor-plugin-version", "copilot-integration-id"]);
  for (const model of baseline) {
    for (const [name, value] of Object.entries(model.headers ?? {})) {
      if (allowedHeaders.has(name.toLowerCase()) && typeof value === "string") clientHeaders[name] = value;
    }
  }
  // Store only public client identity headers, never resolved authentication headers.
  const publicModel = (model: Model<Api>): Model<Api> => ({ ...model, headers: { ...clientHeaders } });
  let snapshot: Snapshot | undefined;
  const models = (): readonly Model<Api>[] => snapshot?.catalog.models ?? baseline;
  const nativeFilter = (available: readonly Model<Api>[], credential: Credential | undefined) =>
    builtin.filterModels?.(available, credential) ?? available;
  const filter = (available: readonly Model<Api>[], credential: Credential | undefined) => {
    if (!snapshot || snapshot.owner !== owner(credential)) return nativeFilter(available, credential);
    const allowed = new Set(snapshot.catalog.models.map((model) => model.id));
    return available.filter((model) => allowed.has(model.id));
  };
  const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
    const identity = owner(context.credential);
    if (!context.allowNetwork) {
      if (!identity) {
        // API-key and ambient-token users keep Pi's native model behavior, without discovery.
        // A missing credential may mean a read failure, not logout. Keep disk state.
        await context.publish({ update: () => { snapshot = undefined; } });
        return;
      }
      if (snapshot?.owner === identity) return;
      const stored = context.stored as OwnedCache | undefined;
      if (stored?.copilotEnterpriseOwner === `${CACHE_PREFIX}${identity}` && Array.isArray(stored.models)) {
        // Validate persisted entries through the same normalization path as a live response.
        // Unknown cache metadata is ignored; only our owner-tagged entries can be restored.
        const cachedModels = stored.models.filter((m): m is Model<Api> =>
          !!m && (!m.type || m.type === "chat") && m.provider === PROVIDER_ID &&
          ["anthropic-messages", "openai-responses", "openai-completions"].includes(m.api) &&
          Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0 &&
          Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0,
        );
        const restored = buildCatalog({ data: cachedModels.map((m) => ({
          id: m.id, name: m.name, policy: { state: "enabled" }, model_picker_enabled: true,
          capabilities: { type: "chat", supports: { tool_calls: true } },
        })) }, cachedModels, builtin.baseUrl ?? "https://api.individual.githubcopilot.com");
        restored.models = restored.models.map(publicModel);
        const checkedAt = typeof stored.checkedAt === "number" && Number.isFinite(stored.checkedAt)
          && stored.checkedAt > 0 && stored.checkedAt <= Date.now() ? stored.checkedAt : undefined;
        await context.publish({ update: () => {
          snapshot = { owner: identity, catalog: restored, checkedAt, source: "cached" };
        } });
        return;
      }
      // Startup selection happens before network refresh. Preserve Pi's existing account filter.
      const fallback: Catalog = { models: [...nativeFilter(baseline, context.credential)], excluded: [], invalid: 0 };
      await context.publish({
        ...(typeof stored?.copilotEnterpriseOwner === "string" && stored.copilotEnterpriseOwner.startsWith(CACHE_PREFIX) ? { persist: null } : {}),
        update: () => { snapshot = { owner: identity, catalog: fallback, source: "native" }; },
      });
      return;
    }
    if (!identity || context.credential?.type !== "oauth" || context.signal.aborted) return;
    if (!context.force && snapshot?.owner === identity && snapshot.checkedAt && Date.now() - snapshot.checkedAt < FRESH_MS) return;
    if (!resolverBound) {
      // RPC may start its refresh before session_start binds the composed auth resolver.
      const readySignal = AbortSignal.any([context.signal, AbortSignal.timeout(1_000)]);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(new Error("Copilot composed authentication is not ready. Retry discovery after startup."));
        };
        if (readySignal.aborted) { onAbort(); return; }
        readySignal.addEventListener("abort", onAbort, { once: true });
        void resolverReady.then(() => {
          readySignal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      context.signal.throwIfAborted();
    }
    let auth;
    try { auth = await resolveAuth(context.credential); }
    catch { throw new Error("Copilot authentication could not be resolved. Try /login github-copilot."); }
    context.signal.throwIfAborted();
    if (!auth.apiKey) throw new Error("Copilot OAuth access token is missing. Run /login github-copilot.");
    // Match Pi's inference precedence: credential-specific auth endpoint wins over models.json.
    const baseUrl = endpoint(auth.baseUrl ?? context.baseUrl ?? builtin.baseUrl);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          ...clientHeaders, ...auth.headers,
          Accept: "application/json", Authorization: `Bearer ${auth.apiKey}`,
          "X-GitHub-Api-Version": "2026-06-01",
        },
        redirect: "error", signal,
      });
    } catch {
      context.signal.throwIfAborted();
      throw new Error(signal.aborted ? "Copilot model discovery timed out." : "Copilot model discovery failed. Check connectivity and the configured endpoint.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Copilot model discovery returned HTTP ${response.status}.`);
    }
    let raw: unknown;
    try { raw = await response.json(); }
    catch {
      context.signal.throwIfAborted();
      throw new Error(signal.aborted ? "Copilot model discovery timed out." : "Copilot returned invalid model JSON.");
    }
    context.signal.throwIfAborted();
    const catalog = buildCatalog(raw, baseline, baseUrl);
    catalog.models = catalog.models.map(publicModel);
    const checkedAt = Date.now();
    // Keep ownership OUT of HTTP validator fields: native Pi may read this shared entry.
    const persist: OwnedCache = { models: catalog.models, copilotEnterpriseOwner: `${CACHE_PREFIX}${identity}`, checkedAt };
    // Empty catalogs are authoritative too. Publication is generation-checked by Pi.
    await context.publish({
      persist,
      update: () => { snapshot = { owner: identity, catalog, checkedAt, source: "live" }; },
    });
  };
  return {
    useAuthResolver: (resolver) => { resolveAuth = resolver; resolverBound = true; releaseResolver(); },
    provider: {
      ...builtin, getModels: models, getAllModels: models, filterModels: filter,
      filterAllModels: (available, credential) => filter(
        available.filter((model): model is Model<Api> => !model.type || model.type === "chat"), credential,
      ),
      refreshModels,
    },
    status: () => snapshot
      ? { phase: "ready", source: snapshot.source,
          updatedAt: snapshot.checkedAt ? new Date(snapshot.checkedAt).toISOString() : undefined,
          catalog: snapshot.catalog }
      : { phase: "pending" },
  };
}
