import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createEnterpriseProvider } from "../src/provider.ts";
import { credential, row, store } from "./fixtures.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
function listModels(dir: string): string {
  return execFileSync(process.execPath, [cli,
    "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-mcp", "--no-context-files", "-e", join(root, "src/index.ts"), "--list-models", "github-copilot",
  ], {
    cwd: dir,
    env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
    encoding: "utf8", timeout: 30_000,
  });
}
test("real Pi CLI lists native OAuth models on first offline startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-enterprise-cli-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "github-copilot": { ...credential, availableModelIds: ["gpt-5.5"] } }));
    assert.match(listModels(dir), /gpt-5\.5/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("real Pi CLI restores a discovered model missing from its native catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-enterprise-cli-cache-"));
  try {
    const credentials = store();
    const cache = new InMemoryModelsStore();
    const models = createModels({ credentials, modelsStore: cache });
    const native = builtinProviders().find((p) => p.id === "github-copilot")!;
    models.setProvider(createEnterpriseProvider(native, async () => Response.json({ data: [row("tenant-fixture-model")] })).provider);
    await models.refresh();
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "github-copilot": credential }));
    await writeFile(join(dir, "models-store.json"), JSON.stringify({ "github-copilot": await cache.read("github-copilot") }));
    assert.match(listModels(dir), /tenant-fixture-model/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
