import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEnterpriseProvider, PROVIDER_ID, type DiscoveryStatus } from "./provider.ts";

export function formatStatus(status: DiscoveryStatus): string {
  if (!status.catalog) return "Copilot enterprise models: no verified catalog. Run /login github-copilot, then /copilot-enterprise-refresh. Discovery requires Pi OAuth credentials and network access.";
  const { models, excluded, invalid } = status.catalog;
  const lines = [
    `Copilot enterprise models: ${models.length} available, ${excluded.length} excluded, ${invalid} malformed entries.`,
    status.source === "native"
      ? "Using Pi's native availability until the first successful live discovery."
      : `Catalog source: ${status.source ?? "live"}. Last successful discovery: ${status.updatedAt ?? "unknown"}.`,
    "Catalog availability is not a guarantee that inference is permitted. Exclusion details are only retained for live discovery.",
  ];
  for (const entry of excluded.slice(0, 25)) lines.push(`${entry.id}: ${entry.reason}`);
  if (excluded.length > 25) lines.push(`${excluded.length - 25} more exclusions not shown.`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
  const builtin = builtinProviders().find((provider) => provider.id === PROVIDER_ID);
  if (!builtin) throw new Error("Pi 1.3.0 or later with the native Copilot provider is required.");
  const discovery = createEnterpriseProvider(builtin, fetch, { waitForAuthResolver: true });
  pi.registerProvider(discovery.provider);
  // Bind the composed auth lookup without starting network work or blocking startup.
  // This keeps models.json headers consistent with inference even after config reloads.
  pi.on("session_start", (_event, ctx) => {
    discovery.useAuthResolver(async (credential) => {
      const oauth = ctx.modelRegistry.getProvider(PROVIDER_ID)?.auth.oauth;
      if (!oauth) throw new Error("Copilot OAuth is unavailable.");
      return oauth.toAuth(credential);
    });
  });
  // Pi owns background refresh in interactive/RPC modes and after login.
  pi.registerCommand("copilot-enterprise-refresh", {
    description: "Refresh enterprise-allowed Copilot models without changing policies",
    handler: async (_args, ctx) => {
      const budget = AbortSignal.timeout(15_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, budget]) : budget;
      const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true, signal });
      if (result.aborted || result.errors.has(PROVIDER_ID)) {
        ctx.ui.notify("Copilot discovery failed or was cancelled. Check authentication and connectivity. Any previous catalog may be stale.", "error");
        return;
      }
      ctx.ui.notify(formatStatus(discovery.status()), "info");
    },
  });
  pi.registerCommand("copilot-enterprise-status", {
    description: "Show Copilot discovery counts and model exclusion reasons",
    handler: async (_args, ctx) => { ctx.ui.notify(formatStatus(discovery.status()), "info"); },
  });
}
