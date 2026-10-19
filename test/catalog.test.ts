import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog } from "../src/catalog.ts";
import { known, row } from "./fixtures.ts";

const url = "https://api.business.githubcopilot.com";
function catalog(...rows: unknown[]) { return buildCatalog({ data: rows }, [known], url); }

test("adds a new enabled tenant model using advertised capabilities", () => {
  const { models } = catalog(row());
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "new-model");
  assert.equal(models[0]?.api, "openai-responses");
  assert.equal(models[0]?.baseUrl, url);
  assert.deepEqual(models[0]?.input, ["text", "image"]);
  assert.equal(models[0]?.contextWindow, 100_000);
  assert.equal(models[0]?.maxTokens, 8_000);
});

for (const state of ["disabled", "unconfigured", "unexpected", undefined]) {
  test(`does not offer policy state ${state}`, () => {
    const result = catalog(row("restricted", { policy: { state } }));
    assert.equal(result.models.length, 0);
    assert.match(result.excluded[0]!.reason, /policy/);
  });
}
test("accepts picker-enabled known and new models when policy metadata is omitted", () => {
  for (const id of [known.id, "new-model"]) {
    for (const policy of [undefined, {}]) {
      assert.equal(catalog(row(id, { policy })).models[0]?.id, id);
    }
  }
});
test("missing policy never bypasses picker enablement or capability checks", () => {
  for (const picker of [false, undefined, "true"]) {
    assert.equal(catalog(row("hidden", { policy: undefined, model_picker_enabled: picker })).models.length, 0);
  }
  assert.equal(catalog(row("not-chat", { policy: undefined, capabilities: { type: "embedding" } })).models.length, 0);
});
test("rejects malformed policy values instead of treating them as omitted", () => {
  for (const policy of [null, false, "enabled", [], { state: null }, { state: false }, { state: "" }]) {
    assert.equal(catalog(row("malformed-policy", { policy })).models.length, 0);
  }
});
for (const picker of [false, undefined, "true"]) {
  test(`requires explicit picker enablement, not ${picker}`, () => {
    assert.equal(catalog(row("hidden", { model_picker_enabled: picker })).models.length, 0);
  });
}
test("rejects duplicate IDs even when only one entry has a disabled policy", () => {
  const result = catalog(row(), row("new-model", { policy: { state: "disabled" } }));
  assert.equal(result.models.length, 0);
  assert.deepEqual(result.excluded, [{ id: "new-model", reason: "duplicate catalog ID" }]);
});
test("preserves known API, reasoning, headers, compatibility, pricing, and missing limits", () => {
  const result = catalog(row(known.id, { supported_endpoints: undefined, capabilities: { type: "chat" } }));
  const model = result.models[0]!;
  assert.equal(model.api, known.api);
  assert.deepEqual(model.thinkingLevelMap, known.thinkingLevelMap);
  assert.deepEqual(model.compat, known.compat);
  assert.deepEqual(model.headers, known.headers);
  assert.deepEqual(model.cost, known.cost);
  assert.equal(model.contextWindow, known.contextWindow);
  assert.equal(model.maxTokens, known.maxTokens);
});
test("advertised endpoints win over names and incompatible known API flags", () => {
  const model = catalog(row(known.id, { supported_endpoints: ["/chat/completions"] })).models[0]!;
  assert.equal(model.api, "openai-completions");
  assert.equal(model.compat, undefined);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(model.reasoning, false);
  assert.equal(catalog(row("claude-unfamiliar")).models[0]?.api, "openai-responses");
});
for (const [path, api] of [["/responses", "openai-responses"], ["/chat/completions", "openai-completions"], ["/v1/messages", "anthropic-messages"]]) {
  test(`routes advertised ${path} to ${api}`, () => {
    assert.equal(catalog(row("unfamiliar", { supported_endpoints: [path] })).models[0]?.api, api);
  });
}
test("skips unknown protocols and unknown models without endpoints or limits", () => {
  assert.equal(catalog(row("a", { supported_endpoints: ["ws:/responses"] })).models.length, 0);
  assert.equal(catalog(row("a", { supported_endpoints: undefined })).models.length, 0);
  assert.equal(catalog(row("a", { capabilities: { type: "chat", supports: { tool_calls: true } } })).models.length, 0);
});
test("does not invent reasoning levels", () => {
  const model = catalog(row("reasoner", { capabilities: {
    type: "chat", supports: { tool_calls: true, reasoning_effort: ["low", "high"] },
    limits: { max_context_window_tokens: 100_000, max_output_tokens: 8_000 },
  } })).models[0]!;
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
});
test("rejects non-chat, non-tool and non-streaming models", () => {
  for (const capabilities of [
    { type: "embedding" },
    { type: "chat", supports: { tool_calls: false } },
    { type: "chat", supports: { tool_calls: true, streaming: false } },
    { type: "chat", supports: {} },
  ]) assert.equal(catalog(row("a", { capabilities })).models.length, 0);
});
test("invalid nested data and token limits cannot create malformed models", () => {
  for (const limits of [null, [], { max_context_window_tokens: -1 }, { max_context_window_tokens: "1000" }, { max_context_window_tokens: Infinity }]) {
    assert.equal(catalog(row("a", { capabilities: { type: "chat", supports: { tool_calls: true }, limits } })).models.length, 0);
  }
  assert.equal(catalog(row("a", { capabilities: null })).models.length, 0);
});
test("empty catalogs are valid, malformed envelopes are not", () => {
  assert.deepEqual(catalog().models, []);
  for (const raw of [null, [], {}, { data: {} }]) assert.throws(() => buildCatalog(raw, [known], url), /invalid model catalog/);
});
test("sanitizes remote names and IDs for terminal output", () => {
  const result = catalog(null, { id: "\x1b[31munsafe" }, row("safe", { name: "bad\x1b[0m" }));
  assert.equal(result.invalid, 2);
  assert.equal(result.models[0]?.name, "safe");
});
test("respects explicit vision denial and clamps output to context", () => {
  const model = catalog(row(known.id, { capabilities: {
    type: "chat", supports: { vision: false },
    limits: { max_context_window_tokens: 1000, max_output_tokens: 2000 },
  } })).models[0]!;
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.maxTokens, 1000);
});
