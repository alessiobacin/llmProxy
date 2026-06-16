const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createProviderRegistry } = require("../lib/provider-registry");

function tempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reg-"));
  return path.join(dir, "registry.json");
}

test("upsert + list returns public view without raw credentials", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s3cret" });
  registry.upsert({
    provider: "openrouter",
    scope_type: "project",
    scope_id: "proj-1",
    default_model: "anthropic/claude-3.5",
    credentials: { api_key: "sk-test" },
  });
  const list = registry.list({});
  assert.equal(list.length, 1);
  assert.equal(list[0].provider, "openrouter");
  assert.equal(list[0].has_credentials, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(list[0], "credentials"));
});

test("upsert validates provider and scope", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  assert.throws(() => registry.upsert({ provider: "bad", scope_type: "project", scope_id: "p" }));
  assert.throws(() => registry.upsert({ provider: "copilot", scope_type: "bad", scope_id: "p" }));
  assert.throws(() => registry.upsert({ provider: "copilot", scope_type: "project", scope_id: "" }));
});

test("upsert accepts newly supported providers like kimi, qwen, and opencode", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  const kimiEntry = registry.upsert({
    provider: "kimi",
    scope_type: "project",
    scope_id: "p-1",
    credentials: { api_key: "kimi-key" },
  });
  const qwenEntry = registry.upsert({
    provider: "qwen",
    scope_type: "project",
    scope_id: "p-2",
    credentials: { api_key: "qwen-key" },
  });
  const opencodeEntry = registry.upsert({
    provider: "opencode-go",
    scope_type: "project",
    scope_id: "p-3",
    credentials: { api_key: "opencode-key" },
  });
  assert.equal(kimiEntry.provider, "kimi");
  assert.equal(qwenEntry.provider, "qwen");
  assert.equal(opencodeEntry.provider, "opencode-go");
});

test("resolve picks most specific scope (project > client > agency)", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  registry.upsert({ provider: "copilot", scope_type: "agency", scope_id: "a-1", credentials: { api_key: "agency-key" } });
  registry.upsert({ provider: "copilot", scope_type: "client", scope_id: "c-1", credentials: { api_key: "client-key" } });
  registry.upsert({ provider: "copilot", scope_type: "project", scope_id: "p-1", credentials: { api_key: "project-key" } });

  const winner = registry.resolve({ agency_id: "a-1", client_id: "c-1", project_id: "p-1", scope_type: "project", scope_id: "p-1" });
  assert.equal(winner.provider, "copilot");
  assert.equal(winner.scope_type, "project");
  assert.equal(winner.credentials.api_key, "project-key");
});

test("resolve respects requested provider filter", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  registry.upsert({ provider: "copilot", scope_type: "project", scope_id: "p-1", credentials: { api_key: "c" } });
  registry.upsert({ provider: "openrouter", scope_type: "project", scope_id: "p-1", credentials: { api_key: "o" } });

  const auto = registry.resolve({ project_id: "p-1", scope_type: "project", scope_id: "p-1" });
  assert.ok(auto);
  const openrouter = registry.resolve({ project_id: "p-1", scope_type: "project", scope_id: "p-1" }, "openrouter");
  assert.equal(openrouter.provider, "openrouter");
  assert.equal(openrouter.credentials.api_key, "o");
});

test("resolveCandidates deduplicates inherited providers and keeps fallback order", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  registry.upsert({ provider: "openrouter", scope_type: "master", scope_id: "*", priority: 20, credentials: { access_token: "master-openrouter" } });
  registry.upsert({ provider: "deepseek", scope_type: "master", scope_id: "*", priority: 30, credentials: { access_token: "master-deepseek" } });
  registry.upsert({ provider: "openrouter", scope_type: "user", scope_id: "aqdas", priority: 1, credentials: { access_token: "user-openrouter" } });
  registry.upsert({ provider: "qwen", scope_type: "user", scope_id: "aqdas", priority: 2, credentials: { access_token: "user-qwen" } });

  const candidates = registry.resolveCandidates({ user_id: "aqdas", scope_type: "user", scope_id: "aqdas" });
  assert.deepEqual(candidates.map((entry) => entry.provider), ["openrouter", "qwen", "deepseek"]);
  assert.equal(candidates[0].credentials.access_token, "user-openrouter");
});

test("resolve returns null when no match for requested provider", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  registry.upsert({ provider: "copilot", scope_type: "project", scope_id: "p-1", credentials: { api_key: "c" } });
  const result = registry.resolve({ project_id: "p-1", scope_type: "project", scope_id: "p-1" }, "openrouter");
  assert.equal(result, null);
});

test("credentials are encrypted at-rest with AES-256-GCM", () => {
  const filePath = tempPath();
  const registry = createProviderRegistry({ filePath, secret: "rotation-secret" });
  registry.upsert({
    provider: "openrouter",
    scope_type: "project",
    scope_id: "p-1",
    credentials: { api_key: "sk-plain" },
  });
  const raw = fs.readFileSync(filePath, "utf8");
  assert.ok(!raw.includes("sk-plain"), "plaintext key must not appear in store");
  assert.ok(raw.includes("enc.v1:"), "should use enc.v1 envelope");

  const resolved = registry.resolve({ project_id: "p-1", scope_type: "project", scope_id: "p-1" });
  assert.equal(resolved.credentials.api_key, "sk-plain");
});

test("remove deletes by composite id", () => {
  const registry = createProviderRegistry({ filePath: tempPath(), secret: "s" });
  registry.upsert({ provider: "copilot", scope_type: "project", scope_id: "p-1", credentials: { api_key: "c" } });
  const id = "project:p-1:copilot";
  assert.equal(registry.remove(id), true);
  assert.equal(registry.list({}).length, 0);
  assert.equal(registry.remove(id), false);
});

test("shared provider registry writes group-writable files", () => {
  const filePath = tempPath();
  const previous = process.env.LLMPROXY_SHARED_PROVIDER_REGISTRY;
  process.env.LLMPROXY_SHARED_PROVIDER_REGISTRY = "1";
  try {
    const registry = createProviderRegistry({ filePath, secret: "s" });
    registry.upsert({ provider: "copilot", scope_type: "user", scope_id: "aqdas", credentials: { api_key: "c" } });
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o660);
  } finally {
    if (previous === undefined) {
      delete process.env.LLMPROXY_SHARED_PROVIDER_REGISTRY;
    } else {
      process.env.LLMPROXY_SHARED_PROVIDER_REGISTRY = previous;
    }
  }
});
