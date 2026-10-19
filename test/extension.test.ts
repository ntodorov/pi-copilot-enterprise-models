import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { builtin, context, credential, row } from "./fixtures.ts";
import extension, { formatStatus } from "../src/index.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
function registered() {
  const events: string[] = [];
  let provider!: Provider;
  let start!: (event: unknown, ctx: unknown) => unknown;
  const commands = new Map<string, Handler>();
  extension({
    registerProvider: (registered: Provider) => { assert.equal(registered.id, "github-copilot"); provider = registered; },
    on: (event: string, handler: typeof start) => { events.push(event); start = handler; },
    registerCommand: (name: string, definition: { handler: Handler }) => { commands.set(name, definition.handler); },
  } as unknown as ExtensionAPI);
  return { events, commands, provider, start };
}
test("registers native provider during loading without a blocking startup handler", () => {
  const { events, commands } = registered();
  assert.deepEqual(events, ["session_start"]);
  assert.deepEqual([...commands.keys()], ["copilot-enterprise-refresh", "copilot-enterprise-status"]);
});
test("RPC-order refresh waits for synchronous session binding before sending composed headers", async (t) => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(init);
    return Response.json({ data: [row()] });
  });
  const { provider, start } = registered();
  const native = builtin();
  native.auth.oauth!.toAuth = async () => ({ apiKey: credential.access, baseUrl: "https://api.business.githubcopilot.com", headers: { "X-Composed": "fixture" } });
  const refresh = provider.refreshModels!(context({ publish: async (publication) => {
    assert.ok(!JSON.stringify(publication.persist).includes("X-Composed"));
    publication.update?.();
    return true;
  } }));
  await Promise.resolve();
  assert.equal(calls.length, 0);
  const result = start({}, { modelRegistry: { getProvider: () => native } });
  assert.equal(result, undefined);
  await refresh;
  assert.equal(new Headers(calls[0]?.headers).get("X-Composed"), "fixture");
});
test("status distinguishes pending discovery, native fallback, and empty live catalogs", () => {
  assert.match(formatStatus({ phase: "pending" }), /no verified catalog/);
  assert.match(formatStatus({ phase: "ready", source: "native", catalog: { models: [], excluded: [], invalid: 0 } }), /native availability/);
  assert.match(formatStatus({ phase: "ready", catalog: { models: [], excluded: [], invalid: 0 } }), /0 available/);
});
test("status caps exclusion output", () => {
  const text = formatStatus({ phase: "ready", catalog: {
    models: [], invalid: 1,
    excluded: Array.from({ length: 40 }, (_, i) => ({ id: `model-${i}`, reason: "policy disabled" })),
  } });
  assert.match(text, /15 more exclusions not shown/);
  assert.ok(text.split("\n").length < 30);
});
test("manual refresh supplies a 15 second overall auth-and-discovery budget", async (t) => {
  let requestedMs = 0;
  const budget = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { requestedMs = ms; return budget.signal; });
  const notifications: string[] = [];
  const { commands } = registered();
  await commands.get("copilot-enterprise-refresh")!("", {
    modelRegistry: { refresh: async (options: { signal: AbortSignal; force: boolean; providers: string[] }) => {
      assert.equal(options.signal, budget.signal);
      assert.equal(options.force, true);
      assert.deepEqual(options.providers, ["github-copilot"]);
      return { errors: new Map(), aborted: false };
    } },
    ui: { notify: (message: string) => { notifications.push(message); } },
  } as unknown as ExtensionCommandContext);
  assert.equal(requestedMs, 15_000);
  assert.match(notifications[0]!, /no verified catalog/);
});
test("command propagates parent cancellation and does not expose refresh errors", async () => {
  const abort = new AbortController();
  abort.abort();
  const notifications: string[] = [];
  const { commands } = registered();
  await commands.get("copilot-enterprise-refresh")!("", {
    signal: abort.signal,
    modelRegistry: { refresh: async ({ signal }: { signal: AbortSignal }) => {
      assert.equal(signal.aborted, true);
      return { errors: new Map([["github-copilot", new Error("SECRET")]]), aborted: true };
    } },
    ui: { notify: (message: string) => { notifications.push(message); } },
  } as unknown as ExtensionCommandContext);
  assert.match(notifications[0]!, /failed or was cancelled/);
  assert.ok(!notifications.join().includes("SECRET"));
});
