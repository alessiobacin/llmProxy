const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTokenStore } = require("../lib/token-store");

test("token store migrates legacy single-token data into an ordered provider registry", { concurrency: false }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-token-legacy-"));
  const tokenFile = path.join(tempRoot, "copilot-token.json");

  fs.writeFileSync(tokenFile, JSON.stringify({
    access_token: "legacy-token",
    token_type: "bearer",
    scope: "read:user",
    created_at: 123,
  }, null, 2));

  const store = createTokenStore({ filePath: tokenFile });
  const providers = store.listProviders();

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "default");
  assert.equal(providers[0].access_token, "legacy-token");
  assert.equal(store.getAccessToken(), "legacy-token");
});

test("token store persists multiple providers and fallback order", { concurrency: false }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-token-multi-"));
  const tokenFile = path.join(tempRoot, "copilot-token.json");
  const store = createTokenStore({ filePath: tokenFile });

  store.saveProvider("primary", {
    access_token: "token-primary",
    token_type: "bearer",
    scope: "read:user",
  }, { name: "Primary Copilot" });
  store.saveProvider("backup", {
    access_token: "token-backup",
    token_type: "bearer",
    scope: "read:user",
  }, { name: "Backup Copilot" });
  store.setProviderOrder(["backup", "primary"]);

  const reloaded = createTokenStore({ filePath: tokenFile });
  const providers = reloaded.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), ["backup", "primary"]);
  assert.equal(reloaded.getAccessToken(), "token-backup");
  assert.equal(reloaded.getProvider("primary").name, "Primary Copilot");
});

test("token store persists free_model flags for provider/model instances", { concurrency: false }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-token-free-model-"));
  const tokenFile = path.join(tempRoot, "copilot-token.json");
  const store = createTokenStore({ filePath: tokenFile });

  store.saveProvider("opencode", {
    access_token: "token-opencode",
    token_type: "api_key",
    scope: "api_key",
    provider: "opencode",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
    free_model: true,
  }, { name: "OpenCode" });

  const reloaded = createTokenStore({ filePath: tokenFile });
  assert.equal(reloaded.getProvider("opencode").free_model, true);
});

test("token store keeps provider order stable when updating an existing provider", { concurrency: false }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-token-update-order-"));
  const tokenFile = path.join(tempRoot, "copilot-token.json");
  const store = createTokenStore({ filePath: tokenFile });

  store.saveProvider("qwen", {
    access_token: "token-qwen",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "Qwen" });
  store.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  store.setProviderOrder(["qwen", "deepseek"]);

  store.saveProvider("qwen", {
    access_token: "token-qwen-updated",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "Qwen" });

  assert.deepEqual(store.listProviders().map((provider) => provider.id), ["qwen", "deepseek"]);
  assert.equal(store.getProvider("qwen").access_token, "token-qwen-updated");
});

test("token store loads legacy api-key providers saved without access_token", { concurrency: false }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-token-legacy-apikey-"));
  const tokenFile = path.join(tempRoot, "copilot-token.json");

  fs.writeFileSync(tokenFile, JSON.stringify({
    version: 2,
    providers: [
      {
        id: "nvidia",
        name: "NVIDIA",
        provider: "nvidia",
        auth_type: "api_key",
        api_key: "nvapi-legacy",
        default_model: "z-ai/glm-5.2",
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        provider: "openrouter",
        auth_type: "api_key",
        credentials: { api_key: "sk-or-legacy" },
        default_model: "openai/gpt-4o",
      },
    ],
    order: ["nvidia", "openrouter"],
  }, null, 2));

  const store = createTokenStore({ filePath: tokenFile });
  const providers = store.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), ["nvidia", "openrouter"]);
  assert.equal(store.getProvider("nvidia").access_token, "nvapi-legacy");
  assert.equal(store.getProvider("openrouter").access_token, "sk-or-legacy");
});
