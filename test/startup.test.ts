import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEnterpriseProvider } from "../src/provider.ts";
import { builtin, credential, known, row, store } from "./fixtures.ts";

const json: typeof fetch = async () => Response.json({ data: [row()] });

test("restores native stored availability during offline startup before live discovery", async () => {
  const models = createModels({ credentials: store({ ...credential, availableModelIds: [known.id] }) });
  models.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await models.refresh({ allowNetwork: false });
  assert.equal(models.getModel("github-copilot", known.id)?.id, known.id);
  assert.equal((await models.getAvailable())[0]?.id, known.id);
});
test("keeps native API-key availability without attempting OAuth discovery", async () => {
  const models = createModels({ credentials: store({ type: "api_key", key: "fake-token" }) });
  models.setProvider(createEnterpriseProvider(builtin(), async () => { throw new Error("Must not fetch"); }).provider);
  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal((await models.getAvailable())[0]?.id, known.id);
});
test("restores unknown models from a matching cache before startup model selection", async () => {
  const cache = new InMemoryModelsStore();
  const credentials = store();
  const first = createModels({ credentials, modelsStore: cache });
  first.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await first.refresh();
  const next = createModels({ credentials, modelsStore: cache });
  const discovery = createEnterpriseProvider(builtin(), json);
  next.setProvider(discovery.provider);
  await next.refresh({ allowNetwork: false });
  assert.equal(next.getModel("github-copilot", "new-model")?.id, "new-model");
  assert.equal((await next.getAvailable())[0]?.id, "new-model");
  assert.equal(discovery.status().source, "cached");
});
test("empty cached catalogs remain authoritative across restarts", async () => {
  const cache = new InMemoryModelsStore();
  const credentials = store();
  const first = createModels({ credentials, modelsStore: cache });
  first.setProvider(createEnterpriseProvider(builtin(), async () => Response.json({ data: [] })).provider);
  await first.refresh();
  const next = createModels({ credentials, modelsStore: cache });
  next.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await next.refresh({ allowNetwork: false });
  assert.deepEqual(await next.getAvailable(), []);
});
test("foreign account cache is discarded, not restored", async () => {
  const cache = new InMemoryModelsStore();
  const credentials = store();
  const first = createModels({ credentials, modelsStore: cache });
  first.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await first.refresh();
  const next = createModels({ credentials: store({ ...credential, refresh: "another-account" }), modelsStore: cache });
  next.setProvider(createEnterpriseProvider(builtin(), json).provider);
  await next.refresh({ allowNetwork: false });
  assert.equal(next.getModel("github-copilot", "new-model"), undefined);
  assert.equal(await cache.read("github-copilot"), undefined);
});
test("background refreshes honor freshness but manual force bypasses it", async () => {
  let calls = 0;
  const models = createModels({ credentials: store() });
  models.setProvider(createEnterpriseProvider(builtin(), async () => { calls++; return Response.json({ data: [row()] }); }).provider);
  await models.refresh();
  await models.refresh();
  assert.equal(calls, 1);
  await models.refresh({ force: true });
  assert.equal(calls, 2);
});
test("composed models.json path preserves topmost overrides and OAuth endpoint precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-enterprise-composition-"));
  try {
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify({ providers: { "github-copilot": {
      baseUrl: "https://configured.example", headers: { "X-Custom-Auth": "fixture-configured-header" },
      modelOverrides: { "new-model": { contextWindow: 90_000 } },
    } } }));
    const runtime = await ModelRuntime.create({ credentials: store(), modelsPath: path, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
    const discovery = createEnterpriseProvider(builtin(), async (input, init) => {
      assert.equal(input, "https://api.business.githubcopilot.com/models");
      assert.equal(new Headers(init?.headers).get("X-Custom-Auth"), "fixture-configured-header");
      return Response.json({ data: [row()] });
    });
    runtime.registerNativeProvider(discovery.provider);
    discovery.useAuthResolver((c) => runtime.getProvider("github-copilot")!.auth.oauth!.toAuth(c));
    const result = await runtime.refresh({ allowNetwork: true, providers: ["github-copilot"] });
    assert.equal(result.errors.size, 0);
    assert.equal(runtime.getModel("github-copilot", "new-model")?.contextWindow, 90_000);
    assert.equal((await runtime.getAvailable("github-copilot"))[0]?.id, "new-model");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
