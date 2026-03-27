const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTokenStore } = require("../lib/token-store");

test("token store migrates legacy single-token data into an ordered provider registry", () => {
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

test("token store persists multiple providers and fallback order", () => {
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