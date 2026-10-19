import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { createEnterpriseProvider } from "../src/provider.ts";
import { builtin, context, credential, known, row, store } from "./fixtures.ts";

function json(data: unknown = { data: [row()] }): typeof fetch {
  return async () => Response.json(data);
}

test("only changes catalog behavior, preserving native authentication and streaming", () => {
  const native = builtin();
  const { provider } = createEnterpriseProvider(native, json());
  assert.equal(provider.auth, native.auth);
  assert.equal(provider.stream, native.stream);
  assert.equal(provider.streamSimple, native.streamSimple);
  assert.deepEqual(provider.getModels(), [known]);
});
test("uses credential-specific endpoint and only GET; copies host client headers", async () => {
  let calls = 0;
  const { provider } = createEnterpriseProvider(builtin(), async (input, init) => {
    calls++;
    assert.equal(input, "https://api.business.githubcopilot.com/models");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${credential.access}`);
    assert.equal(headers.get("Editor-Version"), "fixture-editor/1");
    assert.equal(init?.body, undefined);
    return Response.json({ data: [row()] });
  });
  await provider.refreshModels!(context());
  assert.equal(calls, 1);
  assert.equal(provider.getModels()[0]?.headers?.["Editor-Version"], "fixture-editor/1");
  assert.deepEqual(provider.getAllModels!(), provider.getModels());
  assert.equal(provider.filterModels!(provider.getModels(), credential).length, 1);
  assert.equal(provider.filterModels!([known], credential).length, 0);
});
test("uses the OAuth endpoint over a configured endpoint, matching inference", async () => {
  const { provider } = createEnterpriseProvider(builtin(), async (input) => {
    assert.equal(input, "https://api.business.githubcopilot.com/models");
    return Response.json({ data: [row()] });
  });
  await provider.refreshModels!(context({ baseUrl: "https://company.example/copilot/" }));
});
for (const baseUrl of ["http://company.example", "https://user:secret@company.example", "https://company.example?key=secret", "not a url"]) {
  test(`rejects unsafe endpoint ${baseUrl.replace("secret", "redacted")}`, async () => {
    let calls = 0;
    const native = builtin();
    native.auth.oauth!.toAuth = async () => ({ apiKey: credential.access });
    const { provider } = createEnterpriseProvider(native, async () => { calls++; return Response.json({}); });
    await assert.rejects(provider.refreshModels!(context({ baseUrl })), /HTTPS base URL/);
    assert.equal(calls, 0);
  });
}
test("does not fetch offline, unauthenticated, with API keys, or after cancellation", async () => {
  let calls = 0;
  const { provider } = createEnterpriseProvider(builtin(), async () => { calls++; return Response.json({}); });
  for (const ctx of [context({ allowNetwork: false }), context({ credential: undefined }), context({ credential: { type: "api_key", key: "fixture" } }), context({ signal: AbortSignal.abort() })]) {
    await provider.refreshModels!(ctx);
  }
  assert.equal(calls, 0);
});
test("publishes transactionally with an owner-scoped normalized cache", async () => {
  const { provider } = createEnterpriseProvider(builtin(), json());
  await provider.refreshModels!(context({ publish: async (publication) => {
    assert.equal(publication.persist?.etag, undefined);
    assert.equal(publication.persist?.lastModified, undefined);
    assert.equal(typeof (publication.persist as { copilotEnterpriseOwner?: unknown })?.copilotEnterpriseOwner, "string");
    assert.ok(!JSON.stringify(publication.persist).includes(credential.access));
    assert.ok(!JSON.stringify(publication.persist).includes(credential.refresh));
    return false;
  } }));
  assert.deepEqual(provider.getModels(), [known]);
  await provider.refreshModels!(context());
  assert.equal(provider.getModels().length, 1);
});
test("successful empty catalog removes previously allowed models", async () => {
  let empty = false;
  const { provider } = createEnterpriseProvider(builtin(), async () => Response.json({ data: empty ? [] : [row()] }));
  await provider.refreshModels!(context());
  empty = true;
  await provider.refreshModels!(context());
  assert.deepEqual(provider.getModels(), []);
});
test("retains last successful same-account catalog on sanitized network/server errors", async () => {
  let fail = false;
  const { provider } = createEnterpriseProvider(builtin(), async () => fail ? new Response("SECRET SERVER BODY", { status: 403, statusText: "PRIVATE" }) : Response.json({ data: [row()] }));
  await provider.refreshModels!(context());
  fail = true;
  await assert.rejects(provider.refreshModels!(context()), { message: "Copilot model discovery returned HTTP 403." });
  assert.equal(provider.getModels().length, 1);
});
test("does not leak fetch exceptions, malformed JSON bodies, or URLs", async () => {
  for (const fetcher of [
    (async () => { throw new Error("SECRET URL"); }) as typeof fetch,
    (async () => new Response("SECRET BODY")) as typeof fetch,
  ]) {
    const { provider } = createEnterpriseProvider(builtin(), fetcher);
    await assert.rejects(provider.refreshModels!(context()), (error: Error) => !error.message.includes("SECRET"));
  }
});
test("forwards cancellation and never publishes an aborted result", async () => {
  const controller = new AbortController();
  const { provider } = createEnterpriseProvider(builtin(), async (_input, init) => {
    assert.ok(init?.signal);
    controller.abort();
    assert.equal(init.signal.aborted, true);
    return Response.json({ data: [row()] });
  });
  await assert.rejects(provider.refreshModels!(context({ signal: controller.signal })), { name: "AbortError" });
  assert.deepEqual(provider.getModels(), [known]);
});
test("account changes cannot reuse an old tenant's catalog", async () => {
  const { provider } = createEnterpriseProvider(builtin(), json());
  await provider.refreshModels!(context());
  const other = { ...credential, refresh: "different-fixture-account" };
  assert.equal(provider.filterModels!(provider.getModels(), other).length, 0);
  assert.equal(provider.filterModels!(provider.getModels(), { ...credential, access: "rotated-access-token" }).length, 1);
  await provider.refreshModels!(context({ credential: other, allowNetwork: false }));
  assert.deepEqual(provider.getModels(), [known]);
});
test("logout clears in-memory catalog through offline refresh", async () => {
  const { provider } = createEnterpriseProvider(builtin(), json());
  await provider.refreshModels!(context());
  await provider.refreshModels!(context({ credential: undefined, allowNetwork: false }));
  assert.deepEqual(provider.getModels(), [known]);
});
test("native Models integration exposes new models without the builtin static filter", async () => {
  const credentials = store();
  const models = createModels({ credentials });
  models.setProvider(createEnterpriseProvider(builtin(), json()).provider);
  assert.equal((await models.getAvailable()).length, 1);
  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal((await models.getAvailable())[0]?.id, "new-model");
  assert.equal((await models.getAllAvailable())[0]?.id, "new-model");
  await models.logout("github-copilot");
  await models.refresh({ allowNetwork: false });
  assert.deepEqual(await models.getAvailable(), []);
});
test("native Models integration rejects superseded refresh publications", async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let call = 0;
  const models = createModels({ credentials: store() });
  const discovery = createEnterpriseProvider(builtin(), async () => {
    if (++call === 1) { firstStarted(); await wait; return Response.json({ data: [row("stale")] }); }
    return Response.json({ data: [row("current")] });
  });
  models.setProvider(discovery.provider);
  const old = models.refresh();
  await started;
  await models.refresh();
  release();
  await old;
  assert.equal(models.getModels()[0]?.id, "current");
});
test("sanitizes toAuth rejection messages", async () => {
  const native = builtin();
  native.auth.oauth!.toAuth = async () => { throw new Error("SECRET auth response"); };
  const { provider } = createEnterpriseProvider(native, json());
  await assert.rejects(provider.refreshModels!(context()), { message: "Copilot authentication could not be resolved. Try /login github-copilot." });
});
test("discovery request timeout is bounded and reported without provider details", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 10_000);
    return AbortSignal.abort(new DOMException("SECRET provider details", "TimeoutError"));
  });
  const { provider } = createEnterpriseProvider(builtin(), async (_input, init) => {
    init?.signal?.throwIfAborted();
    return Response.json({});
  });
  await assert.rejects(provider.refreshModels!(context()), { message: "Copilot model discovery timed out." });
});
