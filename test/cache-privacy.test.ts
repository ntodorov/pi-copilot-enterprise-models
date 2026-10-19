import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai";
// Regression test against the host's internal shared-cache consumer, not a runtime dependency.
import { withRemoteCatalog } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/remote-catalog-provider.js";
import { createEnterpriseProvider } from "../src/provider.ts";
import { builtin, context, row, store } from "./fixtures.ts";

const json: typeof fetch = async () => Response.json({ data: [row()] });

test("native Pi does not send cache ownership to pi.dev when the extension is disabled", async (t) => {
  const cache = new InMemoryModelsStore();
  const models = createModels({ credentials: store(), modelsStore: cache });
  models.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await models.refresh();
  const persisted = await cache.read("github-copilot");
  assert.equal(persisted?.etag, undefined);
  assert.equal(persisted?.lastModified, undefined);
  assert.equal(typeof (persisted as { copilotEnterpriseOwner?: string }).copilotEnterpriseOwner, "string");
  let called = false;
  t.mock.method(globalThis, "fetch", async (input: URL | string, init: RequestInit) => {
    called = true;
    assert.match(String(input), /^https:\/\/pi\.dev\/api\/models\/providers\/github-copilot/);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("if-none-match"), null);
    assert.equal(headers.get("authorization"), null);
    assert.ok(!JSON.stringify([...headers]).includes("pi-copilot-enterprise-models"));
    return new Response(null, { status: 404 });
  });
  models.setProvider(withRemoteCatalog(builtin()));
  const result = await models.refresh({ force: true });
  assert.equal(result.errors.size, 0);
  assert.equal(called, true);
});
test("credential read errors hide the snapshot but preserve the owner-scoped disk cache", async () => {
  const cache = new InMemoryModelsStore();
  const credentials = store();
  const first = createModels({ credentials, modelsStore: cache });
  first.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await first.refresh();
  const persisted = await cache.read("github-copilot");
  const failing = createModels({ credentials: {
    ...credentials, read: async () => { throw new Error("fixture credential storage unavailable"); },
  }, modelsStore: cache });
  const discovery = createEnterpriseProvider(builtin(), json);
  failing.setProvider(discovery.provider);
  const result = await failing.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 1);
  assert.equal(discovery.status().phase, "pending");
  assert.deepEqual(await cache.read("github-copilot"), persisted);
});
test("unbound composed-auth discovery has a bounded wait and sends no request", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 1_000);
    return AbortSignal.abort();
  });
  const discovery = createEnterpriseProvider(builtin(), async () => { throw new Error("must not fetch"); }, { waitForAuthResolver: true });
  await assert.rejects(discovery.provider.refreshModels!(context()), /composed authentication is not ready/);
});
